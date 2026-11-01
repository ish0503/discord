const { Schema, model } = require('mongoose');

/**
 * 게임(테이블·세션) 단위 상태 머신.
 * CREATED → BETTING → PLAYING → SETTLING → COMPLETED
 *                           └─▶ CANCELLED / RECOVERY_REQUIRED
 * 부팅 시 종료되지 않은 문서를 찾아 복구 정책을 적용하고 디스코드 메시지를 갱신한다.
 */
const STATES = ['CREATED', 'BETTING', 'PLAYING', 'SETTLING', 'COMPLETED', 'CANCELLED', 'RECOVERY_REQUIRED'];

const gameStateSchema = new Schema(
  {
    gameId: { type: String, required: true, unique: true },
    game: { type: String, required: true },
    guildId: String,
    channelId: String,
    messageId: String,
    instance: String,
    state: { type: String, enum: STATES, default: 'CREATED' },
    players: { type: [String], default: [] },
    history: { type: [{ state: String, at: Date, note: String, _id: false }], default: [] },
    recovery: { action: String, at: Date, note: String, settled: Number, refunded: Number },
  },
  { timestamps: true },
);

gameStateSchema.index({ state: 1, updatedAt: 1 });

module.exports = model('GameState', gameStateSchema);
module.exports.STATES = STATES;
