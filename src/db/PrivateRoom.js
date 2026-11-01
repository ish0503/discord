const { Schema, model } = require('mongoose');

/**
 * 비공개 게임방. 초대 코드는 원문을 저장하지 않고 sha256(salt+code) 만 저장한다.
 * 게임 참가·베팅은 기존 로비·에스크로 정산을 그대로 쓰고, 방장은 결과·잔액을 바꿀 수 없다.
 * 방 판 기록은 GameLog.detail.roomId 로 구분된다 (랭크 리그·명예의 전당 제외).
 */
const roomSchema = new Schema(
  {
    roomId: { type: String, required: true, unique: true },
    guildId: { type: String, required: true },
    ownerId: { type: String, required: true },
    name: { type: String, required: true },
    gameType: { type: String, required: true }, // poker | tournament
    inviteCodeHash: { type: String, required: true },
    codeSalt: { type: String, required: true },
    approval: { type: Boolean, default: false }, // true면 코드로 들어와도 방장 승인 필요
    spectators: { type: Boolean, default: true },
    settings: { type: Schema.Types.Mixed, default: {} }, // { amount, bots, maxHumans, stack }
    members: { type: [String], default: [] },
    invited: { type: [String], default: [] },
    pending: { type: [String], default: [] },
    threadId: { type: String, default: null },
    channelId: { type: String, default: null },
    failedJoins: { type: Number, default: 0 },
    status: { type: String, default: 'open' }, // open | locked | closed
    games: { type: [String], default: [] }, // 이 방에서 연 게임 ID
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
roomSchema.index({ guildId: 1, status: 1 });
roomSchema.index({ guildId: 1, ownerId: 1, status: 1 });

module.exports = model('PrivateRoom', roomSchema);
