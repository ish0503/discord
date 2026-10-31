/**
 * 경제 시스템의 유일한 진입점.
 *
 * ┌ reserve()       베팅 즉시 money → escrow (잔고 조건부, 원자적)
 * ├ addStake()      더블·스플릿·보험 등 추가 베팅 (잔고 조건부, 원자적)
 * ├ commitResult()  결과 확정 직후 지급액을 escrow에 선기록 (write-ahead)
 * ├ settle()        escrow 제거 + 지급 (roundId가 있을 때만 → 멱등)
 * ├ refund()        escrow 제거 + 원금 반환 (멱등)
 * └ recover*()      장애 복구: 결과가 선기록된 판은 그대로 정산, 아닌 판은 환불
 *
 * 모든 잔고 변경은 지갑 문서 1개에 대한 단일 업데이트 → 트랜잭션 없이 원자적.
 * 게임 외 발행·회수(출석·지원금·관리자·상점)는 Ledger에 기록한다.
 */
const crypto = require('node:crypto');
const User = require('../db/User');
const GameLog = require('../db/GameLog');
const Ledger = require('../db/Ledger');
const config = require('../config');
const bus = require('./bus');

const INSTANCE_ID = crypto.randomUUID();

/** 지갑 단위 키: 서버별 경제면 서버 ID, 전역 경제면 'global' */
const economyKey = (guildId) => (config.ECONOMY.SCOPE === 'global' ? 'global' : guildId);

function assertAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`잘못된 금액: ${amount}`);
}

