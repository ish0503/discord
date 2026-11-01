const { Schema, model } = require('mongoose');

/** 서버 단위 월드 보스. 체력은 원자적 $inc 로만 깎이고, 처치·실패 전환은 상태 조건부 업데이트로 1회 */
const bossSchema = new Schema(
  {
    bossId: { type: String, required: true, unique: true },
    guildId: { type: String, required: true },
    defId: { type: String, required: true },
    seasonKey: String,
    hp: { type: Number, required: true },
    maxHp: { type: Number, required: true },
    phase: { type: Number, default: 1 },
    status: { type: String, default: 'active' }, // active | defeated | failed
    startsAt: { type: Date, default: Date.now },
    endsAt: { type: Date, required: true },
    endedAt: Date,
    createdBy: String,
    channelId: String,
    rewardState: { type: String, default: 'none' }, // none | granting | done
    rewardConfig: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);
bossSchema.index({ guildId: 1, status: 1 }, { unique: true, partialFilterExpression: { status: 'active' }, name: 'one_active_boss_per_guild' });

module.exports = model('WorldBoss', bossSchema);
