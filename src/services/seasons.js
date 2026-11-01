/** 시즌: 기간별 순수익 랭킹. 종료 시 결과 스냅샷 저장 + 상위권 업적(칭호) 지급 */
const Season = require('../db/Season');
const GameLog = require('../db/GameLog');
const config = require('../config');
const profile = require('./profile');
const { economyKey } = require('./wallet');

async function current(guildId) {
  const key = economyKey(guildId);
  const open = await Season.findOne({ economyKey: key, endedAt: null }).sort({ number: -1 }).lean();
  if (open) return open;
  const last = await Season.findOne({ economyKey: key }).sort({ number: -1 }).lean();
  try {
    return (await Season.create({ economyKey: key, number: (last?.number ?? 0) + 1, startedAt: new Date() })).toObject?.() ?? (await Season.findOne({ economyKey: key, endedAt: null }).lean());
  } catch (err) {
    if (err.code === 11000) return Season.findOne({ economyKey: key, endedAt: null }).sort({ number: -1 }).lean();
    throw err;
  }
}

/** 시즌 종료: 순위 확정 → 다음 시즌 시작 */
async function end(guildId, { channelId } = {}) {
  const key = economyKey(guildId);
  const s = await current(guildId);
  const results = await GameLog.aggregate([
    { $match: { economyKey: key, status: 'settled', createdAt: { $gte: s.startedAt } } },
    { $group: { _id: '$userId', net: { $sum: '$net' }, games: { $sum: 1 } } },
    { $sort: { net: -1 } },
    { $limit: 20 },
  ]);
  const ranked = results.map((r, k) => ({ userId: r._id, net: r.net, games: r.games, rank: k + 1 }));
  const closed = await Season.findOneAndUpdate({ _id: s._id, endedAt: null }, { $set: { endedAt: new Date(), results: ranked } }, { new: true }).lean();
  if (!closed) return null; // 이미 다른 곳에서 종료
  // 명예의 전당: 시즌 우승자 (지운 적 없는 누적 이력)
  if (ranked[0]) {
    await require('./hallOfFame')
      .append({ guildId: key, category: 'season_champion', userId: ranked[0].userId, value: ranked[0].net, refId: `${key}:${closed.number}`, extra: { seasonNumber: closed.number } })
      .catch(console.error);
  }
  await require('./clan').closeSeason(key, closed.number).catch(console.error);
  for (const r of ranked.slice(0, config.SEASON.TOP_TITLES)) {
    await profile.checkTrigger(r.userId, guildId, 'season', { seasonRank: r.rank }, channelId).catch(console.error);
  }
  const next = await current(guildId);
  return { closed, next };
}

/** SEASON.DAYS가 지난 시즌 자동 종료 (매시간 실행) */
async function autoRollover() {
  const cutoff = new Date(Date.now() - config.SEASON.DAYS * 86400_000);
  const due = await Season.find({ endedAt: null, startedAt: { $lt: cutoff } }).lean();
  for (const s of due) {
    const guildId = s.economyKey === 'global' ? 'global' : s.economyKey;
    await end(guildId).catch((err) => console.error('[season rollover]', err));
  }
  return due.length;
}

module.exports = { current, end, autoRollover };
