const { Schema, model } = require('mongoose');

/**
 * 토너먼트 예측 (관전자). 칩을 걸면 wallet 에스크로(game 'prediction')로 묶이고,
 * 결과는 관전자끼리 나눠 갖는 방식(패리뮤추얼, 하우스 몫 없음). 맞힌 사람이 없으면 전액 환불.
 * lockedAt 이후(첫 핸드 딜링 시작)에는 제출·수정 불가.
 */
const predSchema = new Schema({
  guildId: { type: String, required: true },
  tournamentId: { type: String, required: true },
  userId: { type: String, required: true },
  predictionType: { type: String, default: 'winner' },
  predictedResult: { type: String, required: true }, // 좌석 ID
  predictedName: String,
  stake: { type: Number, default: 0 },
  roundId: { type: String, default: null }, // 칩을 건 경우 에스크로 판 ID
  status: { type: String, default: 'open' }, // open | won | lost | refunded
  payout: { type: Number, default: 0 },
  score: { type: Number, default: 0 },
  submittedAt: { type: Date, default: Date.now },
  lockedAt: { type: Date, required: true },
  resolvedAt: Date,
});
predSchema.index({ tournamentId: 1, userId: 1, predictionType: 1 }, { unique: true });
predSchema.index({ guildId: 1, status: 1 });

module.exports = model('Prediction', predSchema);
