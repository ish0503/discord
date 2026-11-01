/**
 * 랭크 리그 서비스 (Outbox 핸들러 'rank').
 * - 서버 × 유저 × 게임(포커·토너먼트) × 시즌 단위 점수. 칩 보유량과 무관.
 * - 멱등: 처리 표식(processed)과 점수 변경을 같은 CAS 업데이트로.
 * - 부스팅 의심: 같은 사람 상대에게 하루 5판 이상 이기면 감사 로그(rank.suspicious) — 점수 반영도 줄어듦.
 * - 시즌 종료: 최고 등급 기록 → 업적·수집품, 다음 시즌은 절반 초기화된 점수로 시작.
 */
const RankProfile = require('../db/RankProfile');
const AuditLog = require('../db/AuditLog');
const profile = require('./profile');
const outbox = require('./outbox');
const notifier = require('./notifier');
const rank = require('../content/rank');
const time = require('../content/time');
const { casUpdate } = require('../utils/cas');

const seasonCache = new Map();
async function seasonKey(guildId) {
  const hit = seasonCache.get(guildId);
  if (hit && Date.now() - hit.at < 300_000) return hit.key;
  const s = await require('./seasons').current(guildId);
  const key = String(s?.number ?? 1);
  seasonCache.set(guildId, { key, at: Date.now() });
  return key;
}

