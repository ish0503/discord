const { Schema, model } = require('mongoose');
const config = require('../config');

/**
 * 판 단위 게임 기록 (정산·환불 1건당 1문서).
 * roundId가 unique라 같은 판의 기록이 두 번 쌓이지 않는다.
 * 향후 /전적, /최근게임, /랭킹 등의 데이터 원천.
 */
const gameLogSchema = new Schema({
  roundId: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  guildId: { type: String },
  game: { type: String, required: true },
  status: { type: String, enum: ['settled', 'refunded'], required: true },
  staked: { type: Number, required: true }, // 이 판에 건 총액 (더블·레이즈 포함)
  payout: { type: Number, required: true }, // 돌려받은 총액 (원금 포함)
  net: { type: Number, required: true },
  detail: { type: Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now },
});

gameLogSchema.index({ userId: 1, createdAt: -1 });
gameLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: config.ECONOMY.LOG_RETENTION_DAYS * 24 * 60 * 60 });

module.exports = model('GameLog', gameLogSchema);
