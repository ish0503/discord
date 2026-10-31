const { Schema, model } = require('mongoose');

/**
 * 기간 한정 이벤트. 공정성을 위해 게임 확률·배당에는 영향을 주지 않고
 * 보상 포인트(미션·업적·출석) 배수에만 적용된다.
 */
const eventSchema = new Schema({
  guildId: { type: String, required: true },
  name: { type: String, required: true },
  type: { type: String, default: 'points_boost' },
  multiplier: { type: Number, default: 2 },
  startsAt: { type: Date, required: true },
  endsAt: { type: Date, required: true },
  createdBy: String,
});
eventSchema.index({ guildId: 1, endsAt: 1 });

module.exports = model('Event', eventSchema);
