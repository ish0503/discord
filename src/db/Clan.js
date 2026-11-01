const { Schema, model } = require('mongoose');

/**
 * 클랜 (이용자 모임). guildId = 디스코드 서버 — 클랜은 서버 안에서만 존재한다.
 * 이름은 서버 안에서 고유(nameKey). 해산해도 문서는 남겨 기록·감사에 쓴다(status).
 */
const clanSchema = new Schema(
  {
    clanId: { type: String, required: true, unique: true },
    guildId: { type: String, required: true },
    name: { type: String, required: true },
    nameKey: { type: String, required: true }, // 소문자·공백 제거 (중복 판정용)
    tag: { type: String, required: true },
    description: { type: String, default: '' },
    emblem: { type: String, default: '🛡️' },
    notice: { type: String, default: '' },
    ownerId: { type: String, required: true },
    channelId: { type: String, default: null }, // 클랜 알림 채널 (생성한 채널)
    level: { type: Number, default: 1 },
    exp: { type: Number, default: 0 },
    weekly: { key: { type: String, default: null }, exp: { type: Number, default: 0 } },
    lastWeekly: { key: { type: String, default: null }, exp: { type: Number, default: 0 } }, // 주간 순위 정산용 직전 주 값
    weeklyWins: { type: [String], default: [] }, // 주간 1위를 한 주 (중복 보상 방지)
    season: { key: { type: String, default: null }, exp: { type: Number, default: 0 } },
    memberCount: { type: Number, default: 1 },
    achievements: { type: [String], default: [] },
    processed: { type: [String], default: [] }, // 반영한 정산 이벤트 (최근 2000, Outbox 멱등)
    status: { type: String, default: 'active' }, // active | disbanded
    disbandedAt: Date,
  },
  { timestamps: true },
);
clanSchema.index({ guildId: 1, nameKey: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
clanSchema.index({ guildId: 1, 'weekly.key': 1, 'weekly.exp': -1 });

module.exports = model('Clan', clanSchema);
