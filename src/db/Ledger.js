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
  createdAt: { type: Date, default: Date.now },
});
ledgerSchema.index({ economyKey: 1, createdAt: -1 });

module.exports = model('Ledger', ledgerSchema);
