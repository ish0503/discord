const { Schema, model } = require('mongoose');

/** 게임 외 칩 이동 기록: 발행(+)·회수(−). 출석·지원금·관리자 지급/회수·상점 구매 등 */
const ledgerSchema = new Schema({
  economyKey: { type: String, required: true },
  guildId: String,
  userId: { type: String, required: true },
  type: { type: String, required: true }, // daily | bailout | admin_grant | admin_revoke | shop | season_reward | transfer_out | transfer_in | transfer_refund
  amount: { type: Number, required: true }, // +발행 / −회수
  reason: String,
  actorId: String,
  refId: String, // 멱등 표식 (송금: out:/in:<transferId>)
  createdAt: { type: Date, default: Date.now },
});
ledgerSchema.index({ economyKey: 1, createdAt: -1 });
ledgerSchema.index({ refId: 1, userId: 1 }, { unique: true, partialFilterExpression: { refId: { $type: 'string' } } }); // 같은 송금 원장 중복 방지

module.exports = model('Ledger', ledgerSchema);
