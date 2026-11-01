const { Schema, model } = require('mongoose');

/**
 * 송금 거래 (transferId = 멱등 키). 같은 transferId로 다시 요청해도 한 번만 처리된다.
 * 실제 칩 이동은 지갑 문서의 txLog 표식(out:/in:)과 함께 원자적으로 반영되어 재시도·재시작에도 중복되지 않는다.
 */
const transferSchema = new Schema({
  transferId: { type: String, required: true, unique: true },
  economyKey: { type: String, required: true },
  guildId: String,
  fromId: { type: String, required: true },
  toId: { type: String, required: true },
  amount: { type: Number, required: true },
  fee: { type: Number, default: 0 },
  day: { type: String, required: true }, // 한도 집계일 (서비스 시간대)
  memo: String,
  status: { type: String, default: 'pending' }, // pending | completed | failed
  reason: String,
  createdAt: { type: Date, default: Date.now },
  completedAt: Date,
});
transferSchema.index({ status: 1, createdAt: 1 });
transferSchema.index({ economyKey: 1, fromId: 1, createdAt: -1 });

module.exports = model('Transfer', transferSchema);
