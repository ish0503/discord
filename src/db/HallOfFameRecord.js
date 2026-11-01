const { Schema, model } = require('mongoose');

/**
 * 명예의 전당 기록 (덮어쓰지 않고 쌓는 이력). 검증된 정산 이벤트·시즌 결과에서만 생성된다.
 * current=true 가 그 분류의 현재 기록. 새 기록이 나오면 이전 기록은 current=false 로 남는다.
 * 경제 기록이므로 TTL 없음. 탈퇴·삭제 요청 시 anonymized=true (userId는 'deleted'로 바뀜, 수치는 보존).
 */
const hofSchema = new Schema({
  recordId: { type: String, required: true, unique: true },
  guildId: { type: String, required: true },
  category: { type: String, required: true },
  userId: { type: String, required: true },
  value: { type: Number, required: true },
  game: String,
  gameId: String,
  roundId: String,
  seasonNumber: Number,
  previous: { type: Schema.Types.Mixed, default: null }, // { userId, value, recordId }
  current: { type: Boolean, default: true },
  anonymized: { type: Boolean, default: false },
  achievedAt: { type: Date, default: Date.now },
});
hofSchema.index({ guildId: 1, category: 1, achievedAt: -1 });
hofSchema.index({ guildId: 1, userId: 1 });

/** 분류별 현재 최고 기록 (조건부 갱신으로 동시에 들어온 기록도 하나만 이김) */
const bestSchema = new Schema({
  guildId: { type: String, required: true },
  category: { type: String, required: true },
  value: { type: Number, default: 0 },
  userId: String,
  recordId: String,
  updatedAt: Date,
});
bestSchema.index({ guildId: 1, category: 1 }, { unique: true });

module.exports = model('HallOfFameRecord', hofSchema);
module.exports.Best = model('HallOfFameBest', bestSchema);
