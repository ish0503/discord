const { Schema, model } = require('mongoose');

/** 클랜 활동 기록 (생성·가입·탈퇴·추방·직책·설정·레벨업·해산). 삭제하지 않음 */
const logSchema = new Schema({
  guildId: { type: String, required: true },
  clanId: { type: String, required: true },
  type: { type: String, required: true },
  actorId: String,
  targetId: String,
  detail: { type: Schema.Types.Mixed, default: null },
  at: { type: Date, default: Date.now },
});
logSchema.index({ clanId: 1, at: -1 });

module.exports = model('ClanLog', logSchema);
