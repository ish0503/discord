const { Schema, model } = require('mongoose');

/**
 * 서버×유저 단위 클랜 활동 상태 (클랜을 옮겨도 유지) — 악용 방지용.
 *   day/expToday: 하루 기여 상한 (탈퇴 후 다른 클랜에 가입해도 초기화되지 않음)
 *   lastLeftAt: 재가입 대기
 *   processed: 처리한 정산 이벤트 표식 (Outbox 멱등)
 */
const playerSchema = new Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  day: { type: String, default: null },
  expToday: { type: Number, default: 0 },
  lastLeftAt: { type: Date, default: null },
  processed: { type: [String], default: [] },
  grants: { type: [Schema.Types.Mixed], default: [] }, // [{ eventId, clanId, exp }] 재시도 시 이어서 반영
  v: { type: Number, default: 0 },
});
playerSchema.index({ guildId: 1, userId: 1 }, { unique: true });

module.exports = model('ClanPlayer', playerSchema);
