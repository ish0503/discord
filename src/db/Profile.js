const { Schema, model } = require('mongoose');

/** 전역 프로필 (서버와 무관): 보상 포인트, 업적, 칭호, 꾸미기 아이템, 미션 진행도 */
const profileSchema = new Schema(
  {
    userId: { type: String, required: true, unique: true },
    rewardPoints: { type: Number, default: 0 },
    achievements: { type: [{ id: String, at: Date, _id: false }], default: [] },
    titles: { type: [String], default: [] },
    inventory: { type: [String], default: [] },
    equipped: {
      title: { type: String, default: null },
      cardTheme: { type: String, default: 'classic' },
      slotTheme: { type: String, default: 'fruit' },
      diceSkin: { type: String, default: 'classic' },
      color: { type: String, default: 'default' },
      frame: { type: String, default: 'none' },
    },
    totals: {
      games: { type: Number, default: 0 },
      wins: { type: Number, default: 0 },
      wagered: { type: Number, default: 0 },
    },
    // 오늘의 특별 규칙 진행 (v = 낙관적 동시성 버전)
    dailyRule: {
      key: { type: String, default: null },
      ruleId: { type: String, default: null },
      progress: { type: Number, default: 0 },
      streak: { type: Number, default: 0 },
      games: { type: [String], default: [] },
      completed: { type: Boolean, default: false },
      v: { type: Number, default: 0 },
    },
    ruleHistory: { type: [{ key: String, ruleId: String, progress: Number, completed: Boolean, _id: false }], default: [] },
    ruleCompletions: { type: Number, default: 0 },
    storyRewards: { type: [String], default: [] }, // 보상 받은 스토리 챕터 (서버가 달라도 1회)
    collectionSets: { type: [String], default: [] }, // 보상 받은 수집 세트
    showcase: { type: [String], default: [] }, // 프로필에 전시할 수집품 (최대 3)
    predict: {
      score: { type: Number, default: 0 },
      correct: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
      streak: { type: Number, default: 0 },
      bestStreak: { type: Number, default: 0 },
    },
    predictProcessed: { type: [String], default: [] }, // 채점한 예측 (멱등)
    rivalWeekly: { type: Number, default: 0 }, // 라이벌 주간 도전 달성 횟수
    // 처리한 정산 이벤트 id (최근 300개) — Outbox 재처리 시 전적·미션 중복 반영 방지
    processedEvents: { type: [String], default: [] },
    winStreak: { type: Number, default: 0 },
    maxWinStreak: { type: Number, default: 0 },
    missions: {
      dailyKey: { type: String, default: null },
      daily: { type: Schema.Types.Mixed, default: {} }, // { missionId: progress }
      dailyClaimed: { type: [String], default: [] },
      weeklyKey: { type: String, default: null },
      weekly: { type: Schema.Types.Mixed, default: {} },
      weeklyClaimed: { type: [String], default: [] },
    },
  },
  { timestamps: true, minimize: false },
);

module.exports = model('Profile', profileSchema);
