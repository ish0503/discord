const { makeModel } = require('../fakeMongo');
class Schema { constructor(d,o){this.d=d} index(){} }
Schema.Types = { Mixed: 'Mixed' };
const D = {
  User: () => ({ money: 10000, escrow: [], stats: {}, diceLossStreak: 0, lastBailoutAt: null, lastDailyKey: null, dailyStreak: 0 }),
  Profile: () => ({ rewardPoints: 0, achievements: [], titles: [], inventory: [], equipped: { title: null, cardTheme: 'classic', slotTheme: 'fruit', diceSkin: 'classic', color: 'default', frame: 'none' }, totals: { games: 0, wins: 0, wagered: 0 }, winStreak: 0, maxWinStreak: 0, missions: { dailyKey: null, daily: {}, dailyClaimed: [], weeklyKey: null, weekly: {}, weeklyClaimed: [] } }),
  GuildConfig: () => ({ adminRoleId: null, disabledGames: [], betLimits: {}, maintenance: { on: false, message: '' } }),
  GameState: () => ({ state: 'CREATED', players: [], history: [] }),
  Season: () => ({ endedAt: null, results: [] }),
  Tournament: () => ({ state: 'running', entrants: [], finish: [], prizes: [] }),
};
const models = {};
module.exports = { Schema, model: (n) => (models[n] ||= makeModel(n, D[n] || (() => ({})))), models, set(){}, connection: { on(){}, readyState: 1 } };