/** 이 시즌 랭크 문서 (없으면 지난 시즌 점수를 절반 당겨 시작) */
async function ensure(guildId, userId, gameType, sk) {
  const q = { guildId, userId, gameType, seasonKey: sk };
  const have = await RankProfile.findOne(q).lean();
  if (have) return have;
  const last = await RankProfile.findOne({ guildId, userId, gameType, seasonKey: { $ne: sk } }).sort({ createdAt: -1 }).lean();
  const seed = rank.seasonSeed(last?.rating);
  const tier = rank.tierFor(seed);
  try {
    await RankProfile.create({ ...q, rating: seed, peakRating: seed, tier, peakTier: tier });
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
  return RankProfile.findOne(q).lean();
}

async function ratingsOf(guildId, userIds, gameType, sk) {
  if (!userIds.length) return [];
  const docs = await RankProfile.find({ guildId, gameType, seasonKey: sk, userId: { $in: userIds } }).lean();
  return userIds.map((id) => docs.find((d) => d.userId === id)?.rating ?? rank.START);
}

async function onSettled(ev, { eventId }) {
  const S = rank.scoreOf(ev);
  if (S === null) return;
  const sk = await seasonKey(ev.guildId);
  await ensure(ev.guildId, ev.userId, ev.game, sk);
  const opponents = (ev.detail?.opponents ?? []).filter((id) => id !== ev.userId);
  const oppRatings = await ratingsOf(ev.guildId, opponents, ev.game, sk);
  const bots = Math.max(0, rank.fieldSize(ev) - opponents.length);
  const day = time.dayKey(new Date(ev.at ?? Date.now()));
  const wk = time.weekKey(new Date(ev.at ?? Date.now()));
  const mark = `rank:${eventId}`;
  let suspicious = null;

  const r = await casUpdate(RankProfile, { guildId: ev.guildId, userId: ev.userId, gameType: ev.game, seasonKey: sk }, (doc) => {
    if ((doc.processed || []).includes(mark)) return null;
    const counts = doc.pairs?.day === day ? { ...(doc.pairs.counts || {}) } : {};
    for (const o of opponents) counts[o] = (counts[o] ?? 0) + 1;
    const maxPair = opponents.length ? Math.max(...opponents.map((o) => counts[o])) : 0;
    const d = rank.delta({ rating: doc.rating, games: doc.games, opponents: oppRatings, bots, S, repeat: rank.repeatFactor(maxPair - 1) });
    const rating = Math.max(0, doc.rating + d);
    const tier = rank.tierFor(rating, doc.tier);
    const peakTier = rank.tierIndex(tier) > rank.tierIndex(doc.peakTier) ? tier : doc.peakTier;
    if (S === 1 && opponents.length === 1 && maxPair >= 5) suspicious = { opponent: opponents[0], count: maxPair };
    const weeklyDelta = doc.weekly?.key === wk ? doc.weekly.delta + d : d;
    return {
      update: {
        $set: { rating, tier, peakTier, peakRating: Math.max(doc.peakRating, rating), pairs: { day, counts }, weekly: { key: wk, delta: weeklyDelta } },
        $inc: { games: 1, wins: S === 1 ? 1 : 0, losses: S === 0 ? 1 : 0 },
        $push: { processed: { $each: [mark], $slice: -300 }, recent: { $each: [{ delta: d, rating, at: new Date() }], $slice: -20 } },
      },
      d,
      before: doc,
      tier,
    };
  });
  if (!r.ok || r.noop) return;
  if (suspicious) {
    await AuditLog.create({ guildId: ev.guildId, actorId: 'system', action: 'rank.suspicious', targetId: ev.userId, reason: `같은 상대(${suspicious.opponent})에게 오늘 ${suspicious.count}판 연속 대결 승리 — 담합·부계정 부스팅 의심 (점수 반영 축소됨)`, after: { game: ev.game, opponent: suspicious.opponent } }).catch(() => {});
  }
  if (r.tier !== r.before.tier && rank.tierIndex(r.tier) > rank.tierIndex(r.before.tier)) {
    const t = rank.TIERS[rank.tierIndex(r.tier)];
    notifier.announce(ev.guildId, ev.recovered ? null : ev.channelId, { content: `${t.emoji} <@${ev.userId}> ${ev.game === 'poker' ? '포커' : '토너먼트'} 랭크 **${t.name}** 승급!`, allowedMentions: { parse: [] } }, 'important');
    await profile.checkTrigger(ev.userId, ev.guildId, 'rank', { rankTier: r.tier }, null);
    const collection = require('./collection');
    if (rank.tierIndex(r.tier) >= rank.tierIndex('gold')) await collection.grant(ev.userId, 'rank:gold', { source: `rank:${ev.game}:${sk}`, guildId: ev.guildId }).catch(() => {});
    if (r.tier === 'diamond') await collection.grant(ev.userId, 'rank:diamond', { source: `rank:${ev.game}:${sk}`, guildId: ev.guildId }).catch(() => {});
  }
}

async function profileOf(guildId, userId) {
  const sk = await seasonKey(guildId);
  const docs = await RankProfile.find({ guildId, userId }).sort({ createdAt: -1 }).lean();
  return { seasonKey: sk, current: docs.filter((d) => d.seasonKey === sk), past: docs.filter((d) => d.seasonKey !== sk) };
}

async function leaderboard(guildId, gameType, kind = 'season') {
  const sk = await seasonKey(guildId);
  const docs = await RankProfile.find({ guildId, gameType, seasonKey: sk, games: { $gt: 0 } }).lean();
  const wk = time.weekKey();
  const val = (d) => (kind === 'weekly' ? (d.weekly?.key === wk ? d.weekly.delta : null) : d.rating);
  return docs
    .map((d) => ({ d, v: val(d) }))
    .filter((x) => x.v !== null)
    .sort((a, b) => b.v - a.v)
    .slice(0, 15);
}

/** 시즌 종료: 이 시즌 문서를 닫고 최고 등급 보상 (멱등 — closed 플래그) */
async function closeSeason(guildId, seasonNumber) {
  const sk = String(seasonNumber);
  const docs = await RankProfile.find({ guildId, seasonKey: sk, closed: { $ne: true }, games: { $gt: 0 } }).lean();
  for (const d of docs) {
    const res = await RankProfile.updateOne({ _id: d._id, closed: { $ne: true } }, { $set: { closed: true } });
    if (!res.modifiedCount) continue;
    await profile.checkTrigger(d.userId, guildId, 'rankSeason', { rankTier: d.peakTier }, null);
  }
  seasonCache.delete(guildId);
  return docs.length;
}

outbox.register('round.settled', 'rank', onSettled);

module.exports = { onSettled, profileOf, leaderboard, closeSeason, ensure, seasonKey };
