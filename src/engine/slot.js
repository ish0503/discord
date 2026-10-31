const { weightedPick } = require('../utils/rng');

function spin(symbols) {
  return [0, 1, 2].map(() => weightedPick(symbols).emoji);
}

/** 결과 판정 → { multiplier, label } (multiplier = 원금 포함 총 지급 배수) */
function evaluate(reels, paytable) {
  const [a, b, c] = reels;
  if (a === b && b === c) {
    return { multiplier: paytable.triple[a] ?? 0, label: `${a}${a}${a} 트리플!` };
  }
  const cherries = reels.filter((r) => r === '🍒').length;
  if (cherries === 2) return { multiplier: paytable.twoCherry, label: '🍒🍒 체리 2개' };
  return { multiplier: 0, label: '꽝' };
}

/** 가중치·배당표로 계산한 정확한 이론 환수율 */
function theoreticalRTP(symbols, paytable) {
  const total = symbols.reduce((s, x) => s + x.weight, 0);
  const p = Object.fromEntries(symbols.map((x) => [x.emoji, x.weight / total]));
  let rtp = 0;
  for (const [emoji, prob] of Object.entries(p)) rtp += prob ** 3 * (paytable.triple[emoji] ?? 0);
  const pc = p['🍒'] ?? 0;
  rtp += 3 * pc * pc * (1 - pc) * paytable.twoCherry;
  return rtp;
}

module.exports = { spin, evaluate, theoreticalRTP };
