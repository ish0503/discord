/**
 * 텍사스 홀덤 핸드 평가기 + 딜러 AI.
 */
const { createDecks } = require('./cards');

const RANK_VALUE = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 11, Q: 12, K: 13, A: 14 };
const CATEGORY_NAMES = ['하이카드', '원페어', '투페어', '트리플', '스트레이트', '플러시', '풀하우스', '포카드', '스트레이트 플러시'];
const STREETS = { 3: '플롭', 4: '턴', 5: '리버' };

const cardKey = (c) => `${c.rank}${c.suit}`;

/** 5장 연속 값이 있으면 최고 값을, 없으면 0 (A-2-3-4-5 휠 포함) */
function straightHigh(values) {
  const set = new Set(values);
  if (set.has(14)) set.add(1);
  for (let hi = 14; hi >= 5; hi--) {
    let ok = true;
    for (let k = 0; k < 5; k++) {
      if (!set.has(hi - k)) {
        ok = false;
        break;
      }
    }
    if (ok) return hi;
  }
  return 0;
}

function pack(category, tiebreak) {
  let score = category;
  for (let i = 0; i < 5; i++) score = score * 15 + (tiebreak[i] || 0);
  let name = CATEGORY_NAMES[category];
  if (category === 8 && tiebreak[0] === 14) name = '로열 스트레이트 플러시';
  return { score, category, name };
}

/** 5~7장 중 최고 족보 → { score, category, name } (score가 클수록 강함) */
function evaluate(cards) {
  const vals = cards.map((c) => RANK_VALUE[c.rank]);
  const bySuit = {};
  cards.forEach((c, i) => (bySuit[c.suit] ||= []).push(vals[i]));

  let flushVals = null;
  for (const s of Object.keys(bySuit)) {
    if (bySuit[s].length >= 5) flushVals = bySuit[s].sort((a, b) => b - a);
  }
  if (flushVals) {
    const sf = straightHigh(flushVals);
    if (sf) return pack(8, [sf]);
  }

  const counts = new Map();
  for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const distinct = [...counts.keys()].sort((a, b) => b - a);
  const kickers = (exclude, n) => distinct.filter((v) => !exclude.includes(v)).slice(0, n);

  const [g0, g1] = groups;
  if (g0[1] === 4) return pack(7, [g0[0], ...kickers([g0[0]], 1)]);
  if (g0[1] === 3 && g1 && g1[1] >= 2) return pack(6, [g0[0], g1[0]]);
  if (flushVals) return pack(5, flushVals.slice(0, 5));
  const st = straightHigh(distinct);
  if (st) return pack(4, [st]);
  if (g0[1] === 3) return pack(3, [g0[0], ...kickers([g0[0]], 2)]);
  if (g0[1] === 2 && g1 && g1[1] === 2) return pack(2, [g0[0], g1[0], ...kickers([g0[0], g1[0]], 1)]);
  if (g0[1] === 2) return pack(1, [g0[0], ...kickers([g0[0]], 3)]);
  return pack(0, distinct.slice(0, 5));
}

/**
 * 딜러 관점 몬테카를로 시뮬레이션.
 * 딜러는 유저 카드를 모르므로 상대 핸드·남은 보드를 무작위로 채워 승률을 추정한다.
 * (AI 추정 전용 난수 — 실제 카드 결과에는 쓰이지 않으므로 빠른 Math.random 사용)
 *
 * @returns {{ equity, strongMadeProb }}
 *   equity: 현재 승률(무승부 0.5), strongMadeProb: 리버까지 스트레이트 이상 메이드 확률
 */
function simulate(dealerHole, board, iterations = 400, rand = Math.random) {
  const known = new Set([...dealerHole, ...board].map(cardKey));
  const pool = createDecks(1).filter((c) => !known.has(cardKey(c)));
  const need = 5 - board.length;
  const k = 2 + need;
  let win = 0;
  let tie = 0;
  let strong = 0;

  for (let it = 0; it < iterations; it++) {
    for (let j = 0; j < k; j++) {
      const r = j + Math.floor(rand() * (pool.length - j));
      [pool[j], pool[r]] = [pool[r], pool[j]];
    }
    const fullBoard = board.concat(pool.slice(2, 2 + need));
    const d = evaluate([...dealerHole, ...fullBoard]);
    const o = evaluate([pool[0], pool[1], ...fullBoard]);
    if (d.score > o.score) win++;
    else if (d.score === o.score) tie++;
    if (d.category >= 4) strong++;
  }
  return { equity: (win + tie / 2) / iterations, strongMadeProb: strong / iterations };
}

/** 보드 위험도 0~1 (플러시·스트레이트·페어 가능성) — 블러핑 빈도에 반영 */
function boardScare(board) {
  let scare = 0;
  const suitCounts = {};
  for (const c of board) suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1;
  const maxSuit = Math.max(...Object.values(suitCounts));
  if (maxSuit >= 3) scare += 0.45;
  else if (maxSuit === 2 && board.length === 3) scare += 0.1;

  const vals = new Set(board.map((c) => RANK_VALUE[c.rank]));
  if (vals.has(14)) vals.add(1);
  for (let lo = 1; lo <= 10; lo++) {
    let n = 0;
    for (let v = lo; v < lo + 5; v++) if (vals.has(v)) n++;
    if (n >= 3) {
      scare += 0.3;
      break;
    }
  }
  if (new Set(board.map((c) => c.rank)).size < board.length) scare += 0.2;
  return Math.min(1, scare);
}

/** 딜러의 현재 상황 분석 */
function analyze(dealerHole, visibleBoard, iterations) {
  const sim = simulate(dealerHole, visibleBoard, iterations);
  return {
    ...sim,
    current: evaluate([...dealerHole, ...visibleBoard]),
    scare: boardScare(visibleBoard),
  };
}

/**
 * 딜러 선(先) 액션.
 * kind: value(진짜 패) / semibluff(드로우 기반) / bluff(뻥카) / slowplay / check
 */
function decideOpen(a, street, rand = Math.random) {
  if (a.equity >= 0.7) return rand() < 0.8 ? { act: 'bet', kind: 'value' } : { act: 'check', kind: 'slowplay' };
  if (a.equity >= 0.5) return rand() < 0.55 ? { act: 'bet', kind: 'value' } : { act: 'check', kind: 'check' };
  const drawing = street !== '리버' && a.current.category < 4 && a.strongMadeProb >= 0.25;
  if (drawing && rand() < 0.5) return { act: 'bet', kind: 'semibluff' };
  const bluffRate = 0.1 + 0.2 * a.scare + (street === '리버' ? 0.08 : 0);
  if (rand() < bluffRate) return { act: 'bet', kind: 'bluff' };
  return { act: 'check', kind: 'check' };
}

/** 유저 레이즈에 대한 딜러 응답: 'call' | 'fold' */
function decideFacingRaise(a, toCall, pot, rand = Math.random) {
  const potOdds = toCall / (pot + toCall);
  if (a.equity >= 0.6) return 'call';
  if (a.equity >= potOdds + 0.05) return 'call';
  if (rand() < 0.1) return 'call'; // 히어로 콜
  return 'fold';
}

module.exports = {
  RANK_VALUE,
  CATEGORY_NAMES,
  STREETS,
  evaluate,
  straightHigh,
  simulate,
  boardScare,
  analyze,
  decideOpen,
  decideFacingRaise,
};
