const { Schema, model } = require('mongoose');

/** 보스별 개인 기여도. 하루 공격 횟수·지원 피해 상한은 조건부 $inc 로 원자적으로 검사 */
const contribSchema = new Schema({
  guildId: { type: String, required: true },
  bossId: { type: String, required: true },
  userId: { type: String, required: true },
  clanId: { type: String, default: null }, // 기여 당시 클랜
  contribution: { type: Number, default: 0 },
  attempts: { type: Number, default: 0 },
  day: { type: String, default: null },
  attemptsToday: { type: Number, default: 0 },
  passiveToday: { type: Number, default: 0 },
  processed: { type: [String], default: [] },
  rewarded: { type: Boolean, default: false },
  updatedAt: { type: Date, default: Date.now },
});
contribSchema.index({ bossId: 1, userId: 1 }, { unique: true });
contribSchema.index({ bossId: 1, contribution: -1 });

module.exports = model('BossContribution', contribSchema);
