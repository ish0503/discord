const { Schema, model } = require('mongoose');

/**
 * 라이벌 관계 (서버 안 두 사람, 상대 동의 필요). pairKey = 정렬한 두 ID.
 * 전적은 두 사람이 함께 한 실제 게임(포커 핸드·토너먼트)에서만 쌓인다.
 */
const rivalSchema = new Schema(
  {
    guildId: { type: String, required: true },
    pairKey: { type: String, required: true },
    a: { type: String, required: true }, // pairKey 앞쪽
    b: { type: String, required: true },
    requestedBy: { type: String, required: true },
    status: { type: String, default: 'pending' }, // pending | active | ended
    acceptedAt: Date,
    endedAt: Date,
    aWins: { type: Number, default: 0 },
    bWins: { type: Number, default: 0 },
    draws: { type: Number, default: 0 },
    streakHolder: { type: String, default: null },
    streak: { type: Number, default: 0 },
    bestStreak: { type: Schema.Types.Mixed, default: {} }, // { userId: n }
    weekly: { type: Schema.Types.Mixed, default: {} }, // { key, wins: { userId: n } } (공개 게임만)
    weeklyClaimed: { type: [String], default: [] }, // "userId:week"
    v: { type: Number, default: 0 },
  },
  { timestamps: true },
);
rivalSchema.index({ guildId: 1, pairKey: 1 }, { unique: true });
rivalSchema.index({ guildId: 1, a: 1, status: 1 });
rivalSchema.index({ guildId: 1, b: 1, status: 1 });

/** 한 게임에서 두 사람의 결과를 모으는 임시 기록 (둘 다 모이면 한 번만 반영) */
const matchSchema = new Schema({
  guildId: { type: String, required: true },
  gameId: { type: String, required: true },
  pairKey: { type: String, required: true },
  results: { type: Schema.Types.Mixed, default: {} }, // { userId: 점수(포커 순이익 / 토너먼트 −순위) }
  isPrivate: { type: Boolean, default: false },
  applied: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now, expires: 7 * 86400 }, // 임시 데이터만 TTL (전적은 Rivalry에 누적)
});
matchSchema.index({ guildId: 1, gameId: 1, pairKey: 1 }, { unique: true });

module.exports = model('Rivalry', rivalSchema);
module.exports.Match = model('RivalMatch', matchSchema);
