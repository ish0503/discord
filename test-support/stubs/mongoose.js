const { makeModel } = require('../fakeMongo');
class Schema { constructor(d,o){this.d=d; this.o=o||{}; this.__schema=true} index(){} }
Schema.Types = { Mixed: 'Mixed' };
const D = {
  User: () => ({ money: 10000, escrow: [], stats: {}, diceLossStreak: 0, lastBailoutAt: null, lastDailyKey: null, dailyStreak: 0, outbox: [], txLog: [] }),
  Profile: () => ({ rewardPoints: 0, achievements: [], titles: [], inventory: [], equipped: { title: null, cardTheme: 'classic', slotTheme: 'fruit', diceSkin: 'classic', color: 'default', frame: 'none' }, totals: { games: 0, wins: 0, wagered: 0 }, processedEvents: [], dailyRule: { key: null, ruleId: null, progress: 0, streak: 0, games: [], completed: false, v: 0 }, ruleHistory: [], ruleCompletions: 0, storyRewards: [], collectionSets: [], showcase: [], predict: { score: 0, correct: 0, total: 0, streak: 0, bestStreak: 0 }, predictProcessed: [], rivalWeekly: 0, winStreak: 0, maxWinStreak: 0, missions: { dailyKey: null, daily: {}, dailyClaimed: [], weeklyKey: null, weekly: {}, weeklyClaimed: [] } }),
  GuildConfig: () => ({ adminRoleId: null, disabledGames: [], betLimits: {}, maintenance: { on: false, message: '' } }),
  GameState: () => ({ state: 'CREATED', players: [], history: [] }),
  Season: () => ({ endedAt: null, results: [] }),
  Tournament: () => ({ state: 'running', entrants: [], finish: [], prizes: [] }),
  OutboxEvent: () => ({ status: 'pending', attempts: 0, done: [], lastError: null, nextAttemptAt: new Date(0), leaseUntil: null, payload: {} }),
  Transfer: () => ({ status: 'pending', fee: 0 }),
  TransferQuota: () => ({ used: 0, refs: [] }),
  StoryProgress: () => ({ chapterId: null, stage: 0, progress: 0, games: [], streak: 0, completedStages: [], completedChapters: [], processed: [], v: 0 }),
  HallOfFameRecord: () => ({ current: true, anonymized: false, previous: null }),
  HallOfFameBest: () => ({ value: 0 }),
  Clan: () => ({ description: '', emblem: '🛡️', notice: '', channelId: null, level: 1, exp: 0, weekly: { key: null, exp: 0 }, lastWeekly: { key: null, exp: 0 }, weeklyWins: [], season: { key: null, exp: 0 }, memberCount: 1, achievements: [], processed: [], status: 'active' }),
  ClanMember: () => ({ role: 'member', joinedAt: new Date(), contribution: 0, weekly: { key: null, exp: 0 }, lastWeekly: { key: null, exp: 0 }, processed: [] }),
  ClanApplication: () => ({ status: 'pending' }),
  ClanPlayer: () => ({ day: null, expToday: 0, lastLeftAt: null, processed: [], grants: [], v: 0 }),
  WorldBoss: () => ({ phase: 1, status: 'active', rewardState: 'none', rewardConfig: null }),
  BossContribution: () => ({ clanId: null, contribution: 0, attempts: 0, day: null, attemptsToday: 0, passiveToday: 0, processed: [], rewarded: false }),
  UserCollection: () => ({ source: '' }),
  RankProfile: () => ({ rating: 1000, peakRating: 1000, tier: 'bronze', peakTier: 'bronze', wins: 0, losses: 0, games: 0, weekly: { key: null, delta: 0 }, pairs: {}, recent: [], processed: [], closed: false, v: 0 }),
  PrivateRoom: () => ({ approval: false, spectators: true, settings: {}, members: [], invited: [], pending: [], threadId: null, channelId: null, failedJoins: 0, status: 'open', games: [] }),
  Prediction: () => ({ predictionType: 'winner', stake: 0, roundId: null, status: 'open', payout: 0, score: 0 }),
  Rivalry: () => ({ status: 'pending', aWins: 0, bWins: 0, draws: 0, streakHolder: null, streak: 0, bestStreak: {}, weekly: {}, weeklyClaimed: [], v: 0 }),
  RivalMatch: () => ({ results: {}, applied: false, isPrivate: false }),
  SettlementRecord: () => ({ participants: [], totals: {}, status: 'committed', issues: [] }),
};
const models = {};
module.exports = { Schema, model: (n, schema) => (models[n] ||= makeModel(n, D[n] || (() => ({})), schema)), models, set(){}, connection: { on(){}, readyState: 1 } };
