/** 슬롯 프로그레시브 잭팟 (경제 단위별 풀). 풀은 하우스 부담으로 적립된다 (플레이어 배당 차감 없음) */
const Jackpot = require('../db/Jackpot');
const config = require('../config');
const { economyKey } = require('./wallet');

async function get(guildId) {
  const key = economyKey(guildId);
  return Jackpot.findOneAndUpdate({ economyKey: key }, { $setOnInsert: { economyKey: key, amount: config.JACKPOT.SEED } }, { upsert: true, new: true }).lean();
}

async function contribute(guildId, bet) {
  const add = Math.floor(bet * config.JACKPOT.CONTRIBUTION);
  if (add <= 0) return;
  await get(guildId);
  await Jackpot.updateOne({ economyKey: economyKey(guildId) }, { $inc: { amount: add } });
}

/** 풀 전액 획득 (원자적: 이전 값을 읽으며 시드로 리셋) */
async function take(guildId, userId) {
  await get(guildId);
  const before = await Jackpot.findOneAndUpdate(
    { economyKey: economyKey(guildId) },
    { $set: { amount: config.JACKPOT.SEED, lastWinner: userId, lastWonAt: new Date() } },
    { new: false },
  ).lean();
  const amount = before?.amount ?? config.JACKPOT.SEED;
  await Jackpot.updateOne({ economyKey: economyKey(guildId) }, { $set: { lastAmount: amount } });
  return amount;
}

module.exports = { get, contribute, take };
