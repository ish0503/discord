const { Schema, model } = require('mongoose');

/** 스토리 챌린지 진행도 (서버 × 유저). v는 낙관적 동시성 버전, processed는 처리한 정산 이벤트 표식 */
const storySchema = new Schema(
  {
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    chapterId: { type: String, default: null }, // 진행 중인 챕터 (null = 시작 전/완료 후)
    stage: { type: Number, default: 0 },
    progress: { type: Number, default: 0 },
    games: { type: [String], default: [] },
    streak: { type: Number, default: 0 },
    completedStages: { type: [String], default: [] }, // "ch1:s1"
    completedChapters: { type: [String], default: [] },
    processed: { type: [String], default: [] },
    v: { type: Number, default: 0 },
  },
  { timestamps: true },
);
storySchema.index({ guildId: 1, userId: 1 }, { unique: true });

module.exports = model('StoryProgress', storySchema);
