const { Schema, model } = require('mongoose');

/** 클랜 가입 신청 (승인제) */
const appSchema = new Schema({
  guildId: { type: String, required: true },
  clanId: { type: String, required: true },
  userId: { type: String, required: true },
  status: { type: String, default: 'pending' }, // pending | approved | rejected | cancelled
  decidedBy: String,
  createdAt: { type: Date, default: Date.now },
  decidedAt: Date,
});
appSchema.index({ clanId: 1, userId: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } });
appSchema.index({ guildId: 1, userId: 1, status: 1 });

module.exports = model('ClanApplication', appSchema);
