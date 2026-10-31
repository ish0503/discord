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

/**
 * 에스크로: 진행 중인 게임에 묶인 칩.
 * 베팅 시 money에서 빠져 여기로 들어오고, 정산(또는 환불) 시 항목이 제거된다.
 * money 변경과 escrow 변경은 항상 같은 문서에 대한 단일 업데이트 → 원자성 보장.
 */
const escrowSchema = new Schema(
  {
    roundId: { type: String, required: true },
    game: { type: String, required: true },
    amount: { type: Number, required: true },
    instance: { type: String }, // 이 판을 연 봇 프로세스 ID
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    userId: { type: String, required: true, unique: true },
    guildId: { type: String }, // 마지막으로 명령어를 사용한 서버
    money: { type: Number, default: config.START_MONEY },
    escrow: { type: [escrowSchema], default: [] },
    stats: { type: statsSchema, default: () => ({}) },
    diceLossStreak: { type: Number, default: 0 },
    lastBailoutAt: { type: Date, default: null },
  },
  { timestamps: true }, // createdAt, updatedAt 자동 관리
);

userSchema.index({ 'escrow.createdAt': 1 }, { sparse: true });

module.exports = model('User', userSchema);
