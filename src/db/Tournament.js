const { Schema, model } = require('mongoose');

const tournamentSchema = new Schema(
  {
    tournamentId: { type: String, required: true, unique: true },
    guildId: String,
    economyKey: String,
    channelId: String,
    fee: Number,
    rake: Number,
    prizePool: Number,
    startStack: Number,
    state: { type: String, default: 'running' }, // running | finished | cancelled
    entrants: { type: [{ id: String, name: String, type: String, _id: false }], default: [] },
    finish: { type: [{ id: String, name: String, type: String, place: Number, _id: false }], default: [] },
    prizes: { type: [{ userId: String, amount: Number, place: Number, _id: false }], default: [] },
    hands: Number,
    endedReason: String,
  },
  { timestamps: true },
);

module.exports = model('Tournament', tournamentSchema);
