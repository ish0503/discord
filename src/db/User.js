const { Schema, model } = require('mongoose');
const config = require('../config');

/**
 * 지갑 (경제 단위별 1문서).
 * ECONOMY.SCOPE='guild'이면 guildId = 디스코드 서버 ID, 'global'이면 guildId = 'global'.
 */
const statsSchema = new Schema(
  {
    blackjackHands: { type: Number, default: 0 },
    blackjackWins: { type: Number, default: 0 },
    slotSpins: { type: Number, default: 0 },
    slotBestWin: { type: Number, default: 0 },
    jackpots: { type: Number, default: 0 },
    crashRounds: { type: Number, default: 0 },
    crashMaxMultiplier: { type: Number, default: 0 },
    diceRolls: { type: Number, default: 0 },
    diceWins: { type: Number, default: 0 },
    pokerHands: { type: Number, default: 0 },
    pokerWins: { type: Number, default: 0 },
    baccaratRounds: { type: Number, default: 0 },
    baccaratWins: { type: Number, default: 0 },
    tournaments: { type: Number, default: 0 },
    tournamentWins: { type: Number, default: 0 },
    totalWagered: { type: Number, default: 0 },
    biggestWin: { type: Number, default: 0 }, // 한 판 최대 순이익
  },
  { _id: false },
);

/**
 * 에스크로: 진행 중인 판에 묶인 칩.
 * pendingPayout: 결과가 확정된 뒤 정산 직전에 기록(write-ahead) → 그 사이 서버가 죽어도 확정된 결과대로 정산.
 */
const escrowSchema = new Schema(
  {
    roundId: { type: String, required: true },
    game: { type: String, required: true },
    amount: { type: Number, required: true },
    instance: { type: String },
    discordGuildId: { type: String },
    gameId: { type: String }, // GameState와 연결
    pendingPayout: { type: Number, default: null },
    pendingMeta: { type: Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    userId: { type: String, required: true },
    guildId: { type: String, required: true },
    money: { type: Number, default: config.START_MONEY },
    escrow: { type: [escrowSchema], default: [] },
    stats: { type: statsSchema, default: () => ({}) },
    diceLossStreak: { type: Number, default: 0 },
    lastBailoutAt: { type: Date, default: null },
    lastDailyKey: { type: String, default: null },
    dailyStreak: { type: Number, default: 0 },
  },
  { timestamps: true },
);

userSchema.index({ userId: 1, guildId: 1 }, { unique: true });
userSchema.index({ guildId: 1, money: -1 });
userSchema.index({ 'escrow.createdAt': 1 }, { sparse: true });

module.exports = model('User', userSchema);
