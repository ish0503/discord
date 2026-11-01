/**
 * 정산 금액 검증 규칙 (순수 로직).
 * 지갑을 바꾸기 전에 "이 게임 규칙상 나올 수 있는 지급액인가"를 확인한다.
 * 한도는 게임 규칙에서 나올 수 있는 최대 지급 배수(원금 포함)에 여유를 둔 값이다.
 */
const config = require('../config');

/** 게임별 최대 지급 배수 (베팅액 대비, 원금 포함) */
function maxMultiplier(game) {
  switch (game) {
    case 'slot':
      return Math.max(...Object.values(config.SLOT.PAYTABLE.triple), config.SLOT.PAYTABLE.twoCherry); // + 잭팟 풀은 별도 허용
    case 'crash':
      return config.CRASH.MAX_MULTIPLIER;
    case 'dice':
      return Math.max(...Object.values(config.DICE.PAYOUT));
    case 'baccarat':
      return Math.max(...Object.values(config.BACCARAT.PAYOUT));
    case 'blackjack':
      return 3; // 블랙잭 2.5배 · 보험 3배 (손·보험 합산해도 3배를 넘지 않음)
    case 'poker':
      return config.POKER.MAX_SEATS; // 한 핸드에서 모든 좌석의 스택을 따도 좌석 수 배
    case 'tournament':
      return config.TOURNAMENT.MAX_SEATS; // 상금 풀 ≤ 사람 참가비 합
    default:
      return null; // 알 수 없는 게임 → 호출자가 maxPayout을 명시해야 함
  }
}

/**
 * @param o { game, staked(에스크로 금액), payout, detail, maxPayout(호출자가 규칙으로 계산한 상한, 선택) }
 * @returns { ok:true } | { ok:false, reason }
 */
function validatePayout({ game, staked, payout, detail = null, maxPayout = null }) {
  if (typeof payout !== 'number' || !Number.isFinite(payout)) return { ok: false, reason: `지급액이 숫자가 아님: ${payout}` };
  if (payout < 0) return { ok: false, reason: `음수 지급액: ${payout}` };
  if (!Number.isSafeInteger(Math.floor(payout))) return { ok: false, reason: `지급액 범위 초과: ${payout}` };
  if (!Number.isSafeInteger(staked) || staked < 0) return { ok: false, reason: `에스크로 금액 이상: ${staked}` };
  let cap = maxPayout;
  if (cap === null || cap === undefined) {
    const m = maxMultiplier(game);
    if (m === null) return { ok: false, reason: `지급 상한을 알 수 없는 게임: ${game}` };
    cap = Math.floor(staked * m) + Math.max(0, Math.floor(detail?.jackpot ?? 0));
  }
  if (Math.floor(payout) > cap) return { ok: false, reason: `지급액 ${Math.floor(payout)} > 규칙상 상한 ${cap} (${game}, 베팅 ${staked})` };
  return { ok: true };
}

/**
 * 다인 정산 불변식 검사.
 * @param entries [{ userId, roundId, payout }]
 * @param expectTotal 지급 총액이 정확히 이 값이어야 함 (선택)
 * @param maxTotal 지급 총액 상한 (선택)
 */
function validateBatch(entries, { expectTotal = null, maxTotal = null } = {}) {
  if (!Array.isArray(entries) || !entries.length) return { ok: false, reason: '참가자 없음' };
  const ids = new Set();
  for (const e of entries) {
    if (!e.userId || !e.roundId) return { ok: false, reason: '참가자·판 ID 누락' };
    if (ids.has(e.roundId)) return { ok: false, reason: `중복된 판 ID: ${e.roundId}` };
    ids.add(e.roundId);
    if (!Number.isSafeInteger(e.payout) || e.payout < 0) return { ok: false, reason: `${e.userId} 지급액 이상: ${e.payout}` };
  }
  const total = entries.reduce((s, e) => s + e.payout, 0);
  if (expectTotal !== null && total !== expectTotal) return { ok: false, reason: `지급 총액 ${total} ≠ 기대값 ${expectTotal}` };
  if (maxTotal !== null && total > maxTotal) return { ok: false, reason: `지급 총액 ${total} > 상한 ${maxTotal}` };
  return { ok: true, total };
}

module.exports = { maxMultiplier, validatePayout, validateBatch };
