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
 * 정산·환불은 칩 변경과 "같은 원자적 업데이트"로 Outbox 이벤트(User.outbox)를 남긴다 → services/outbox.js
 * 정산 전에 지급액을 규칙(content/settlementRules)으로 검증하고, 실패하면 지갑을 바꾸지 않고 판을 차단(blocked)한다.
 *
 * 모든 잔고 변경은 지갑 문서 1개에 대한 단일 업데이트 → 트랜잭션 없이 원자적.
 * 게임 외 발행·회수(출석·지원금·관리자·상점)는 Ledger에 기록한다.
 */
const crypto = require('node:crypto');
const User = require('../db/User');
const GameLog = require('../db/GameLog');
const Ledger = require('../db/Ledger');
const AuditLog = require('../db/AuditLog');
const Transfer = require('../db/Transfer');
const TransferQuota = require('../db/TransferQuota');
const config = require('../config');
const bus = require('./bus');
const outbox = require('./outbox');
const rules = require('../content/settlementRules');

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

async function escrowEntry(userId, key, roundId) {
  const doc = await User.findOne({ userId, guildId: key, 'escrow.roundId': roundId }, { escrow: { $elemMatch: { roundId } } }).lean();
  return doc?.escrow?.find((e) => e.roundId === roundId) ?? null;
}

/** 검증 실패한 판 차단: 지갑은 그대로 두고 자동 복구에서 제외, 감사 로그·알림 */
async function blockRound({ userId, key, entry, payout, reason, game }) {
  await User.updateOne({ userId, guildId: key, 'escrow.roundId': entry.roundId }, { $set: { 'escrow.$.blocked': { reason, payout, at: new Date() } } }).catch(console.error);
  await AuditLog.create({
    guildId: entry.discordGuildId ?? key,
    actorId: 'system',
    action: 'settlement.rejected',
    targetId: userId,
    amount: Math.floor(Number(payout) || 0),
    reason,
    after: { roundId: entry.roundId, game: game ?? entry.game, gameId: entry.gameId, staked: entry.amount },
  }).catch((err) => console.error('[audit]', err.message));
  bus.emit('alert', { level: 'error', title: '정산 검증 실패 — 지갑 변경 중단', message: `${userId} ${entry.roundId}: ${reason}` });
}

/** 결과 선기록: 이후 서버가 죽어도 복구 시 이 지급액으로 정산된다. 규칙상 불가능한 지급액이면 기록하지 않고 차단 */
async function commitResult(userId, guildId, roundId, payout, meta = null, { maxPayout = null } = {}) {
  const key = economyKey(guildId);
  const entry = await escrowEntry(userId, key, roundId);
  if (!entry) return false;
  const v = rules.validatePayout({ game: meta?.game ?? entry.game, staked: entry.amount, payout, detail: meta, maxPayout });
  if (!v.ok) {
    await blockRound({ userId, key, entry, payout, reason: v.reason, game: meta?.game });
    return false;
  }
  const res = await User.updateOne(
    { userId, guildId: key, 'escrow.roundId': roundId },
    { $set: { 'escrow.$.pendingPayout': Math.max(0, Math.floor(payout)), 'escrow.$.pendingMeta': maxPayout ? { ...(meta || {}), maxPayout } : meta } },
  );
  return res.modifiedCount === 1 || res.matchedCount === 1;
}

function writeLog(entry) {
  return GameLog.create(entry).catch((err) => {
    if (err.code !== 11000) console.error('[GameLog]', err.message);
  });
}

/**
 * 판 정산 (멱등: 같은 roundId는 한 번만).
 * @param o.payout 돌려줄 총액(원금 포함, ≥0)
 * @param o.wagered 이 판 총 베팅액 (통계용)
 * @param o.maxPayout 게임 규칙으로 계산한 지급 상한 (선택 — 없으면 게임별 기본 배수)
 * @returns { ok, balance, staked, payout, net, eventId } | { ok:false } (이미 처리) | { ok:false, rejected, reason } (검증 실패)
 */
