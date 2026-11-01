/**
 * 라이벌 시스템.
 * - 신청 → 상대 수락(동의) 필요. 한 사람당 활성 라이벌 최대 MAX개. 알림은 신청·수락 때 한 번씩만.
 * - 맞대결 기록(Outbox 핸들러 'rival'): 두 사람이 같은 포커 핸드·토너먼트에 함께 앉은 실제 게임에서만.
 *   두 사람의 정산 이벤트를 RivalMatch 에 모아 둘 다 모이면 한 번만 반영 (applied 조건부).
 * - 주간 도전: 이번 주 라이벌에게 공개 게임에서 N번 이기기 → 보상 포인트 1회(주별).
 *   비공개 방 맞대결은 전적에는 남지만 주간 도전·업적에는 세지 않는다 (친구끼리 보상 파밍 방지).
 */
const Rivalry = require('../db/Rivalry');
const Profile = require('../db/Profile');
const profile = require('./profile');
const outbox = require('./outbox');
const time = require('../content/time');
const { casUpdate } = require('../utils/cas');

const { Match } = Rivalry;
const MAX = 3;
const WEEKLY_GOAL = 3;
const WEEKLY_POINTS = 150;
const fail = (reason) => ({ ok: false, reason });
const pairOf = (x, y) => {
  const [a, b] = [x, y].sort();
  return { pairKey: `${a}:${b}`, a, b };
};
const activeCount = (guildId, userId) => Rivalry.countDocuments({ guildId, status: 'active', $or: [{ a: userId }, { b: userId }] });

async function request({ guildId, from, to, isBot = false }) {
  if (from === to) return fail('자기 자신과는 라이벌이 될 수 없어요.');
  if (isBot) return fail('봇과는 라이벌이 될 수 없어요.');
  if ((await activeCount(guildId, from)) >= MAX) return fail(`라이벌은 최대 ${MAX}명까지예요.`);
  const p = pairOf(from, to);
  const cur = await Rivalry.findOne({ guildId, pairKey: p.pairKey }).lean();
  if (cur?.status === 'active') return fail('이미 라이벌이에요.');
  if (cur?.status === 'pending') return fail(cur.requestedBy === from ? '이미 신청했어요. 상대의 수락을 기다려요.' : '상대가 먼저 신청했어요. `/라이벌 수락` 하세요.');
  if (cur) await Rivalry.updateOne({ _id: cur._id, status: 'ended' }, { $set: { status: 'pending', requestedBy: from } });
  else {
    try {
      await Rivalry.create({ guildId, ...p, requestedBy: from, status: 'pending' });
    } catch (err) {
      if (err.code === 11000) return fail('잠시 후 다시 시도해 주세요.');
      throw err;
    }
  }
  return { ok: true };
}

async function respond({ guildId, userId, other, accept }) {
  const p = pairOf(userId, other);
  const cur = await Rivalry.findOne({ guildId, pairKey: p.pairKey, status: 'pending' }).lean();
  if (!cur || cur.requestedBy === userId) return fail('받은 라이벌 신청이 없어요.');
  if (!accept) {
    await Rivalry.updateOne({ _id: cur._id, status: 'pending' }, { $set: { status: 'ended', endedAt: new Date() } });
    return { ok: true, accepted: false };
  }
  if ((await activeCount(guildId, userId)) >= MAX || (await activeCount(guildId, other)) >= MAX) return fail(`라이벌은 최대 ${MAX}명까지예요.`);
  const res = await Rivalry.updateOne({ _id: cur._id, status: 'pending' }, { $set: { status: 'active', acceptedAt: new Date() } });
  if (!res.modifiedCount) return fail('이미 처리된 신청이에요.');
  for (const u of [userId, other]) await profile.checkTrigger(u, guildId, 'rival', {}, null);
  return { ok: true, accepted: true };
}

async function end({ guildId, userId, other }) {
  const p = pairOf(userId, other);
  const res = await Rivalry.updateOne({ guildId, pairKey: p.pairKey, status: 'active' }, { $set: { status: 'ended', endedAt: new Date() } });
  return res.modifiedCount ? { ok: true } : fail('라이벌 관계가 아니에요.');
}

