/** 경제·게임 통계 집계 (MongoDB aggregation) */
const GameLog = require('../db/GameLog');
const User = require('../db/User');
const Ledger = require('../db/Ledger');
const GameState = require('../db/GameState');
const registry = require('../games/registry');
const analytics = require('../content/analytics');
const { economyKey } = require('./wallet');

const PERIODS = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30, all: null };
const since = (period) => (PERIODS[period] ? new Date(Date.now() - PERIODS[period] * 3600_000) : new Date(0));

/** 서버 경제 대시보드 */
async function overview(guildId, period = '7d') {
  const from = since(period);
  const match = { guildId, status: 'settled', createdAt: { $gte: from } };
  const [byGame, players, wallets, ledger, recovered, needRecovery, firstLog] = await Promise.all([
    GameLog.aggregate([
      { $match: match },
      { $group: { _id: '$game', rounds: { $sum: 1 }, staked: { $sum: '$staked' }, payout: { $sum: '$payout' }, users: { $addToSet: '$userId' } } },
      { $project: { rounds: 1, staked: 1, payout: 1, players: { $size: '$users' } } },
      { $sort: { staked: -1 } },
    ]),
    GameLog.distinct('userId', match),
    User.aggregate([
      { $match: { guildId: economyKey(guildId) } },
      { $project: { money: 1, escrowSum: { $sum: '$escrow.amount' } } },
      { $group: { _id: null, users: { $sum: 1 }, money: { $sum: '$money' }, escrow: { $sum: '$escrowSum' } } },
    ]),
    Ledger.aggregate([
      { $match: { economyKey: economyKey(guildId), createdAt: { $gte: from } } },
      { $group: { _id: '$type', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    GameLog.countDocuments({ guildId, recovered: true, createdAt: { $gte: from } }),
    GameState.countDocuments({ guildId, state: 'RECOVERY_REQUIRED' }),
    GameLog.findOne(match).sort({ createdAt: 1 }).lean(),
  ]);
  const totals = byGame.reduce((t, g) => ({ rounds: t.rounds + g.rounds, staked: t.staked + g.staked, payout: t.payout + g.payout }), { rounds: 0, staked: 0, payout: 0 });
  const hours = Math.max(1, (Date.now() - (firstLog?.createdAt ?? from).getTime()) / 3600_000);
  const minted = ledger.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
  const burned = -ledger.filter((l) => l.amount < 0).reduce((s, l) => s + l.amount, 0);
  return {
    period,
    totals: { ...totals, rtp: totals.staked ? totals.payout / totals.staked : 0, houseNet: totals.staked - totals.payout },
    activePlayers: players.length,
    gamesPerHour: totals.rounds / hours,
    byGame,
    supply: wallets[0] ?? { users: 0, money: 0, escrow: 0 },
    ledger,
    minted,
    burned,
    recovered,
    needRecovery,
  };
}

/** 설계 RTP 대비 실제 RTP (게임 × 베팅 종류별) */
async function balance(guildId, period = '30d') {
  const groups = await GameLog.aggregate([
    { $match: { guildId, status: 'settled', staked: { $gt: 0 }, createdAt: { $gte: since(period) } } },
    {
      $group: {
        _id: { game: '$game', sub: { $ifNull: ['$detail.side', { $ifNull: ['$detail.choice', null] }] } },
        n: { $sum: 1 },
        staked: { $sum: '$staked' },
        payout: { $sum: '$payout' },
        sumR: { $sum: { $divide: ['$payout', '$staked'] } },
        sumR2: { $sum: { $pow: [{ $divide: ['$payout', '$staked'] }, 2] } },
      },
    },
    { $sort: { staked: -1 } },
  ]);
  const rows = groups.map((g) => ({ game: g._id.game, sub: g._id.sub, n: g.n, staked: g.staked, payout: g.payout, sumR: g.sumR, sumR2: g.sumR2 }));
  return analytics.balanceReport(rows, (game, sub) => {
    const meta = registry.GAMES[game];
    if (!meta) return null;
    return meta.designRTP(game === 'baccarat' ? { side: sub } : game === 'dice' ? { choice: sub } : {});
  });
}

/** 랭킹 */
async function leaderboard(guildId, type, { seasonStart, game, limit = 10 } = {}) {
  const key = economyKey(guildId);
  if (type === 'balance') {
    return (await User.find({ guildId: key }).sort({ money: -1 }).limit(limit).lean()).map((u) => ({ userId: u.userId, value: u.money }));
  }
  if (type === 'biggest') {
    return (await User.find({ guildId: key, 'stats.biggestWin': { $gt: 0 } }).sort({ 'stats.biggestWin': -1 }).limit(limit).lean()).map((u) => ({ userId: u.userId, value: u.stats.biggestWin }));
  }
  const match = { economyKey: key, status: 'settled' };
  if (type === 'season') match.createdAt = { $gte: seasonStart };
  if (game) match.game = game;
  if (type === 'winrate') {
    const rows = await GameLog.aggregate([
      { $match: match },
      { $group: { _id: '$userId', games: { $sum: 1 }, wins: { $sum: { $cond: [{ $gt: ['$net', 0] }, 1, 0] } } } },
      { $match: { games: { $gte: 20 } } }, // 최소 20판
      { $project: { games: 1, rate: { $divide: ['$wins', '$games'] } } },
      { $sort: { rate: -1 } },
      { $limit: limit },
    ]);
    return rows.map((r) => ({ userId: r._id, value: r.rate, games: r.games }));
  }
  const rows = await GameLog.aggregate([
    { $match: match },
    { $group: { _id: '$userId', net: { $sum: '$net' }, games: { $sum: 1 } } },
    { $sort: { net: -1 } },
    { $limit: limit },
  ]);
  return rows.map((r) => ({ userId: r._id, value: r.net, games: r.games }));
}

/** 유저 게임별 요약 */
async function userSummary(userId, guildId) {
  return GameLog.aggregate([
    { $match: { userId, economyKey: economyKey(guildId), status: 'settled' } },
    {
      $group: {
        _id: '$game',
        rounds: { $sum: 1 },
        wins: { $sum: { $cond: [{ $gt: ['$net', 0] }, 1, 0] } },
        staked: { $sum: '$staked' },
        payout: { $sum: '$payout' },
        net: { $sum: '$net' },
        best: { $max: '$net' },
      },
    },
    { $sort: { rounds: -1 } },
  ]);
}

async function history(userId, guildId, { page = 0, size = 10, game = null } = {}) {
  const q = { userId, economyKey: economyKey(guildId) };
  if (game) q.game = game;
  const [items, total] = await Promise.all([GameLog.find(q).sort({ createdAt: -1 }).skip(page * size).limit(size).lean(), GameLog.countDocuments(q)]);
  return { items, total, pages: Math.max(1, Math.ceil(total / size)) };
}

async function recentForAnalysis(userId, guildId, n = 100) {
  const logs = await GameLog.find({ userId, economyKey: economyKey(guildId) }).sort({ createdAt: -1 }).limit(n).lean();
  return logs.reverse();
}

async function crashRecent(guildId, n = 15) {
  const logs = await GameLog.find({ guildId, game: 'crash', status: 'settled' }).sort({ createdAt: -1 }).limit(n).lean();
  return logs.map((l) => l.detail?.crashPoint).filter((x) => typeof x === 'number');
}

module.exports = { PERIODS, since, overview, balance, leaderboard, userSummary, history, recentForAnalysis, crashRecent };
