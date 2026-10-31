const { Schema, model } = require('mongoose');

/** 슬롯 프로그레시브 잭팟 풀 (경제 단위별) */
const jackpotSchema = new Schema(
  {
    economyKey: { type: String, required: true, unique: true },
    amount: { type: Number, required: true },
    lastWinner: String,
    lastAmount: Number,
    lastWonAt: Date,
  },
  { timestamps: true },
);

module.exports = model('Jackpot', jackpotSchema);