async function settle({ userId, guildId, roundId, payout, game, inc = {}, max = {}, set = {}, wagered = 0, detail, recovered = false, channelId = null, maxPayout = null }) {
  const key = economyKey(guildId);
  const pay = Math.max(0, Math.floor(payout));
  for (let attempt = 0; attempt < 3; attempt++) {
    const entry = await escrowEntry(userId, key, roundId);
    if (!entry) return { ok: false }; // 이미 정산·환불된 판
    if (entry.blocked) return { ok: false, rejected: true, reason: entry.blocked.reason ?? '차단된 판' };
    const gameName = game ?? entry.game;
    const cap = maxPayout ?? entry.pendingMeta?.maxPayout ?? null;
    const v = rules.validatePayout({ game: gameName, staked: entry.amount, payout, detail, maxPayout: cap });
    if (!v.ok) {
      await blockRound({ userId, key, entry, payout, reason: v.reason, game: gameName });
      return { ok: false, rejected: true, reason: v.reason };
    }

    const staked = entry.amount;
    const discordGuildId = entry.discordGuildId ?? guildId;
    const net = pay - staked;
    const eventId = `settle:${roundId}`;
    const at = new Date();
    const payload = { roundId, userId, guildId: discordGuildId, economyKey: key, game: gameName, status: 'settled', staked, payout: pay, net, detail: detail ?? null, recovered, channelId, gameId: entry.gameId ?? null, at };
    const update = {
      $inc: { money: pay },
      $pull: { escrow: { roundId } },
      $push: { outbox: { eventId, type: 'round.settled', guildId: discordGuildId, economyKey: key, userId, aggregateId: roundId, gameId: entry.gameId ?? null, payload, createdAt: at } },
    };
    for (const [k, v2] of Object.entries(inc)) update.$inc[`stats.${k}`] = v2;
    if (wagered) update.$inc['stats.totalWagered'] = wagered;
    const maxes = { ...max };
    if (wagered && pay - wagered > 0) maxes.biggestWin = pay - wagered;
    if (Object.keys(maxes).length) update.$max = Object.fromEntries(Object.entries(maxes).map(([k, v2]) => [`stats.${k}`, v2]));
    if (Object.keys(set).length) update.$set = set;

    // 검증한 에스크로 금액 그대로일 때만 적용 (그 사이 추가 베팅이 들어왔으면 다시 검증)
    const before = await User.findOneAndUpdate({ userId, guildId: key, escrow: { $elemMatch: { roundId, amount: staked, blocked: null } } }, update, {
      new: false,
      projection: { money: 1 },
    }).lean();
    if (!before) continue;

    const result = { ok: true, balance: before.money + pay, staked, payout: pay, net, eventId };
    await writeLog({ roundId, userId, guildId: discordGuildId, economyKey: key, game: gameName, status: 'settled', staked, payout: pay, net, recovered, detail, createdAt: at });
    bus.emit('round:settled', payload);
    outbox.kick(userId, key, eventId); // 전적·미션·업적 등은 Outbox 처리기가 (호출자를 막지 않음)
    return result;
  }
  return { ok: false };
}

async function refund({ userId, guildId, roundId, reason = 'refund' }) {
  const key = economyKey(guildId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const doc = await User.findOne({ userId, guildId: key, 'escrow.roundId': roundId }, { escrow: { $elemMatch: { roundId } } }).lean();
    const entry = doc?.escrow?.[0];
    if (!entry) return { ok: false };
    const eventId = `refund:${roundId}`;
    const at = new Date();
    const payload = { roundId, userId, guildId: entry.discordGuildId ?? guildId, economyKey: key, game: entry.game, status: 'refunded', staked: entry.amount, payout: entry.amount, net: 0, detail: { reason }, gameId: entry.gameId ?? null, at };
    const res = await User.updateOne(
      { userId, guildId: key, escrow: { $elemMatch: { roundId, amount: entry.amount } } },
      {
        $inc: { money: entry.amount },
        $pull: { escrow: { roundId } },
        $push: { outbox: { eventId, type: 'round.refunded', guildId: payload.guildId, economyKey: key, userId, aggregateId: roundId, gameId: payload.gameId, payload, createdAt: at } },
      },
    );
    if (res.modifiedCount === 1) {
      await writeLog({ roundId, userId, guildId: payload.guildId, economyKey: key, game: entry.game, status: 'refunded', staked: entry.amount, payout: entry.amount, net: 0, detail: { reason }, createdAt: at });
      outbox.kick(userId, key, eventId);
      return { ok: true, amount: entry.amount };
    }
  }
  return { ok: false };
}

