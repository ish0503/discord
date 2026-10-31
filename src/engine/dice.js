const { randomInt, randomFloat } = require('../utils/rng');

const CHOICES = ['lo', 'seven', 'hi'];
const CHOICE_LABEL = { lo: '🔽 Lo (2~6)', seven: '🎯 7', hi: '🔼 Hi (8~12)' };
/** 두 주사위 합의 정확한 확률 (36가지 경우) */
const PROBABILITY = { lo: 15 / 36, seven: 6 / 36, hi: 15 / 36 };

function rollPair() {
  return [randomInt(1, 7), randomInt(1, 7)];
}

function classify(sum) {
  if (sum === 7) return 'seven';
  return sum > 7 ? 'hi' : 'lo';
}

/**
 * 한 판 굴리기.
 * 연패 보정: lossStreak ≥ assist.STREAK 이고 결과가 패배면, REROLL_CHANCE 확률로 1회 재굴림.
 * 보정 중 승률 = p + (1 - p) · c · p
 */
function play(choice, { lossStreak = 0, assist } = {}) {
  let dice = rollPair();
  let result = classify(dice[0] + dice[1]);
  let assisted = false;

  if (
    result !== choice &&
    assist?.ENABLED &&
    lossStreak >= assist.STREAK &&
    randomFloat() < assist.REROLL_CHANCE
  ) {
    dice = rollPair();
    result = classify(dice[0] + dice[1]);
    assisted = true;
  }

  return { dice, sum: dice[0] + dice[1], result, win: result === choice, assisted };
}

module.exports = { CHOICES, CHOICE_LABEL, PROBABILITY, rollPair, classify, play };
