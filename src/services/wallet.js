/**
 * 잔고 접근은 전부 여기서만. 게임 도중에는 DB를 건드리지 않고,
 * 판이 끝나는 순간 settle() 한 번으로 $inc 원자 연산 정산한다.
 */
const User = require('../db/User');
const config = require('../config');

/** 계정 조회 (없으면 기본 잔고로 생성) */
async function getAccount(userId, guildId) {
  return User.findOneAndUpdate(
    { userId },
    { $set: { guildId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
}

/**
 * 게임 종료 정산.
 * @param {number} net 순손익 (+면 획득, -면 손실)
 * @param {{ inc?: object, max?: object, wagered?: number }} stats
 */
async function settle(userId, guildId, net, { inc = {}, max = {}, wagered = 0 } = {}) {
  const update = { $inc: { money: Math.trunc(net) }, $set: { guildId } };
  for (const [k, v] of Object.entries(inc)) update.$inc[`stats.${k}`] = v;
  if (wagered) update.$inc['stats.totalWagered'] = wagered;
  const maxEntries = Object.entries(max);
  if (maxEntries.length) update.$max = Object.fromEntries(maxEntries.map(([k, v]) => [`stats.${k}`, v]));

  const doc = await User.findOneAndUpdate({ userId }, update, { new: true }).lean();
  if (doc && doc.money < 0) {
    // 정상 흐름에서는 발생하지 않지만 방어적으로 0 보정
    await User.updateOne({ userId }, { $set: { money: 0 } });
    doc.money = 0;
  }
  return doc;
}

/** 파산 지원금 (조건 검사와 지급을 하나의 원자 연산으로) */
async function claimBailout(userId, guildId) {
  const { AMOUNT, THRESHOLD, COOLDOWN_MS } = config.BAILOUT;
  const now = new Date();
  return User.findOneAndUpdate(
    {
      userId,
      money: { $lt: THRESHOLD },
      $or: [{ lastBailoutAt: null }, { lastBailoutAt: { $lte: new Date(now - COOLDOWN_MS) } }],
    },
    { $inc: { money: AMOUNT }, $set: { lastBailoutAt: now, guildId } },
    { new: true },
  ).lean();
}

module.exports = { getAccount, settle, claimBailout };
