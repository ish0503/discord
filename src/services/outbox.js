/**
 * 정산 이벤트 Outbox 처리기.
 *
 * 흐름
 *   1) wallet.settle()/refund()가 칩 변경과 "같은 원자적 업데이트"로 지갑 문서(User.outbox)에 이벤트를 넣는다.
 *      → 정산 직후 프로세스가 죽어도 이벤트는 지갑과 함께 이미 저장되어 있다.
 *   2) materialize(): 지갑 문서의 이벤트를 OutboxEvent 컬렉션으로 옮긴다 (eventId 고유 → 중복 생성 없음) 후 지갑에서 비운다.
 *   3) process(): 이벤트를 원자적으로 점유(lease)하고, 등록된 핸들러를 순서대로 실행한다.
 *      끝난 핸들러 이름은 done에 기록 → 재시도 때는 남은 핸들러만 실행. 핸들러 자체도 eventId로 멱등해야 한다.
 *   4) 실패하면 attempts·lastError를 남기고 지수 백오프로 재시도, MAX_ATTEMPTS를 넘으면 dead(관리자 확인).
 *   5) sweep(): 부팅 직후와 주기적으로 실행 — 지갑에 남은 이벤트 이관 + 미처리·실패·점유 만료 이벤트 처리.
 *
 * 이벤트 처리 실패는 이미 끝난 칩 정산에 영향을 주지 않는다 (지갑은 1)에서 끝남).
 */
const OutboxEvent = require('../db/OutboxEvent');
const User = require('../db/User');
const GameLog = require('../db/GameLog');
const config = require('../config');
const bus = require('./bus');

const OB = config.OUTBOX;
const instance = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const handlers = new Map(); // type → [{ name, fn }]

/** 핸들러 등록. 같은 이름은 한 번만 (모듈 재로딩 대비) */
function register(type, name, fn) {
  const list = handlers.get(type) ?? [];
  if (!list.some((h) => h.name === name)) list.push({ name, fn });
  handlers.set(type, list);
}

const backoff = (attempts) => Math.min(OB.MAX_BACKOFF_MS, OB.BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));

/** 지갑 문서에 쌓인 이벤트를 Outbox 컬렉션으로 이관 */
async function materialize(userId, economyKey) {
  const doc = await User.findOne({ userId, guildId: economyKey }, { outbox: 1 }).lean();
  const ids = [];
  for (const ev of doc?.outbox ?? []) {
    try {
      await OutboxEvent.create({ ...ev, status: 'pending', attempts: 0, done: [], nextAttemptAt: new Date() });
    } catch (err) {
      if (err.code !== 11000) throw err; // 이미 이관됨 → 그대로 진행
    }
    ids.push(ev.eventId);
  }
  if (ids.length) await User.updateOne({ userId, guildId: economyKey }, { $pull: { outbox: { eventId: { $in: ids } } } });
  return ids;
}

/** 이벤트 하나 점유 → 핸들러 실행. 이미 처리됐거나 다른 처리기가 점유 중이면 false */
async function processEvent(eventId) {
  const now = new Date();
  const ev = await OutboxEvent.findOneAndUpdate(
    {
      eventId,
      $or: [
        { status: { $in: ['pending', 'failed'] }, nextAttemptAt: { $lte: now } },
        { status: 'processing', leaseUntil: { $lt: now } }, // 처리 중 죽은 경우 (점유 만료)
      ],
    },
    { $set: { status: 'processing', leaseBy: instance, leaseUntil: new Date(now.getTime() + OB.LEASE_MS) }, $inc: { attempts: 1 } },
    { new: true },
  ).lean();
  if (!ev) return false;

  for (const h of handlers.get(ev.type) ?? []) {
    if (ev.done.includes(h.name)) continue;
    try {
      await h.fn(ev.payload, ev);
      await OutboxEvent.updateOne({ eventId }, { $addToSet: { done: h.name } });
    } catch (err) {
      const dead = ev.attempts >= OB.MAX_ATTEMPTS;
      await OutboxEvent.updateOne(
        { eventId },
        { $set: { status: dead ? 'dead' : 'failed', lastError: `${h.name}: ${err.message}`.slice(0, 500), nextAttemptAt: new Date(Date.now() + backoff(ev.attempts)), leaseUntil: null } },
      );
      console.error(`[outbox] ${eventId} ${h.name} 실패 (${ev.attempts}회):`, err.message);
      if (dead) bus.emit('alert', { level: 'error', title: 'Outbox 이벤트 처리 포기', message: `${eventId} · ${h.name}: ${err.message} — /관리자 정산상태 에서 확인` });
      return false;
    }
  }
  await OutboxEvent.updateOne({ eventId }, { $set: { status: 'done', processedAt: new Date(), lastError: null, leaseUntil: null } });
  return true;
}