const list = (guildId, userId) => Rivalry.find({ guildId, $or: [{ a: userId }, { b: userId }], status: { $in: ['active', 'pending'] } }).lean();
const between = (guildId, x, y) => Rivalry.findOne({ guildId, pairKey: pairOf(x, y).pairKey }).lean();

/** 정산 이벤트 → 라이벌 맞대결 결과 모으기 */
async function onSettled(ev) {
  const opponents = ev.detail?.opponents ?? [];
  if (!opponents.length || !['poker', 'tournament'].includes(ev.game) || ev.status !== 'settled') return;
  const gameId = ev.detail?.tournamentId ?? ev.gameId;
  if (!gameId) return;
  const value = ev.game === 'tournament' ? -(ev.detail?.place ?? 99) : ev.net;
  for (const o of opponents) {
    const p = pairOf(ev.userId, o);
    const rv = await Rivalry.findOne({ guildId: ev.guildId, pairKey: p.pairKey, status: 'active' }).lean();
    if (!rv) continue;
    try {
      await Match.updateOne({ guildId: ev.guildId, gameId, pairKey: p.pairKey }, { $setOnInsert: { results: {}, applied: false, isPrivate: !!ev.detail?.roomId } }, { upsert: true });
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
    await Match.updateOne({ guildId: ev.guildId, gameId, pairKey: p.pairKey }, { $set: { [`results.${ev.userId}`]: value } });
    const m = await Match.findOne({ guildId: ev.guildId, gameId, pairKey: p.pairKey }).lean();
    if (m.applied || m.results[p.a] === undefined || m.results[p.b] === undefined) continue;
    const claim = await Match.updateOne({ _id: m._id, applied: false }, { $set: { applied: true } });
    if (claim.modifiedCount) await apply(ev.guildId, rv, m);
  }
}

/** 맞대결 1건 반영 (CAS) */
async function apply(guildId, rv, m) {
  const va = m.results[rv.a];
  const vb = m.results[rv.b];
  const winner = va > vb ? rv.a : vb > va ? rv.b : null;
  const wk = time.weekKey();
  const r = await casUpdate(Rivalry, { _id: rv._id }, (doc) => {
    const set = {};
    const inc = {};
    if (!winner) inc.draws = 1;
    else {
      inc[winner === doc.a ? 'aWins' : 'bWins'] = 1;
      const streak = doc.streakHolder === winner ? doc.streak + 1 : 1;
      set.streakHolder = winner;
      set.streak = streak;
      set[`bestStreak.${winner}`] = Math.max(doc.bestStreak?.[winner] ?? 0, streak);
      if (!m.isPrivate) {
        const wins = doc.weekly?.key === wk ? { ...(doc.weekly.wins || {}) } : {};
        wins[winner] = (wins[winner] ?? 0) + 1;
        set.weekly = { key: wk, wins };
      }
    }
    return { update: { $set: set, $inc: inc } };
  });
  if (!winner || m.isPrivate) return r;
  const doc = await Rivalry.findOne({ _id: rv._id }).lean();
  if ((doc.weekly?.wins?.[winner] ?? 0) >= WEEKLY_GOAL) {
    const tag = `${winner}:${wk}`;
    const claim = await Rivalry.updateOne({ _id: rv._id, weeklyClaimed: { $ne: tag } }, { $push: { weeklyClaimed: tag } });
    if (claim.modifiedCount) {
      await profile.get(winner);
      await Profile.updateOne({ userId: winner }, { $inc: { rewardPoints: WEEKLY_POINTS, rivalWeekly: 1 } });
    }
  }
  const totalWins = (await Rivalry.find({ guildId, $or: [{ a: winner }, { b: winner }] }).lean()).reduce((s, x) => s + (x.a === winner ? x.aWins : x.bWins), 0);
  await profile.checkTrigger(winner, guildId, 'rival', { rivalWins: totalWins, rivalStreak: doc.bestStreak?.[winner] ?? 0 }, null);
  return r;
}

outbox.register('round.settled', 'rival', onSettled);

module.exports = { request, respond, end, list, between, onSettled, pairOf, MAX, WEEKLY_GOAL, WEEKLY_POINTS };
