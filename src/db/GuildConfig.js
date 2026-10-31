const { Schema, model } = require('mongoose');

/** 서버별 운영 설정 (관리자 명령어로 변경) */
const guildConfigSchema = new Schema(
  {
    guildId: { type: String, required: true, unique: true },
    adminRoleId: { type: String, default: null },
    disabledGames: { type: [String], default: [] },
    betLimits: { type: Schema.Types.Mixed, default: {} }, // { game: { min, max } }
    maintenance: { on: { type: Boolean, default: false }, message: { type: String, default: '' } },
  },
  { timestamps: true, minimize: false },
);

module.exports = model('GuildConfig', guildConfigSchema);
