/**
 * 게임 엔진 검증 테스트 (discord.js·MongoDB 없이 실행 가능)
 *   npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const { Shoe, hiLoValue, createDecks } = require('../src/engine/cards');
const bj = require('../src/engine/blackjack');
const slot = require('../src/engine/slot');
const crash = require('../src/engine/crash');
const dice = require('../src/engine/dice');
const poker = require('../src/engine/poker');
const { PokerTable } = require('../src/engine/pokerTable');
const { BlackjackRound } = require('../src/engine/blackjackTable');
const { shuffle } = require('../src/utils/rng');
const bac = require('../src/engine/baccarat');
const { LiveMessage } = require('../src/utils/liveMessage');

const C = (s) => {
  // '10h' / 'Ah' / 'Ks' → card
  const suitMap = { s: '♠', h: '♥', d: '♦', c: '♣' };
  return { rank: s.slice(0, -1), suit: suitMap[s.slice(-1)] };
};
const H = (str) => str.split(' ').map(C);

test('슈: 6덱 312장, 하이-로우 합계 0, 재셔플 기준', () => {
  const shoe = new Shoe({ decks: 6, reshuffleAt: 60 });
  assert.equal(shoe.remaining, 312);
  const sum = createDecks(6).reduce((s, c) => s + hiLoValue(c), 0);
  assert.equal(sum, 0, '균형 카운팅이므로 전체 합은 0');
  while (shoe.remaining > 60) shoe.draw();
  assert.equal(shoe.prepareRound(), true);
  assert.equal(shoe.remaining, 312);
  assert.equal(shoe.runningCount, 0);
});

test('슈: True Count = RC / (남은 카드/52), 숨긴 카드는 카운트 제외', () => {
  const shoe = new Shoe({ decks: 6, reshuffleAt: 60 });
  shoe.cards = createDecks(2); // 104장
  shoe.runningCount = 5;
  assert.equal(shoe.trueCount, 2.5);
  const before = shoe.runningCount;
  shoe.cards.push(C('5h'));
  shoe.draw({ counted: false });
  assert.equal(shoe.runningCount, before);
});

test('블랙잭: 핸드 계산·정산', () => {
  assert.deepEqual(bj.handValue(H('Ah 6d')), { total: 17, soft: true });
  assert.deepEqual(bj.handValue(H('Ah 6d 10s')), { total: 17, soft: false });
  assert.equal(bj.dealerShouldHit(H('Ah 6d'), false), false);
  assert.equal(bj.dealerShouldHit(H('Ah 6d'), true), true);
  assert.equal(bj.settle(H('Ah Ks'), H('9h 8d'), 1000).net, 1500);
  assert.equal(bj.settle(H('Ah Ks'), H('As Qd'), 1000).net, 0);
  assert.equal(bj.settle(H('10h 5d 9c'), H('9h 8d'), 1000).net, -1000);
  assert.equal(bj.settle(H('10h 8d'), H('10s 6d 9c'), 1000).net, 1000);
});

test('슬롯: 이론 RTP 90~97% 범위, 몬테카를로 일치', () => {
  const { SYMBOLS, PAYTABLE } = config.SLOT;
  const rtp = slot.theoreticalRTP(SYMBOLS, PAYTABLE);
  assert.ok(rtp > 0.9 && rtp < 0.97, `RTP=${rtp}`);
  let paid = 0;
  const N = 200_000;
  for (let i = 0; i < N; i++) paid += slot.evaluate(slot.spin(SYMBOLS), PAYTABLE).multiplier;
  assert.ok(Math.abs(paid / N - rtp) < 0.03, `sim=${paid / N}, theory=${rtp}`);
});

test('블랙잭 테이블: 다인 라운드 진행·판정 불변식 (2,000라운드)', () => {
  const shoe = new Shoe({ decks: 6, reshuffleAt: 60 });
  for (let g = 0; g < 2000; g++) {
    shoe.prepareRound();
    const n = 1 + (g % 5);
    const r = new BlackjackRound(shoe, Array.from({ length: n }, (_, k) => ({ id: `p${k}`, bet: 1000 })));
    r.deal();
    let guard = 0;
    while (r.actor !== null) {
      const i = r.actor;
      const total = bj.handValue(r.hands[i].cards).total;
      const act = r.canDouble(i) && (total === 10 || total === 11) ? 'double' : total < 17 ? 'hit' : 'stand';
      r.act(i, act);
      assert.ok(++guard < 100);
    }
    r.revealHole();
    while (r.dealerShouldDraw) r.dealerDraw();
    const res = r.results();
    assert.equal(r.holeHidden, false, '라운드 종료 시 홀카드는 공개·카운트되어야 함');
    res.forEach((x, k) => {
      const h = r.hands[k];
      assert.ok(x.payout >= 0 && x.payout <= h.bet * 2.5, `payout ${x.payout}`);
      if (h.status === 'bust') assert.equal(x.payout, 0);
      if (h.doubled) assert.equal(h.bet, 2000);
    });
    if (r.hands.every((h) => h.status === 'bust')) assert.equal(r.dealer.length, 2, '전원 버스트면 딜러는 드로우하지 않음');
  }
});

test('블랙잭 테이블: 딜러 블랙잭 피크 & 순서 위반 차단', () => {
  const shoe = new Shoe({ decks: 1, reshuffleAt: 0 });
  // pop 순서: p0, p1, 딜러업, p0, p1, 홀
  shoe.cards = H('Kh 9s Ac As 5d Qs').reverse(); // p0=K+A, p1=9+5, 딜러=A+Q
  shoe.runningCount = 0;
  const r = new BlackjackRound(shoe, [{ id: 'a', bet: 1000 }, { id: 'b', bet: 1000 }]);
  r.deal();
  assert.equal(r.dealerBlackjack, true);
  assert.equal(r.actor, null);
  const [a, b] = r.results();
  assert.equal(a.payout, 1000, 'A+K 블랙잭 vs 딜러 블랙잭 = 푸시');
  assert.equal(b.payout, 0);

  shoe.cards = H('9h 8s 6c 2c 3d Ks').reverse();
  const r2 = new BlackjackRound(shoe, [{ id: 'a', bet: 1000 }, { id: 'b', bet: 1000 }]);
  r2.deal();
  assert.equal(r2.actor, 0);
  assert.throws(() => r2.act(1, 'stand'));
  const rcBeforeReveal = shoe.runningCount;
  r2.act(0, 'stand');
  r2.act(1, 'stand');
  r2.revealHole();
  assert.equal(shoe.runningCount, rcBeforeReveal - 1, 'K 홀카드 공개 시 -1');
});

test('그래프: P(crash ≥ x) ≈ 0.97/x, 1 미만 없음', () => {
  const N = 200_000;
  let ge2 = 0;
  let ge5 = 0;
  for (let i = 0; i < N; i++) {
    const cp = crash.generateCrashPoint(0.03, 1000);
    assert.ok(cp >= 1 && Number.isFinite(cp));
    if (cp >= 2) ge2++;
    if (cp >= 5) ge5++;
  }
  assert.ok(Math.abs(ge2 / N - 0.485) < 0.01, `P(≥2)=${ge2 / N}`);
  assert.ok(Math.abs(ge5 / N - 0.194) < 0.01, `P(≥5)=${ge5 / N}`);
  const k = config.CRASH.GROWTH_PER_MS;
  assert.equal(crash.multiplierAt(crash.timeToReach(2, k) + 1, k), 2);
});

test('주사위: 합 분포 확률 & 연패 보정 효과', () => {
  const N = 300_000;
  const cnt = { lo: 0, seven: 0, hi: 0 };
  for (let i = 0; i < N; i++) {
    const [a, b] = dice.rollPair();
    cnt[dice.classify(a + b)]++;
  }
  for (const k of dice.CHOICES) assert.ok(Math.abs(cnt[k] / N - dice.PROBABILITY[k]) < 0.005);

  const assist = config.DICE.ASSIST;
  let wins = 0;
  for (let i = 0; i < N; i++) if (dice.play('hi', { lossStreak: 10, assist }).win) wins++;
  const p = 15 / 36;
  const expected = p + (1 - p) * assist.REROLL_CHANCE * p;
  assert.ok(Math.abs(wins / N - expected) < 0.005, `assisted=${wins / N}, expected=${expected}`);
});

test('포커: 족보 판정', () => {
  const e = (s) => poker.evaluate(H(s));
  assert.equal(e('Ah Kh Qh Jh 10h 2c 3d').name, '로열 스트레이트 플러시');
  assert.equal(e('Ah 2d 3c 4s 5h 9c Kd').name, '스트레이트');
  assert.equal(e('Ah 2d 3c 4s 5h 9c Kd').score < e('2d 3c 4s 5h 6h 9c Kd').score, true, '휠 < 6하이');
  assert.equal(e('9h 9d 9c 5s 5h 5c Kd').name, '풀하우스');
  assert.equal(e('2h 2d 7c 7s Kh Kc 9d').name, '투페어');
  assert.ok(e('Kh Kc 7c 7s 2h 2d Ad').score > e('Kh Kc 7c 7s 2h 2d Qd').score, '키커 비교');
  assert.equal(e('Ah 3h 7h 9h Qh 2c 3d').name, '플러시');
  assert.equal(e('8s 8h 8d 8c 2h 3c 4d').name, '포카드');
});

test('포커: 몬테카를로 승률이 상식 범위 (다자간일수록 감소)', () => {
  const aa1 = poker.simulate(H('Ah As'), H('2c 7d 9s'), 1, 2000).equity;
  const aa5 = poker.simulate(H('Ah As'), H('2c 7d 9s'), 5, 2000).equity;
  const junk = poker.simulate(H('2h 3d'), H('Kc Qd 9s'), 1, 2000).equity;
  assert.ok(aa1 > 0.75, `AA vs 1 = ${aa1}`);
  assert.ok(aa5 < aa1 && aa5 > 0.4, `AA vs 5 = ${aa5}`);
  assert.ok(junk < 0.3, `23o = ${junk}`);
});

test('포커 테이블: 봇끼리 다자간 1,000판 — 칩 보존 & 최대 손실 한도', () => {
  const styles = Object.values(poker.BOT_STYLES);
  const ante = 100;
  const exposure = PokerTable.maxExposure(3, 2);
  for (let g = 0; g < 1000; g++) {
    const n = 2 + (g % 7); // 2~8좌석
    const t = new PokerTable({ ante, maxBetsPerStreet: 3, riverMultiplier: 2 });
    for (let i = 0; i < n; i++) t.addSeat({ id: `b${i}`, style: styles[i % styles.length] });
    t.start(shuffle(createDecks(1)), g);
    let guard = 0;
    while (!t.finished) {
      const idx = t.actor;
      const lg = t.legal(idx);
      const a = poker.analyze(t.seats[idx].hole, t.visibleBoard, t.activeIndexes.length - 1, 30);
      const d = poker.botDecide(a, { opponents: t.activeIndexes.length - 1, toCall: lg.toCall, pot: t.pot, canRaise: lg.canRaise, street: t.street }, t.seats[idx].style);
      t.act(idx, d.act);
      assert.ok(++guard < 200, '무한 루프');
    }
    const sum = t.results.reduce((s, r) => s + r.net, 0);
    assert.equal(sum, 0, '팟은 정확히 분배되어야 함');
    for (const r of t.results) assert.ok(-r.net <= ante * exposure, `손실 ${-r.net} > 한도`);
    assert.ok(t.results.some((r) => r.winner));
  }
});

test('포커 테이블: 순서 위반·종료 후 액션 차단, 폴드 승리', () => {
  const t = new PokerTable({ ante: 100 });
  ['a', 'b', 'c'].forEach((id) => t.addSeat({ id }));
  t.start(shuffle(createDecks(1)), 0); // 버튼 0 → 1, 2, 0 순서
  assert.equal(t.actor, 1);
  assert.throws(() => t.act(0, 'check'));
  t.act(1, 'raise'); // 베팅 100
  assert.deepEqual(t.pending, [2, 0]);
  t.act(2, 'fold');
  const ev = t.act(0, 'fold');
  assert.equal(ev.type, 'end');
  assert.equal(t.results[1].net, 300 + 100 - 200); // 팟 400 - 자기 투입 200
  assert.throws(() => t.act(1, 'check'));
});

test('바카라: 서드 카드 규칙 & 알려진 확률 (B 45.9% / P 44.6% / T 9.5%)', () => {
  assert.equal(bac.bankerDraws(3, C('8h')), false);
  assert.equal(bac.bankerDraws(6, C('7h')), true);
  assert.equal(bac.bankerDraws(6, null), false);
  const shoe = new Shoe({ decks: 8, reshuffleAt: 52 });
  const cnt = { player: 0, banker: 0, tie: 0 };
  const N = 200_000;
  for (let i = 0; i < N; i++) {
    shoe.prepareRound();
    cnt[bac.playRound(() => shoe.draw()).winner]++;
  }
  assert.ok(Math.abs(cnt.banker / N - 0.4586) < 0.006, `B=${cnt.banker / N}`);
  assert.ok(Math.abs(cnt.player / N - 0.4462) < 0.006, `P=${cnt.player / N}`);
  assert.ok(Math.abs(cnt.tie / N - 0.0952) < 0.004, `T=${cnt.tie / N}`);
});

test('LiveMessage: 밀린 프레임은 버리고 final이 마지막에 반영', async () => {
  const sent = [];
  const live = new LiveMessage(async (p) => {
    await new Promise((r) => setTimeout(r, 20));
    sent.push(p);
  });
  for (let i = 0; i < 10; i++) live.push(i);
  await live.final('END');
  assert.equal(sent.at(-1), 'END');
  assert.ok(sent.length <= 3, `sent=${sent}`);
});
