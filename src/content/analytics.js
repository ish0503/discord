/**
 * 통계 계산 (순수 로직). DB 집계 결과나 기록 배열을 받아 지표를 만든다.
 * RTP 정의: 총 지급액(원금 포함) ÷ 총 베팅액
 */

/**
 * 설계 RTP 대비 실제 RTP 편차 분석.
 * @param groups [{ game, sub, n, staked, payout, sumR, sumR2 }]  (r = 판별 payout/staked)
 * @param designFn (game, sub) → 설계 RTP | null
 */
function balanceReport(groups, designFn) {
  return groups.map((g) => {
    const design = designFn(g.game, g.sub);
    const actual = g.staked ? g.payout / g.staked : 0;
    const meanR = g.n ? g.sumR / g.n : 0;
    const variance = g.n > 1 ? Math.max(0, (g.sumR2 - g.n * meanR * meanR) / (g.n - 1)) : 0;
    const se = g.n ? Math.sqrt(variance / g.n) : 0;
    let verdict = '설계값 없음';
    let z = null;
    if (design !== null && design !== undefined) {
      if (g.n < 200) verdict = '표본 부족';
      else {
        z = se > 0 ? (meanR - design) / se : 0;
        verdict = Math.abs(z) > 3 ? '⚠️ 편차 큼' : '✅ 정상 범위';
      }
    }
    return { ...g, design, actual, meanR, se, z, verdict };
  });
}

/** 개인 기록 분석: logs는 오래된 → 최신 순 */
function personal(logs) {
  const settled = logs.filter((l) => l.status === 'settled');
  let cum = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let bestRun = 0;
  let run = 0;
  const curve = [];
  for (const l of settled) {
    cum += l.net;
    curve.push(cum);
    peak = Math.max(peak, cum);
    maxDrawdown = Math.max(maxDrawdown, peak - cum);
    run = Math.max(0, run + l.net); // 최고 수익 구간 (최대 부분합)
    bestRun = Math.max(bestRun, run);
  }
  const byGame = {};
  for (const l of settled) {
    const g = (byGame[l.game] ||= { rounds: 0, staked: 0, payout: 0 });
    g.rounds += 1;
    g.staked += l.staked;
    g.payout += l.payout;
  }
  const staked = settled.reduce((s, l) => s + l.staked, 0);
  return {
    rounds: settled.length,
    net: cum,
    staked,
    rtp: staked ? settled.reduce((s, l) => s + l.payout, 0) / staked : 0,
    avgBet: settled.length ? staked / settled.length : 0,
    maxDrawdown,
    bestRun,
    curve,
    byGame,
  };
}

/** 스파크라인 (값 배열 → ▁▂▃▄▅▆▇█) */
function sparkline(values, width = 30) {
  if (!values.length) return '';
  const step = Math.max(1, Math.ceil(values.length / width));
  const pts = [];
  for (let i = 0; i < values.length; i += step) pts.push(values[Math.min(values.length - 1, i + step - 1)]);
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const bars = '▁▂▃▄▅▆▇█';
  return pts.map((v) => bars[hi === lo ? 3 : Math.round(((v - lo) / (hi - lo)) * 7)]).join('');
}

module.exports = { balanceReport, personal, sparkline };
