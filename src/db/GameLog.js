const { Schema, model } = require('mongoose');
const config = require('../config');

/** 판 단위 기록 (정산·환불 1건당 1문서). 통계·전적·랭킹·리플레이의 원천 */
const gameLogSchema = new Schema({
  roundId: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  guildId: { type: String }, // 디스코드 서버 ID (통계용)
  economyKey: { type: String }, // 지갑 단위 (SCOPE에 따라 서버 ID 또는 'global')
  game: { type: String, required: true },
  status: { type: String, enum: ['settled', 'refunded'], required: true },
  staked: { type: Number, required: true },
  payout: { type: Number, required: true },
  net: { type: Number, required: true },
  recovered: { type: Boolean, default: false }, // 장애 복구로 처리된 판
  detail: { type: Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now },
});

gameLogSchema.index({ userId: 1, createdAt: -1 });
gameLogSchema.index({ economyKey: 1, createdAt: -1 });
gameLogSchema.index({ guildId: 1, game: 1, createdAt: -1 });
gameLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: config.ECONOMY.LOG_RETENTION_DAYS * 24 * 60 * 60 });

module.exports = model('GameLog', gameLogSchema);
