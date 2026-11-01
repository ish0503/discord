const { Schema, model } = require('mongoose');

/** 클랜 소속 (서버당 한 클랜). 탈퇴·추방 시 문서를 지우고 ClanLog·ClanPlayer에 기록을 남긴다. */
const memberSchema = new Schema({
  guildId: { type: String, required: true },
  clanId: { type: String, required: true },
  userId: { type: String, required: true },
  role: { type: String, default: 'member' }, // owner | officer | member
  joinedAt: { type: Date, default: Date.now },
  contribution: { type: Number, default: 0 }, // 이 클랜에서 쌓은 경험치
  weekly: { key: { type: String, default: null }, exp: { type: Number, default: 0 } },
  lastWeekly: { key: { type: String, default: null }, exp: { type: Number, default: 0 } },
  processed: { type: [String], default: [] },
});
memberSchema.index({ guildId: 1, userId: 1 }, { unique: true });
memberSchema.index({ clanId: 1, contribution: -1 });

module.exports = model('ClanMember', memberSchema);
