const { makeModel } = require('../fakeMongo');
class Schema { constructor(d,o){this.d=d} index(){} }
Schema.Types = { Mixed: 'Mixed' };
const D = {
  User: () => ({ money: 10000, escrow: [], stats: {}, diceLossStreak: 0, lastBailoutAt: null, lastDailyKey: null, dailyStreak: 0, outbox: [], txLog: [] }),
  Profile: () => ({ rewardPoints: 0, achievements: [], titles: [], inventory: [], equipped: { title: null, cardTheme: 'classic', slotTheme: 'fruit', diceSkin: 'classic', color: 'default', frame: 'none' }, totals: { games: 0, wins: 0, wagered: 0 }, processedEvents: [], dailyRule: { key: null, ruleId: null, progress: 0, streak: 0, games: [], completed: false, v: 0 }, ruleHistory: [], ruleCompletions: 0, storyRewards: [], collectionSets: [], showcase: [], winStreak: 0, maxWinStreak: 0, missions: { dailyKey: null, daily: {}, dailyClaimed: [], weeklyKey: null, weekly: {}, weeklyClaimed: [] } }),
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
  SettlementRecord: () => ({ participants: [], totals: {}, status: 'committed', issues: [] }),
};
const models = {};
module.exports = { Schema, model: (n) => (models[n] ||= makeModel(n, D[n] || (() => ({})))), models, set(){}, connection: { on(){}, readyState: 1 } };