/** 조건에 맞는 escrow 항목 복구: 선기록된 결과가 있으면 정산, 없으면 환불 */
/**
 * 복구 정산도 일반 정산과 같은 경로(settle → Outbox)를 쓴다 → 전적·미션·업적이 그대로 반영된다.
 * 검증 실패로 차단된(blocked) 판은 임의로 정산하지 않고 남겨 둔다 (관리자 재시도 시에만 원금 환불).
 */
async function recoverWhere(predicate, query, reason, { refundBlocked = false } = {}) {
  const users = await User.find(query, { userId: 1, guildId: 1, escrow: 1 }).lean();
  const out = { settled: 0, refunded: 0, failed: 0, blocked: 0, gameIds: new Set() };
  const audit = (e, userId, action, amount) =>
    AuditLog.create({ guildId: e.discordGuildId ?? null, actorId: 'system', action, targetId: userId, amount, reason, after: { roundId: e.roundId, game: e.game, gameId: e.gameId ?? null, staked: e.amount } }).catch((err) =>
      console.error('[audit]', err.message),
    );
  for (const u of users) {
    for (const e of u.escrow) {
      if (!predicate(e)) continue;
      if (e.blocked && !refundBlocked) {
        out.blocked++;
        continue;
      }
      try {
        let ok;
        if (e.blocked) {
          ok = (await refund({ userId: u.userId, guildId: e.discordGuildId ?? u.guildId, roundId: e.roundId, reason: `${reason}:blocked` })).ok;
          if (ok) {
            out.refunded++;
            await audit(e, u.userId, 'recovery.blocked-refund', e.amount);
          }
        } else if (e.pendingPayout !== null && e.pendingPayout !== undefined) {
          const meta = e.pendingMeta || {};
          ok = (await settle({ userId: u.userId, guildId: e.discordGuildId ?? u.guildId, roundId: e.roundId, payout: e.pendingPayout, game: e.game, wagered: e.amount, detail: { ...meta, recoveredBy: reason }, recovered: true, maxPayout: meta.maxPayout ?? null })).ok;
          if (ok) {
            out.settled++;
            await audit(e, u.userId, 'recovery.settle', e.pendingPayout);
          }
        } else {
          ok = (await refund({ userId: u.userId, guildId: e.discordGuildId ?? u.guildId, roundId: e.roundId, reason })).ok;
          if (ok) {
            out.refunded++;
            await audit(e, u.userId, 'recovery.refund', e.amount);
          }
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
  return recoverWhere((e) => e.gameId === gameId, { 'escrow.gameId': gameId }, 'admin-retry', { refundBlocked: true });
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

/**
 * 멱등 발행: 같은 refId로는 한 번만 지급 (보스·예측 보상 등). 지갑의 txLog 표식과 함께 원자적으로 반영.
 * @returns 지급했으면 true, 이미 지급된 refId면 false
 */
async function grantOnce({ userId, guildId, amount, type, reason, refId }) {
  assertAmount(amount);
  if (!refId) throw new Error('grantOnce: refId 필요');
  await getAccount(userId, guildId);
  const key = economyKey(guildId);
  const mark = `grant:${refId}`;
  const res = await User.updateOne({ userId, guildId: key, txLog: { $ne: mark } }, { $inc: { money: amount }, $push: { txLog: { $each: [mark], $slice: TX_LOG_KEEP } } });
  await ledgerOnce({ economyKey: key, guildId, userId, type, amount, reason, actorId: 'system', refId: mark });
  return res.modifiedCount === 1;
}

/** 회수·소비: 잔고가 충분할 때만 (부족하면 null) */
async function debit({ userId, guildId, amount, type, reason, actorId }) {
  assertAmount(amount);
  const doc = await User.findOneAndUpdate({ userId, guildId: economyKey(guildId), money: { $gte: amount } }, { $inc: { money: -amount } }, { new: true }).lean();
  if (doc) await ledger({ economyKey: economyKey(guildId), guildId, userId, type, amount: -amount, reason, actorId });
  return doc;
}

// ───────────────────────── 송금 (멱등 · 한도 원자성) ─────────────────────────

const USER_ID_RE = /^\d{15,25}$/; // 디스코드 사용자 ID (snowflake)
const TX_LOG_KEEP = -200;

/**
 * 유저 간 송금.
 *   1) Transfer(transferId 고유) 생성 — 같은 요청이 다시 오면 기존 결과를 돌려줌 (중복 처리 없음)
 *   2) 한도 예약: TransferQuota.used ≤ 한도 − (금액+수수료) 일 때만 $inc  → 동시 요청 합계도 한도를 넘지 못함
 *   3) 보낸 사람 차감: 잔고 조건 + txLog에 out:<id>가 없을 때만 (차감과 표식을 한 번의 업데이트로)
 *   4) 받는 사람 지급: txLog에 in:<id>가 없을 때만
 *   5) 원장 기록 · 완료 표시
 * 잔고 부족 등으로 실패하면 예약한 한도를 되돌리고 양쪽 잔고는 변하지 않는다.
 * 중간에 프로세스가 죽으면 recoverTransfers()가 표식을 보고 이어서(또는 안전하게 취소) 처리한다.
 * 수수료는 소각된다 (부계정 몰아주기 억제).
 *
 * @returns { ok:true, fee, balance, duplicate? } | { ok:false, reason: 'invalid'|'self'|'limit'|'balance'|'error', message? }
 */
async function transfer({ transferId, fromId, toId, guildId, amount, fee = 0, limit, day, memo = '' }) {
  const bad = (message) => ({ ok: false, reason: 'invalid', message });
  if (typeof transferId !== 'string' || !transferId || transferId.length > 100) return bad('잘못된 거래 ID');
  if (!USER_ID_RE.test(String(fromId)) || !USER_ID_RE.test(String(toId))) return bad('잘못된 사용자 ID');
  if (fromId === toId) return { ok: false, reason: 'self' };
  if (!Number.isSafeInteger(amount) || amount <= 0) return bad(`잘못된 금액: ${amount}`);
  if (!Number.isSafeInteger(fee) || fee < 0) return bad(`잘못된 수수료: ${fee}`);
  if (!Number.isSafeInteger(limit) || limit <= 0 || amount + fee > limit) return { ok: false, reason: 'limit' };
  if (typeof day !== 'string' || !day) return bad('한도 집계일 누락');
  const key = economyKey(guildId);
  let t;
  try {
    t = (await Transfer.create({ transferId, economyKey: key, guildId, fromId, toId, amount, fee, day, memo, status: 'pending' })).toObject?.() ?? { transferId, economyKey: key, guildId, fromId, toId, amount, fee, day, memo, status: 'pending' };
  } catch (err) {
    if (err.code !== 11000) throw err;
    const prev = await Transfer.findOne({ transferId }).lean();
    if (!prev || prev.fromId !== fromId) return bad('거래 ID 충돌');
    if (prev.status === 'completed') return { ok: true, duplicate: true, fee: prev.fee };
    if (prev.status === 'failed') return { ok: false, duplicate: true, reason: prev.reason ?? 'error' };
    t = prev; // 처리 중이던 거래 → 이어서
  }
  return runTransfer(t, { limit, allowDebit: true });
}

async function quotaReserve(t, limit) {
  const total = t.amount + t.fee;
  const q = { economyKey: t.economyKey, userId: t.fromId, day: t.day };
  try {
    await TransferQuota.updateOne(q, { $setOnInsert: { used: 0, refs: [] } }, { upsert: true });
  } catch (err) {
    if (err.code !== 11000) throw err; // 동시 생성 경합 → 이미 있음
  }
  const res = await TransferQuota.updateOne({ ...q, used: { $lte: limit - total }, refs: { $ne: t.transferId } }, { $inc: { used: total }, $push: { refs: { $each: [t.transferId], $slice: -500 } } });
  if (res.modifiedCount === 1) return true;
  return (await TransferQuota.countDocuments({ ...q, refs: t.transferId })) === 1; // 이미 예약해 둔 거래
}

async function quotaRelease(t) {
  await TransferQuota.updateOne({ economyKey: t.economyKey, userId: t.fromId, day: t.day, refs: t.transferId }, { $inc: { used: -(t.amount + t.fee) }, $pull: { refs: t.transferId } });
}

async function hasMark(userId, key, mark) {
  return (await User.countDocuments({ userId, guildId: key, txLog: mark })) === 1;
}

async function failTransfer(t, reason) {
  // pending → failed 로 바꾼 쪽만 한도를 되돌림 (경합 시 한 번만)
  const res = await Transfer.updateOne({ transferId: t.transferId, status: 'pending' }, { $set: { status: 'failed', reason, completedAt: new Date() } });
  if (res.modifiedCount === 1) await quotaRelease(t);
  return { ok: false, reason };
}

async function runTransfer(t, { limit = config.TRANSFER.DAILY_LIMIT, allowDebit }) {
  const key = t.economyKey;
  const total = t.amount + t.fee;
  const outMark = `out:${t.transferId}`;
  const inMark = `in:${t.transferId}`;
  try {
    let debited = await hasMark(t.fromId, key, outMark);
    if (!debited) {
      if (!allowDebit) return failTransfer(t, 'interrupted');
      if (!(await quotaReserve(t, limit))) return failTransfer(t, 'limit');
      await getAccount(t.fromId, t.guildId);
      const res = await User.updateOne(
        { userId: t.fromId, guildId: key, money: { $gte: total }, txLog: { $ne: outMark } },
        { $inc: { money: -total }, $push: { txLog: { $each: [outMark], $slice: TX_LOG_KEEP } } },
      );
      debited = res.modifiedCount === 1 || (await hasMark(t.fromId, key, outMark));
      if (!debited) return failTransfer(t, 'balance');
      await ledgerOnce({ economyKey: key, guildId: t.guildId, userId: t.fromId, type: 'transfer_out', amount: -total, reason: `→ ${t.toId}${t.memo ? ` · ${t.memo}` : ''}`, actorId: t.fromId, refId: outMark });
    }
    await getAccount(t.toId, t.guildId);
    await User.updateOne({ userId: t.toId, guildId: key, txLog: { $ne: inMark } }, { $inc: { money: t.amount }, $push: { txLog: { $each: [inMark], $slice: TX_LOG_KEEP } } });
    await ledgerOnce({ economyKey: key, guildId: t.guildId, userId: t.toId, type: 'transfer_in', amount: t.amount, reason: `← ${t.fromId}${t.memo ? ` · ${t.memo}` : ''}`, actorId: t.fromId, refId: inMark });
    await Transfer.updateOne({ transferId: t.transferId }, { $set: { status: 'completed', completedAt: new Date() } });
    const from = await User.findOne({ userId: t.fromId, guildId: key }, { money: 1 }).lean();
    return { ok: true, fee: t.fee, balance: from?.money };
  } catch (err) {
    console.error('[transfer]', t.transferId, err.message);
    return { ok: false, reason: 'error', message: '처리 중 오류 — 자동 복구 예정' };
  }
}

/** 같은 refId 원장 기록은 한 번만 */
async function ledgerOnce(entry) {
  if (await Ledger.findOne({ refId: entry.refId, userId: entry.userId }).lean()) return;
  try {
    await Ledger.create(entry);
  } catch (err) {
    if (err.code !== 11000) console.error('[Ledger]', err.message); // 동시 중복 요청 → 고유 인덱스가 하나만 남김
  }
}

/**
 * 중단된 송금 복구 (부팅·주기 실행). 이미 차감된 거래는 받는 쪽 지급까지 마저 끝내고,
 * 차감 전에 멈춘 거래는 실행하지 않고 실패 처리(한도 반환) — 사용자가 다시 요청하면 된다.
 */
async function recoverTransfers(olderThanMs = 60_000) {
  const stale = await Transfer.find({ status: 'pending', createdAt: { $lt: new Date(Date.now() - olderThanMs) } }).limit(100).lean();
  const out = { completed: 0, failed: 0 };
  for (const t of stale) {
    const r = await runTransfer(t, { allowDebit: false });
    if (r.ok) out.completed++;
    else out.failed++;
  }
  return out;
}

/** 오늘(서비스 시간대 기준) 사용한 송금 한도 (수수료 포함) */
async function transferredToday(userId, guildId, day) {
  const q = await TransferQuota.findOne({ economyKey: economyKey(guildId), userId, day }).lean();
  return q?.used ?? 0;
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
  grantOnce,
  debit,
  transfer,
  transferredToday,
  recoverTransfers,
  isUserId: (id) => USER_ID_RE.test(String(id)),
  claimBailout,
  claimDaily,
};
