const { Schema, model } = require('mongoose');

/** 수집품 보유 (전역 · 유저×아이템 1개). 중복 획득은 고유 인덱스로 차단, 획득 경로·날짜 기록 */
const collectionSchema = new Schema({
  userId: { type: String, required: true },
  itemId: { type: String, required: true },
  source: { type: String, default: '' }, // 획득 경로 (예: boss:dragon, story:ch4, season:3)
  guildId: String, // 획득한 서버 (기록용)
  seasonKey: String,
  obtainedAt: { type: Date, default: Date.now },
});
collectionSchema.index({ userId: 1, itemId: 1 }, { unique: true });

module.exports = model('UserCollection', collectionSchema);
