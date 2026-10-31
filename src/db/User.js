const { Schema, model } = require('mongoose');
const config = require('../config');

const statsSchema = new Schema(
  {
    blackjackHands: { type: Number, default: 0 },
    blackjackWins: { type: Number, default: 0 },
    slotSpins: { type: Number, default: 0 },
    slotBestWin: { type: Number, default: 0 },
    crashRounds: { type: Number, default: 0 },
    crashMaxMultiplier: { type: Number, default: 0 },
    diceRolls: { type: Number, default: 0 },
    diceWins: { type: Number, default: 0 },
    pokerHands: { type: Number, default: 0 },
    pokerWins: { type: Number, default: 0 },
    baccaratRounds: { type: Number, default: 0 },
    baccaratWins: { type: Number, default: 0 },
    totalWagered: { type: Number, default: 0 },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    userId: { type: String, required: true, unique: true },
    guildId: { type: String }, // 마지막으로 명령어를 사용한 서버
    money: { type: Number, default: config.START_MONEY },
    stats: { type: statsSchema, default: () => ({}) },
    lastBailoutAt: { type: Date, default: null },
  },
  { timestamps: true }, // createdAt, updatedAt 자동 관리
);

module.exports = model('User', userSchema);
