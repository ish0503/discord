/**
 * 암호학적 난수 생성기(CSPRNG) 래퍼.
 * Math.random()은 내부 상태 예측이 가능한 PRNG라 게임 결과에는 쓰지 않는다.
 */
const crypto = require('node:crypto');

const TWO_POW_48 = 2 ** 48;

/** [0, 1) 균등 실수 (48비트 정밀도) */
function randomFloat() {
  return crypto.randomBytes(6).readUIntBE(0, 6) / TWO_POW_48;
}

/** [min, max) 정수 */
function randomInt(min, max) {
  return crypto.randomInt(min, max);
}

/** Fisher–Yates 셔플 (제자리) */
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

/** [{ weight }] 배열에서 가중치 비례로 하나 선택 */
function weightedPick(items) {
  const total = items.reduce((sum, it) => sum + it.weight, 0);
  let roll = randomFloat() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll < 0) return item;
  }
  return items[items.length - 1];
}

module.exports = { randomFloat, randomInt, shuffle, weightedPick };
