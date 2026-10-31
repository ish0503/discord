const { Schema, model } = require('mongoose');

/** 관리자 작업 감사 로그 (삭제·수정 기능 없음) */
const auditSchema = new Schema({
  guildId: String,
  actorId: { type: String, required: true },
  action: { type: String, required: true },
  targetId: String,
  amount: Number,
  reason: String,
  before: Schema.Types.Mixed,
  after: Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now },
});
auditSchema.index({ guildId: 1, createdAt: -1 });

module.exports = model('AuditLog', auditSchema);
