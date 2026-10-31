const { randomFloat } = require('../utils/rng');

/**
 * 폭발 배수 선 연산.
 * 사양: crashPoint = max(1.0, 0.97 / U)
 * U = 1 - randomFloat() ∈ (0, 1] 로 바꿔 0으로 나누기(Infinity)를 방지.
 * P(crashPoint ≥ x) = 0.97 / x → 어떤 탈출 타이밍이든 기대값 0.97 (하우스 엣지 3%)
 */
function generateCrashPoint(houseEdge = 0.03, max = 1000) {
  const u = 1 - randomFloat();
  const raw = (1 - houseEdge) / u;
  const floored = Math.floor(raw * 100) / 100;
  return Math.min(Math.max(1, floored), max);
}

/** 경과 시간(ms)에 따른 배수: m(t) = e^(k·t), 소수 둘째 자리 내림 */
function multiplierAt(elapsedMs, k) {
  return Math.floor(Math.exp(k * Math.max(0, elapsedMs)) * 100) / 100;
}

/** 배수 m에 도달하는 시간(ms) */
function timeToReach(m, k) {
  return Math.log(m) / k;
}

/** 순간 상승 속도 (배수/초) */
function speedAt(m, k) {
  return k * m * 1000;
}

module.exports = { generateCrashPoint, multiplierAt, timeToReach, speedAt };

/**
 * 자동 캐시아웃 판정 정책: 목표 배수 ≤ 폭발 배수이면 정확히 목표 배수로 성공.
 * (같은 배수에서 폭발과 겹치면 캐시아웃 우선) → P(성공) = 0.97 / 목표 → 기대값 0.97 유지
 */
function autoCashoutWins(crashPoint, target) {
  return target <= crashPoint;
}

module.exports.autoCashoutWins = autoCashoutWins;
