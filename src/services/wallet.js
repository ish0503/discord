/**
 * 경제 시스템의 유일한 진입점.
 *
 * ┌ reserve()     베팅 즉시 money → escrow 로 이동 (잔고 조건부, 원자적)
 * ├ addStake()    더블·레이즈 등 추가 베팅 (잔고 조건부, 원자적)
 * ├ settleRound() escrow 항목 제거 + 지급액 입금 (항목이 있을 때만 → 멱등)
 * └ refund()      escrow 항목 제거 + 건 금액 반환 (취소·장애 복구, 멱등)
 *
 * 모든 변경이 User 문서 1개에 대한 단일 업데이트라서 MongoDB 트랜잭션 없이도 원자적이다.
 * 같은 roundId로 정산이 두 번 들어와도 두 번째는 조건(escrow.roundId 존재)에 걸려 아무것도 하지 않는다.
 * 서버가 여러 대여도 잔고 검사가 DB 조건에서 이뤄지므로 이중 사용이 불가능하다.
 */
const crypto = require('node:crypto');
const User = require('../db/User');
const GameLog = require('../db/GameLog');
const config = require('../config');

/** 이 봇 프로세스의 고유 ID (종료 시 자기 판만 환불하는 데 사용) */
const INSTANCE_ID = crypto.randomUUID();

function assertAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`잘못된 금액: ${amount}`);
}

/** 계정 조회 (없으면 기본 잔고로 생성) */
async function getAccount(userId, guildId) {
  return User.findOneAndUpdate({ userId }, { $set: { guildId } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
}

/**
 * 베팅 예약. 잔고가 부족하면 null.
 * @returns {{ roundId: string, balance: number } | null}
 */
async function reserve(userId, guildId, game, amount) {
  assertAmount(amount);
  const roundId = crypto.randomUUID();
  const doc = await User.findOneAndUpdate(
    { userId, money: { $gte: amount } },
    {
      $inc: { money: -amount },
      $push: { escrow: { roundId, game, amount, instance: INSTANCE_ID, createdAt: new Date() } },
      $set: { guildId },
    },
    { new: true, projection: { money: 1 } },
  ).lean();
  return doc ? { roundId, balance: doc.money } : null;
}

/** 진행 중인 판에 추가 베팅. 성공 시 새 잔고, 실패(잔고 부족·이미 정산됨) 시 null */
async function addStake(userId, roundId, amount) {
  assertAmount(amount);
  const doc = await User.findOneAndUpdate(
    { userId, money: { $gte: amount }, 'escrow.roundId': roundId },
    { $inc: { money: -amount, 'escrow.$.amount': amount } },
    { new: true, projection: { money: 1 } },
  ).lean();
  return doc ? doc.money : null;
}

function writeLog(entry) {
  GameLog.create(entry).catch((err) => {
    if (err.code !== 11000) console.error('[GameLog]', err.message); // 11000 = 이미 기록된 판
  });
}

/**
 * 판 종료 정산.
 * @param payout 돌려줄 총액 (원금 포함, 0 이상). 예) 1,000 걸고 2배 당첨 → 2,000 / 패배 → 0
 * @returns {{ ok: boolean, balance?, staked?, payout?, net? }}  ok=false면 이미 정산·환불된 판
 */
async function settleRound(userId, roundId, payout, { game, guildId, inc = {}, max = {}, set = {}, wagered = 0, detail } = {}) {
  const pay = Math.max(0, Math.floor(payout));
  const update = { $inc: { money: pay }, $pull: { escrow: { roundId } } };
  for (const [k, v] of Object.entries(inc)) update.$inc[`stats.${k}`] = v;
  if (wagered) update.$inc['stats.totalWagered'] = wagered;
  const maxEntries = Object.entries(max);
  if (maxEntries.length) update.$max = Object.fromEntries(maxEntries.map(([k, v]) => [`stats.${k}`, v]));
  if (Object.keys(set).length) update.$set = set;

  const before = await User.findOneAndUpdate({ userId, 'escrow.roundId': roundId }, update, {
    new: false,
    projection: { money: 1, escrow: 1 },
  }).lean();
  if (!before) return { ok: false };

  const staked = before.escrow.find((e) => e.roundId === roundId)?.amount ?? 0;
  const result = { ok: true, balance: before.money + pay, staked, payout: pay, net: pay - staked };
  writeLog({ roundId, userId, guildId, game, status: 'settled', staked, payout: pay, net: result.net, detail });
  return result;
}

/** 베팅 취소·장애 복구용 전액 환불 (멱등) */
async function refund(userId, roundId, reason = 'refund') {
  for (let attempt = 0; attempt < 3; attempt++) {
    const doc = await User.findOne({ userId, 'escrow.roundId': roundId }, { guildId: 1, escrow: { $elemMatch: { roundId } } }).lean();
    const entry = doc?.escrow?.[0];
    if (!entry) return { ok: false };
    // amount까지 조건에 넣어, 읽은 뒤 addStake가 끼어들면 재시도
    const res = await User.updateOne(
      { userId, escrow: { $elemMatch: { roundId, amount: entry.amount } } },
      { $inc: { money: entry.amount }, $pull: { escrow: { roundId } } },
    );
    if (res.modifiedCount === 1) {
      writeLog({ roundId, userId, guildId: doc.guildId, game: entry.game, status: 'refunded', staked: entry.amount, payout: entry.amount, net: 0, detail: { reason } });
      return { ok: true, amount: entry.amount };
    }
  }
  return { ok: false };
}

async function refundWhere(match, reason) {
  const users = await User.find({ escrow: { $elemMatch: match } }, { userId: 1, escrow: 1 }).lean();
  let count = 0;
  for (const u of users) {
    for (const e of u.escrow) {
      const hit = Object.entries(match).every(([k, cond]) => (cond?.$lt ? e[k] < cond.$lt : e[k] === cond));
      if (hit && (await refund(u.userId, e.roundId, reason)).ok) count++;
    }
  }
  return count;
}

/** 오래 정산되지 않은 판 환불 (다른 인스턴스가 죽은 경우 포함) */
async function refundStale(ttlMs = config.ECONOMY.ESCROW_TTL_MS) {
  return refundWhere({ createdAt: { $lt: new Date(Date.now() - ttlMs) } }, 'stale');
}

/** 이 프로세스가 연 판 전부 환불 (정상 종료 시) */
async function refundOwn() {
  return refundWhere({ instance: INSTANCE_ID }, 'shutdown');
}

/** 파산 지원금 (조건 검사와 지급을 하나의 원자 연산으로) */
async function claimBailout(userId, guildId) {
  const { AMOUNT, THRESHOLD, COOLDOWN_MS } = config.BAILOUT;
  const now = new Date();
  return User.findOneAndUpdate(
    {
      userId,
      money: { $lt: THRESHOLD },
      $or: [{ lastBailoutAt: null }, { lastBailoutAt: { $lte: new Date(now - COOLDOWN_MS) } }],
    },
    { $inc: { money: AMOUNT }, $set: { lastBailoutAt: now, guildId } },
    { new: true },
  ).lean();
}

module.exports = { INSTANCE_ID, getAccount, reserve, addStake, settleRound, refund, refundStale, refundOwn, claimBailout };