async function getAccount(userId, guildId) {
  return User.findOneAndUpdate(
    { userId, guildId: economyKey(guildId) },
    { $setOnInsert: { userId, guildId: economyKey(guildId) } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
}

async function reserve(userId, guildId, game, amount, { gameId } = {}) {
  assertAmount(amount);
  const roundId = crypto.randomUUID();
  const doc = await User.findOneAndUpdate(
    { userId, guildId: economyKey(guildId), money: { $gte: amount } },
    {
      $inc: { money: -amount },
      $push: {
        escrow: { roundId, game, amount, instance: INSTANCE_ID, discordGuildId: guildId, gameId, createdAt: new Date() },
      },
    },
    { new: true, projection: { money: 1 } },
  ).lean();
  return doc ? { roundId, balance: doc.money } : null;
}

async function addStake(userId, guildId, roundId, amount) {
  assertAmount(amount);
  const doc = await User.findOneAndUpdate(
    { userId, guildId: economyKey(guildId), money: { $gte: amount }, 'escrow.roundId': roundId },
    { $inc: { money: -amount, 'escrow.$.amount': amount } },
    { new: true, projection: { money: 1 } },
  ).lean();
  return doc ? doc.money : null;
}

/** 결과 선기록: 이후 서버가 죽어도 복구 시 이 지급액으로 정산된다 */
async function commitResult(userId, guildId, roundId, payout, meta = null) {
  const res = await User.updateOne(
    { userId, guildId: economyKey(guildId), 'escrow.roundId': roundId },
    { $set: { 'escrow.$.pendingPayout': Math.max(0, Math.floor(payout)), 'escrow.$.pendingMeta': meta } },
  );
  return res.modifiedCount === 1 || res.matchedCount === 1;
}

function writeLog(entry) {
  return GameLog.create(entry).catch((err) => {
    if (err.code !== 11000) console.error('[GameLog]', err.message);
  });
}

/**
 * 판 정산.
 * @param o.payout 돌려줄 총액(원금 포함, ≥0)
 * @param o.wagered 이 판 총 베팅액 (통계용, 생략 시 escrow 금액 사용 불가 → 0)
 */
async function settle({ userId, guildId, roundId, payout, game, inc = {}, max = {}, set = {}, wagered = 0, detail, recovered = false, channelId = null }) {
  const key = economyKey(guildId);
  const pay = Math.max(0, Math.floor(payout));
  const update = { $inc: { money: pay }, $pull: { escrow: { roundId } } };
  for (const [k, v] of Object.entries(inc)) update.$inc[`stats.${k}`] = v;
  if (wagered) update.$inc['stats.totalWagered'] = wagered;
  const maxes = { ...max };
  if (wagered && pay - wagered > 0) maxes.biggestWin = pay - wagered;
  if (Object.keys(maxes).length) update.$max = Object.fromEntries(Object.entries(maxes).map(([k, v]) => [`stats.${k}`, v]));
  if (Object.keys(set).length) update.$set = set;

  const before = await User.findOneAndUpdate({ userId, guildId: key, 'escrow.roundId': roundId }, update, {
    new: false,
    projection: { money: 1, escrow: 1 },
  }).lean();
  if (!before) return { ok: false };

  const entry = before.escrow.find((e) => e.roundId === roundId);
  const staked = entry?.amount ?? 0;
  const result = { ok: true, balance: before.money + pay, staked, payout: pay, net: pay - staked };
  const discordGuildId = entry?.discordGuildId ?? guildId;
  const gameName = game ?? entry?.game;
  await writeLog({ roundId, userId, guildId: discordGuildId, economyKey: key, game: gameName, status: 'settled', staked, payout: pay, net: result.net, recovered, detail });
  bus.emit('round:settled', { userId, guildId: discordGuildId, economyKey: key, game: gameName, staked, payout: pay, net: result.net, detail, recovered, channelId });
  return result;
}

async function refund({ userId, guildId, roundId, reason = 'refund' }) {
  const key = economyKey(guildId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const doc = await User.findOne({ userId, guildId: key, 'escrow.roundId': roundId }, { escrow: { $elemMatch: { roundId } } }).lean();
    const entry = doc?.escrow?.[0];
    if (!entry) return { ok: false };
    const res = await User.updateOne(
      { userId, guildId: key, escrow: { $elemMatch: { roundId, amount: entry.amount } } },
      { $inc: { money: entry.amount }, $pull: { escrow: { roundId } } },
    );
    if (res.modifiedCount === 1) {
      await writeLog({ roundId, userId, guildId: entry.discordGuildId, economyKey: key, game: entry.game, status: 'refunded', staked: entry.amount, payout: entry.amount, net: 0, detail: { reason } });
      return { ok: true, amount: entry.amount };
    }
  }
  return { ok: false };
}

/** 조건에 맞는 escrow 항목 복구: 선기록된 결과가 있으면 정산, 없으면 환불 */
async function recoverWhere(predicate, query, reason) {
  const users = await User.find(query, { userId: 1, guildId: 1, escrow: 1 }).lean();
  const out = { settled: 0, refunded: 0, failed: 0, gameIds: new Set() };
  for (const u of users) {
    for (const e of u.escrow) {
      if (!predicate(e)) continue;
      try {
        let ok;
        if (e.pendingPayout !== null && e.pendingPayout !== undefined) {
          ok = (await settle({ userId: u.userId, guildId: e.discordGuildId ?? u.guildId, roundId: e.roundId, payout: e.pendingPayout, game: e.game, wagered: e.amount, detail: { ...(e.pendingMeta || {}), recoveredBy: reason }, recovered: true })).ok;
          if (ok) out.settled++;
        } else {
          ok = (await refund({ userId: u.userId, guildId: e.discordGuildId ?? u.guildId, roundId: e.roundId, reason })).ok;
          if (ok) out.refunded++;
        }
        if (e.gameId) out.gameIds.add(e.gameId);
      } catch (err) {
        out.failed++;
        console.error('[recover]', err.message);
      }
    }
  }
  return out;
}

/** 일정 시간 지난 미정산 판 (다른 프로세스가 비정상 종료한 경우 포함) */
function recoverStale(ttlMs = config.ECONOMY.ESCROW_TTL_MS) {
  const now = Date.now();
  const ttlOf = (game) => (ttlMs === config.ECONOMY.ESCROW_TTL_MS ? config.ECONOMY.ESCROW_TTL_BY_GAME[game] ?? ttlMs : ttlMs);
  const cutoff = new Date(now - ttlMs);
  return recoverWhere((e) => e.createdAt < new Date(now - ttlOf(e.game)), { 'escrow.createdAt': { $lt: cutoff } }, 'stale');
}

/** 이 프로세스가 연 판 (정상 종료 시) */
function recoverOwn() {
  return recoverWhere((e) => e.instance === INSTANCE_ID, { 'escrow.instance': INSTANCE_ID }, 'shutdown');
}

/** 이전 프로세스가 남긴 판 (부팅 시, 단일 인스턴스 전제) */
function recoverPrevious() {
  return recoverWhere((e) => e.instance !== INSTANCE_ID, { 'escrow.0': { $exists: true } }, 'restart');
}

/** 특정 게임(GameState)의 판만 복구 — 관리자 재시도용 */
function recoverGame(gameId) {
  return recoverWhere((e) => e.gameId === gameId, { 'escrow.gameId': gameId }, 'admin-retry');
}

// ───────────────────────── 게임 외 칩 이동 (Ledger 기록) ─────────────────────────

function ledger(entry) {
  return Ledger.create(entry).catch((err) => console.error('[Ledger]', err.message));
}

/** 발행: 관리자 지급·시즌 보상 등 */
async function grant({ userId, guildId, amount, type, reason, actorId }) {
  assertAmount(amount);
  await getAccount(userId, guildId);
  const doc = await User.findOneAndUpdate({ userId, guildId: economyKey(guildId) }, { $inc: { money: amount } }, { new: true }).lean();
  await ledger({ economyKey: economyKey(guildId), guildId, userId, type, amount, reason, actorId });
  return doc;
}

/** 회수·소비: 잔고가 충분할 때만 (부족하면 null) */
async function debit({ userId, guildId, amount, type, reason, actorId }) {
  assertAmount(amount);
  const doc = await User.findOneAndUpdate({ userId, guildId: economyKey(guildId), money: { $gte: amount } }, { $inc: { money: -amount } }, { new: true }).lean();
  if (doc) await ledger({ economyKey: economyKey(guildId), guildId, userId, type, amount: -amount, reason, actorId });
  return doc;
}

/**
 * 유저 간 송금. 보낸 사람에게서 (금액 + 수수료)를 회수하고 받는 사람에게 금액을 발행한다.
 * 수수료는 경제에서 소각 (부계정으로 칩을 몰아주는 행위 억제). 받는 쪽 발행이 실패하면 보낸 사람에게 되돌림.
 * @returns { ok, fee, from, to } | { ok:false, reason }
 */
async function transfer({ fromId, toId, guildId, amount, fee = 0, memo = '' }) {
  assertAmount(amount);
  const total = amount + fee;
  await getAccount(fromId, guildId);
  await getAccount(toId, guildId);
  const from = await debit({ userId: fromId, guildId, amount: total, type: 'transfer_out', reason: `→ ${toId}${memo ? ` · ${memo}` : ''}`, actorId: fromId });
  if (!from) return { ok: false, reason: 'balance' };
  try {
    const to = await grant({ userId: toId, guildId, amount, type: 'transfer_in', reason: `← ${fromId}${memo ? ` · ${memo}` : ''}`, actorId: fromId });
    return { ok: true, fee, from, to };
  } catch (err) {
    await grant({ userId: fromId, guildId, amount: total, type: 'transfer_refund', reason: `송금 실패 환불: ${err.message}`, actorId: fromId }).catch(console.error);
    return { ok: false, reason: 'error' };
  }
}

/** 오늘(서비스 시간대 기준) 보낸 송금 총액 (수수료 포함) */
async function transferredToday(userId, guildId, dayKeyOf, today) {
  const since = new Date(Date.now() - 36 * 3600_000);
  const rows = await Ledger.find({ economyKey: economyKey(guildId), userId, type: 'transfer_out', createdAt: { $gte: since } }).lean();
  return rows.filter((r) => dayKeyOf(new Date(r.createdAt)) === today).reduce((sum, r) => sum - r.amount, 0);
}

async function claimBailout(userId, guildId) {
  const { AMOUNT, THRESHOLD, COOLDOWN_MS } = config.BAILOUT;
  const now = new Date();
  await getAccount(userId, guildId);
  const doc = await User.findOneAndUpdate(
    {
      userId,
      guildId: economyKey(guildId),
      money: { $lt: THRESHOLD },
      $or: [{ lastBailoutAt: null }, { lastBailoutAt: { $lte: new Date(now - COOLDOWN_MS) } }],
    },
    { $inc: { money: AMOUNT }, $set: { lastBailoutAt: now } },
    { new: true },
  ).lean();
  if (doc) await ledger({ economyKey: economyKey(guildId), guildId, userId, type: 'bailout', amount: AMOUNT });
  return doc;
}

/**
 * 출석 보상 (낙관적 동시성: 읽은 lastDailyKey 그대로일 때만 갱신 → 하루 1회 보장)
 * @returns { ok, amount, streak, balance } | { ok:false, already:true }
 */
async function claimDaily(userId, guildId, todayKey, yesterdayKey) {
  const acc = await getAccount(userId, guildId);
  if (acc.lastDailyKey === todayKey) return { ok: false, already: true };
  const streak = acc.lastDailyKey === yesterdayKey ? (acc.dailyStreak || 0) + 1 : 1;
  const { CHIPS, STREAK_BONUS, MAX_STREAK_BONUS } = config.DAILY;
  const amount = CHIPS + Math.min((streak - 1) * STREAK_BONUS, MAX_STREAK_BONUS);
  const doc = await User.findOneAndUpdate(
    { userId, guildId: economyKey(guildId), lastDailyKey: acc.lastDailyKey ?? null },
    { $inc: { money: amount }, $set: { lastDailyKey: todayKey, dailyStreak: streak } },
    { new: true },
  ).lean();
  if (!doc) return { ok: false, already: true };
  await ledger({ economyKey: economyKey(guildId), guildId, userId, type: 'daily', amount });
  return { ok: true, amount, streak, balance: doc.money };
}

module.exports = {
  INSTANCE_ID,
  economyKey,
  getAccount,
  reserve,
  addStake,
  commitResult,
  settle,
  refund,
  recoverStale,
  recoverOwn,
  recoverPrevious,
  recoverGame,
  grant,
  debit,
  transfer,
  transferredToday,
  claimBailout,
  claimDaily,
};
