const { Schema, model } = require('mongoose');

/** 송금 일일 한도 카운터 (경제 단위 × 유저 × 날짜). used는 조건부 $inc로만 증가 → 동시 요청에도 한도 초과 불가 */
const quotaSchema = new Schema({
  economyKey: { type: String, required: true },
  userId: { type: String, required: true },
  day: { type: String, required: true },
  used: { type: Number, default: 0 },
  refs: { type: [String], default: [] }, // 이 한도를 쓴 transferId (멱등 표식)
});
quotaSchema.index({ economyKey: 1, userId: 1, day: 1 }, { unique: true });

module.exports = model('TransferQuota', quotaSchema);