/** 정산 직후 호출: 이관 + 처리 (호출자를 막지 않음) */
function kick(userId, economyKey, eventId) {
  return materialize(userId, economyKey)
    .then(() => processEvent(eventId))
    .catch((err) => console.error('[outbox kick]', err.message));
}

let sweeping = false;
/** 미처리 이벤트 일괄 처리 (부팅 시·주기 실행) */
async function sweep({ limit = OB.SWEEP_BATCH } = {}) {
  if (sweeping) return { skipped: true };
  sweeping = true;
  const out = { materialized: 0, processed: 0, failed: 0 };
  try {
    const users = await User.find({ 'outbox.0': { $exists: true } }, { userId: 1, guildId: 1 }).limit(limit).lean();
    for (const u of users) out.materialized += (await materialize(u.userId, u.guildId).catch(() => [])).length;
    const now = new Date();
    const due = await OutboxEvent.find({
      $or: [
        { status: { $in: ['pending', 'failed'] }, nextAttemptAt: { $lte: now } },
        { status: 'processing', leaseUntil: { $lt: now } },
      ],
    })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();
    for (const ev of due) {
      if (await processEvent(ev.eventId)) out.processed++;
      else out.failed++;
    }
  } finally {
    sweeping = false;
  }
  return out;
}

/** 관리자용 상태 요약 */
async function status(guildId) {
  const q = guildId ? { guildId } : {};
  const [pending, failed, dead, processing, recent] = await Promise.all([
    OutboxEvent.countDocuments({ ...q, status: 'pending' }),
    OutboxEvent.countDocuments({ ...q, status: 'failed' }),
    OutboxEvent.countDocuments({ ...q, status: 'dead' }),
    OutboxEvent.countDocuments({ ...q, status: 'processing' }),
    OutboxEvent.find({ ...q, status: { $in: ['failed', 'dead'] } }).sort({ createdAt: -1 }).limit(5).lean(),
  ]);
  return { pending, failed, dead, processing, recent };
}

/** 관리자 재시도: dead/failed 이벤트를 즉시 다시 처리 대상으로 */
async function retryDead(guildId) {
  const res = await OutboxEvent.updateMany({ ...(guildId ? { guildId } : {}), status: { $in: ['dead', 'failed'] } }, { $set: { status: 'pending', nextAttemptAt: new Date(), attempts: 0 } });
  return res.modifiedCount;
}

// 기본 핸들러: 게임 기록(GameLog) — roundId 고유 인덱스로 멱등. 통계·전적·랭킹·명예의 전당의 원천
async function ensureGameLog(p) {
  try {
    await GameLog.create({
      roundId: p.roundId,
      userId: p.userId,
      guildId: p.guildId,
      economyKey: p.economyKey,
      game: p.game,
      status: p.status,
      staked: p.staked,
      payout: p.payout,
      net: p.net,
      recovered: !!p.recovered,
      detail: p.detail,
      createdAt: p.at ? new Date(p.at) : new Date(),
    });
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
}
register('round.settled', 'gamelog', ensureGameLog);
register('round.refunded', 'gamelog', ensureGameLog);

module.exports = { register, materialize, processEvent, kick, sweep, status, retryDead, handlers, instance };
