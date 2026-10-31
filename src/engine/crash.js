const { randomFloat } = require('../utils/rng');

/**
 * 그래프(Crash) 엔진 — 배수는 START(기본 0.80x)에서 출발한다.
 *
 * 왜 1.00x가 아니라 0.80x에서 시작하나?
 *   1.00x에서 시작하면 "시작하자마자 탈출"이 원금 보존 + 소액 이익이 되어,
 *   위험 없이 승리 횟수(미션·업적·연승)를 쌓거나 체감 환수율을 부풀릴 수 있다.
 *   0.80x에서 시작하면 본전(1.00x)까지 약 2.2초 동안은 탈출해도 손해이므로
 *   "바로 탈출"은 확정 손실이 된다.
 *
 * 폭발 배수 분포:
 *   U = 1 - randomFloat() ∈ (0, 1],  raw = (1 − edge) / U
 *   - raw ≥ 1 이면 폭발 = raw  →  x ≥ 1 에서 P(폭발 ≥ x) = (1 − edge) / x  (기존과 동일)
 *     → 1.00x 이상 어떤 목표든 기대값 = 1 − edge (하우스 엣지 3%)
 *   - raw < 1 (확률 = edge) 이면 본전 아래 [START, 1.00) 구간에 고르게 폭발
 *     → 1.00x 미만 탈출의 기대값은 항상 1 − edge 보다 낮음 (조기 탈출이 유리할 수 없음)
 */
function generateCrashPoint(houseEdge = 0.03, max = 1000, start = 1) {
  const u = 1 - randomFloat();
  const raw = (1 - houseEdge) / u;
  if (raw >= 1) return Math.min(Math.floor(raw * 100) / 100, max);
  if (start >= 1) return 1;
  const t = (raw - (1 - houseEdge)) / houseEdge; // [0, 1)
  return Math.max(start, Math.floor((start + t * (1 - start)) * 100) / 100);
}

/** 경과 시간(ms)에 따른 배수: m(t) = start · e^(k·t), 소수 둘째 자리 내림 */
function multiplierAt(elapsedMs, k, start = 1) {
  return Math.floor(start * Math.exp(k * Math.max(0, elapsedMs)) * 100 + 1e-9) / 100;
}

/** 배수 m에 도달하는 시간(ms) */
function timeToReach(m, k, start = 1) {
  return Math.max(0, Math.log(m / start) / k);
}

/** 순간 상승 속도 (배수/초) */
function speedAt(m, k) {
  return k * m * 1000;
}

/**
 * 자동 캐시아웃 판정 정책: 목표 배수 ≤ 폭발 배수이면 정확히 목표 배수로 성공.
 * (같은 배수에서 폭발과 겹치면 캐시아웃 우선) → P(성공) = 0.97 / 목표 → 기대값 0.97 유지
 */
function autoCashoutWins(crashPoint, target) {
  return target <= crashPoint;
}

module.exports = { generateCrashPoint, multiplierAt, timeToReach, speedAt, autoCashoutWins };
