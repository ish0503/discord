const { Schema, model } = require('mongoose');

/** 서버별 운영 설정 (관리자 명령어로 변경) */
const guildConfigSchema = new Schema(
  {
    guildId: { type: String, required: true, unique: true },
    adminRoleId: { type: String, default: null },
    disabledGames: { type: [String], default: [] },
    betLimits: { type: Schema.Types.Mixed, default: {} }, // { game: { min, max } }
    maintenance: { on: { type: Boolean, default: false }, message: { type: String, default: '' } },
    // 채널 알림 빈도: all(모두) · important(영웅 이상 업적·기록 갱신·보스 등 중요한 것만) · off(끄기)
    notifyLevel: { type: String, default: 'all' },
  },
  { timestamps: true, minimize: false },
);

module.exports = model('GuildConfig', guildConfigSchema);
