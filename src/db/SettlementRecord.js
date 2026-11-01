const { Schema, model } = require('mongoose');

/**
 * 다인 정산 기록 (포커 핸드·토너먼트 등). 지갑을 바꾸기 전에 참가자별 지급액과 합계를 먼저 남긴다.
 * status: committed(선기록) → applied(전원 정산) | partial(일부 실패 → 관리자 확인) | rejected(검증 실패, 지갑 변경 없음)
 */
const recordSchema = new Schema({
  settlementId: { type: String, required: true, unique: true },
  gameId: String,
  game: String,
  guildId: String,
  participants: {
    type: [{ userId: String, roundId: String, payout: Number, staked: Number, result: String, _id: false }],
    default: [],
  },
  totals: { type: Schema.Types.Mixed, default: {} },
  status: { type: String, default: 'committed' },
  issues: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now },
  appliedAt: Date,
});
recordSchema.index({ guildId: 1, status: 1, createdAt: -1 });

module.exports = model('SettlementRecord', recordSchema);
