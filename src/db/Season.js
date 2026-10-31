const { Schema, model } = require('mongoose');

const seasonSchema = new Schema({
  economyKey: { type: String, required: true },
  number: { type: Number, required: true },
  startedAt: { type: Date, required: true },
  endedAt: { type: Date, default: null },
  results: { type: [{ userId: String, net: Number, games: Number, rank: Number, _id: false }], default: [] },
});
seasonSchema.index({ economyKey: 1, number: 1 }, { unique: true });

module.exports = model('Season', seasonSchema);
