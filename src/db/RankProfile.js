const { Schema, model } = require('mongoose');

/** 랭크 리그 점수 (서버 × 유저 × 게임 × 시즌). v = 낙관적 동시성 버전, processed = 반영한 정산 이벤트 */
const rankSchema = new Schema(
  {
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    gameType: { type: String, required: true },
    seasonKey: { type: String, required: true },
    rating: { type: Number, default: 1000 },
    peakRating: { type: Number, default: 1000 },
    tier: { type: String, default: 'bronze' },
    peakTier: { type: String, default: 'bronze' },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    games: { type: Number, default: 0 },
    weekly: { key: { type: String, default: null }, delta: { type: Number, default: 0 } },
    pairs: { type: Schema.Types.Mixed, default: {} }, // { day, counts: { opponentId: n } } 같은 상대 반복 판 수
    recent: { type: [{ delta: Number, rating: Number, at: Date, _id: false }], default: [] },
    processed: { type: [String], default: [] },
    closed: { type: Boolean, default: false }, // 시즌 종료 처리됨
    v: { type: Number, default: 0 },
  },
  { timestamps: true },
);
rankSchema.index({ guildId: 1, userId: 1, gameType: 1, seasonKey: 1 }, { unique: true });
rankSchema.index({ guildId: 1, gameType: 1, seasonKey: 1, rating: -1 });

module.exports = model('RankProfile', rankSchema);
