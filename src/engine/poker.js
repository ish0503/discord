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
 * 몬테카를로 승률 추정 (다자간).
 * 자신은 상대 카드를 모르므로 상대 핸드·남은 보드를 무작위로 채워 반복 시뮬레이션한다.
 * (AI 추정 전용 난수 — 실제 카드 결과에는 쓰이지 않으므로 빠른 Math.random 사용)
 *
 * @returns {{ equity, strongMadeProb }}
 *   equity: 승률(공동 1위는 지분만큼), strongMadeProb: 리버까지 스트레이트 이상 메이드 확률
 */
function simulate(hole, board, opponents = 1, iterations = 300, rand = Math.random) {
  const known = new Set([...hole, ...board].map(cardKey));
  const pool = createDecks(1).filter((c) => !known.has(cardKey(c)));
  const need = 5 - board.length;
  const k = opponents * 2 + need;
  let equity = 0;
  let strong = 0;

  for (let it = 0; it < iterations; it++) {
    for (let j = 0; j < k; j++) {
      const r = j + Math.floor(rand() * (pool.length - j));
      [pool[j], pool[r]] = [pool[r], pool[j]];
    }
    const fullBoard = board.concat(pool.slice(opponents * 2, opponents * 2 + need));
    const mine = evaluate([...hole, ...fullBoard]).score;
    let best = 0;
    let tiedBest = 0;
    for (let o = 0; o < opponents; o++) {
      const sc = evaluate([pool[o * 2], pool[o * 2 + 1], ...fullBoard]).score;
      if (sc > best) {
        best = sc;
        tiedBest = 1;
      } else if (sc === best) tiedBest++;
    }
    if (mine > best) equity += 1;
    else if (mine === best) equity += 1 / (tiedBest + 1);
    if (Math.floor(mine / 15 ** 5) >= 4) strong++;
  }
  return { equity: equity / iterations, strongMadeProb: strong / iterations };
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

/** 봇의 현재 상황 분석 */
function analyze(hole, visibleBoard, opponents, iterations) {
  return {
    ...simulate(hole, visibleBoard, opponents, iterations),
    current: evaluate([...hole, ...visibleBoard]),
    scare: boardScare(visibleBoard),
  };
}

/**
 * 봇 성향. tight: 베팅에 필요한 상대 강도 배수, aggr: 공격 빈도, bluff: 블러핑 빈도, loose: 콜 관대함
 * 성향은 게임이 끝날 때 공개된다 (판독 학습용).
 */
const BOT_STYLES = {
  rock: { label: '🪨 바위 (타이트·패시브)', tight: 1.25, aggr: 0.6, bluff: 0.3, loose: -0.04 },
  shark: { label: '🦈 상어 (타이트·공격적)', tight: 1.1, aggr: 1.25, bluff: 0.9, loose: 0 },
  maniac: { label: '🎭 블러퍼 (루즈·공격적)', tight: 0.85, aggr: 1.45, bluff: 2.2, loose: 0.04 },
  station: { label: '📞 콜링스테이션 (루즈·패시브)', tight: 0.8, aggr: 0.45, bluff: 0.3, loose: 0.15 },
};

/**
 * 노리밋 봇 액션 결정.
 * strength = 승률 × 인원수 (1 = 테이블 평균). 상대가 많을수록 블러핑 빈도 감소.
 * 베팅 크기는 팟 대비 비율, 숏스택(10BB 이하)은 강한 패에서 올인.
 *
 * @param ctx { opponents, toCall, pot, stack, streetIn, currentBet, minRaise, minTo, maxTo, canRaise, bb, street }
 * @returns { type: 'fold'|'check'|'call'|'raise'|'allin', to?, kind }
 *   kind(의도): value(진짜 패) / semibluff(드로우) / bluff(뻥카) / slowplay / check / call / fold
 */
function botDecide(a, ctx, style, rand = Math.random) {
  const n = Math.max(1, ctx.opponents);
  const strength = a.equity * (n + 1);
  const postflop = ctx.street !== '프리플랍';
  const drawing = postflop && ctx.street !== '리버' && a.current.category < 4 && a.strongMadeProb >= 0.25;
  const bluffRate = ((0.07 + 0.15 * a.scare + (ctx.street === '리버' ? 0.05 : 0)) * style.bluff) / n;
  const kind = () => (strength >= 1 ? 'value' : drawing ? 'semibluff' : 'bluff');
  const sizeTo = (frac) => {
    const target = ctx.currentBet + Math.max(ctx.minRaise, Math.round((ctx.pot + ctx.toCall) * frac));
    return Math.min(Math.max(target, ctx.minTo), ctx.maxTo);
  };
  const raise = (frac) => ({ type: 'raise', to: sizeTo(frac), kind: kind() });
  const shove = () => ({ type: 'allin', kind: kind() });
  const shortStack = ctx.stack + ctx.streetIn <= ctx.bb * 10;

  if (ctx.canRaise && shortStack && strength >= 1.15 * style.tight) return shove();

  if (ctx.toCall === 0) {
    if (ctx.canRaise && strength >= 1.8 * style.tight) {
      return rand() < Math.min(0.95, 0.8 * style.aggr) ? raise(0.6 + rand() * 0.4) : { type: 'check', kind: 'slowplay' };
    }
    if (ctx.canRaise && strength >= 1.25 * style.tight && rand() < 0.5 * style.aggr) return raise(0.5);
    if (ctx.canRaise && drawing && rand() < 0.4 * style.aggr) return raise(0.55);
    if (ctx.canRaise && rand() < bluffRate) return raise(0.5);
    return { type: 'check', kind: 'check' };
  }

  const potOdds = ctx.toCall / (ctx.pot + ctx.toCall);
  if (ctx.canRaise && strength >= 2.2 * style.tight && rand() < 0.6 * style.aggr) {
    return strength >= 3 && rand() < 0.3 ? shove() : raise(0.8);
  }
  if (ctx.canRaise && drawing && rand() < 0.12 * style.aggr) return raise(0.7);
  if (ctx.canRaise && rand() < bluffRate * 0.3) return raise(0.7);
  // 스택 대비 큰 콜일수록 더 높은 승률 요구
  const commit = ctx.toCall / Math.max(1, ctx.stack + ctx.streetIn);
  if (a.equity >= potOdds + 0.03 - style.loose + commit * 0.15) return { type: 'call', kind: 'call' };
  return { type: 'fold', kind: 'fold' };
}

module.exports = {
  RANK_VALUE,
  CATEGORY_NAMES,
  STREETS,
  BOT_STYLES,
  evaluate,
  straightHigh,
  simulate,
  boardScare,
  analyze,
  botDecide,
};
