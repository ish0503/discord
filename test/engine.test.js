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
const { HoldemHand } = require('../src/engine/holdem');
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

function rigShoe(cards) {
  const shoe = new Shoe({ decks: 1, reshuffleAt: 0 });
  shoe.cards = H(cards).reverse();
  shoe.runningCount = 0;
  return shoe;
}

test('블랙잭 테이블: 다인 라운드 불변식 (스플릿·더블·보험 포함 3,000라운드)', () => {
  const shoe = new Shoe({ decks: 6, reshuffleAt: 60 });
  for (let g = 0; g < 3000; g++) {
    shoe.prepareRound();
    const n = 1 + (g % 5);
    const r = new BlackjackRound(shoe, Array.from({ length: n }, (_, k) => ({ id: `p${k}`, name: `p${k}`, bet: 1000 })));
    r.deal();
    if (r.phase === 'insurance') r.players.forEach((p, k) => r.decideInsurance(p.id, k % 2 === 0));
    let guard = 0;
    while (r.actor !== null) {
      const i = r.actor;
      const total = bj.handValue(r.hands[i].cards).total;
      const act = r.canSplit(i) ? 'split' : r.canDouble(i) && (total === 10 || total === 11) ? 'double' : total < 17 ? 'hit' : 'stand';
      r.act(i, act);
      assert.ok(++guard < 200);
    }
    r.revealHole();
    while (r.dealerShouldDraw) r.dealerDraw();
    const res = r.results();
    for (const p of res.players) {
      assert.ok(p.payout >= 0 && p.payout <= p.staked * 3, `payout ${p.payout} staked ${p.staked}`);
      assert.ok(p.hands <= 4, '스플릿 최대 4손');
    }
    r.hands.forEach((h, k) => {
      if (h.status === 'bust') assert.equal(res.hands[k].payout, 0);
      if (h.splitAces) assert.equal(h.cards.length, 2, '스플릿 에이스는 한 장만');
    });
  }
});

test('블랙잭 테이블: 딜러 블랙잭 피크(10 업카드) & 순서 위반 차단', () => {
  const r = new BlackjackRound(rigShoe('Kh 9s Kc As 5d Ac'), [{ id: 'a', bet: 1000 }, { id: 'b', bet: 1000 }]);
  r.deal(); // a=K+A(BJ), b=9+5, 딜러 K+A
  assert.equal(r.dealerBlackjack, true);
  assert.equal(r.actor, null);
  const { players } = r.results();
  assert.equal(players[0].payout, 1000, 'BJ vs 딜러 BJ = 푸시');
  assert.equal(players[1].payout, 0);

  const r2 = new BlackjackRound(rigShoe('9h 8s 6c 2c 3d Ks'), [{ id: 'a', bet: 1000 }, { id: 'b', bet: 1000 }]);
  r2.deal();
  assert.equal(r2.phase, 'play');
  assert.throws(() => r2.act(1, 'stand'));
});

test('블랙잭 테이블: 보험 — 딜러 블랙잭이면 2:1 지급', () => {
  const r = new BlackjackRound(rigShoe('9h Ac 9c Kd'), [{ id: 'a', bet: 1000 }]);
  r.deal(); // a=9+9, 딜러 A+K
  assert.equal(r.phase, 'insurance');
  assert.equal(r.actor, null, '보험 단계에서는 아직 행동 불가');
  r.decideInsurance('a', true);
  assert.equal(r.dealerBlackjack, true);
  const p = r.results().players[0];
  assert.equal(p.staked, 1500);
  assert.equal(p.payout, 1500, '본 베팅 1000 잃고 보험 500 → 1500 지급 = 본전');

  const r2 = new BlackjackRound(rigShoe('9h Ac 9c 7d'), [{ id: 'a', bet: 1000 }]);
  r2.deal();
  r2.decideInsurance('a', true);
  assert.equal(r2.dealerBlackjack, false);
  assert.equal(r2.phase, 'play');
  r2.act(0, 'stand'); // 18 vs 딜러 A+7=18 → 푸시
  r2.revealHole();
  while (r2.dealerShouldDraw) r2.dealerDraw();
  const p2 = r2.results().players[0];
  assert.equal(p2.staked, 1500);
  assert.equal(p2.payout, 1000, '보험 500은 잃고 본 베팅 푸시');
});

test('블랙잭 테이블: 스플릿 — 에이스 한 장, 스플릿 후 21은 블랙잭 아님', () => {
  // a=A+A, 딜러 9 업 / 7 홀 → 스플릿 후 각 손에 K, 5
  const r = new BlackjackRound(rigShoe('As 9c Ad 7h Ks 5c 2d'), [{ id: 'a', bet: 1000 }]);
  r.deal(); // 딜러 9+7=16 → 2 받고 18
  assert.equal(r.canSplit(0), true);
  assert.equal(r.extraStake(0, 'split'), 1000);
  r.act(0, 'split');
  assert.equal(r.hands.length, 2);
  assert.deepEqual(r.hands.map((h) => h.status), ['stand', 'stand']);
  assert.equal(r.actor, null);
  r.revealHole();
  while (r.dealerShouldDraw) r.dealerDraw();
  const { hands, players } = r.results();
  assert.equal(hands[0].outcome, 'win', 'A+K=21 이지만 블랙잭 3:2가 아닌 1:1');
  assert.equal(hands[0].payout, 2000);
  assert.equal(players[0].staked, 2000);
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

function botCtx(h, idx) {
  const lg = h.legal(idx);
  const s = h.seats[idx];
  return { opponents: h.liveIndexes.length - 1, toCall: lg.toCall, pot: lg.pot, stack: s.stack, streetIn: s.streetIn, currentBet: h.currentBet, minRaise: h.minRaise, minTo: lg.minTo, maxTo: lg.maxTo, canRaise: lg.canRaise, bb: h.bb, street: h.streetName };
}

test('홀덤 NL: 봇끼리 2,000핸드 — 칩 보존·음수 스택 없음·종료 보장', () => {
  const styles = Object.values(poker.BOT_STYLES);
  for (let g = 0; g < 2000; g++) {
    const n = 2 + (g % 7);
    const seats = Array.from({ length: n }, (_, k) => ({ id: `b${k}`, stack: [200, 1000, 3000, 50, 1500][(g + k) % 5], style: styles[k % 4] }));
    const before = seats.reduce((s, x) => s + x.stack, 0);
    const h = new HoldemHand(seats, { button: g, sb: 10, bb: 20, ante: g % 3 === 0 ? 2 : 0 });
    h.start(shuffle(createDecks(1)));
    let guard = 0;
    while (!h.finished) {
      const idx = h.actor;
      const a = poker.analyze(h.seats[idx].hole, h.visibleBoard, h.liveIndexes.length - 1, 20);
      h.act(idx, poker.botDecide(a, botCtx(h, idx), h.seats[idx].style));
      assert.ok(++guard < 500, '무한 루프');
      for (const s of h.seats) assert.ok(s.stack >= 0, '음수 스택');
    }
    const after = h.results.reduce((s, r) => s + r.finalStack, 0);
    assert.equal(after, before, `칩 보존 실패 g=${g}`);
    assert.equal(h.results.reduce((s, r) => s + r.net, 0), 0);
  }
});

test('홀덤 NL: 사이드팟 분배 (숏스택 올인 + 두 명 콜)', () => {
  // A 100, B 300, C 300 → A 올인, B 올인 300, C 콜 → 메인 300 (A,B,C) / 사이드 400 (B,C)
  const seats = [{ id: 'A', stack: 100, folded: false, totalIn: 100 }, { id: 'B', stack: 0, folded: false, totalIn: 300 }, { id: 'C', stack: 0, folded: false, totalIn: 300 }];
  const pots = HoldemHand.buildPots(seats);
  assert.deepEqual(pots.map((p) => [p.amount, p.eligible]), [[300, [0, 1, 2]], [400, [1, 2]]]);
  // 폴드한 사람 돈은 데드머니로 포함
  const pots2 = HoldemHand.buildPots([{ totalIn: 50, folded: true }, { totalIn: 200, folded: false }, { totalIn: 120, folded: false }]);
  assert.equal(pots2.reduce((s, p) => s + p.amount, 0), 370);
  assert.deepEqual(pots2.at(-1).eligible, [1], '언콜드 80은 본인에게만');
});

test('홀덤 NL: 실제 핸드 — 숏스택 올인 승리 시 메인팟만 획득', () => {
  const deck = [];
  // pop 순서: A홀2, B홀2, C홀2, 보드5  (A=AA, B=KK, C=QQ, 보드 무관)
  const order = H('As Ah Ks Kh Qs Qh 2c 7d 9s 3h 4c');
  for (let k = order.length - 1; k >= 0; k--) deck.push(order[k]);
  const h = new HoldemHand([{ id: 'A', stack: 100 }, { id: 'B', stack: 300 }, { id: 'C', stack: 300 }], { button: 2, sb: 5, bb: 10 });
  h.start(deck); // 버튼 C → SB A, BB B, 첫 행동 C
  assert.equal(h.actor, 2);
  h.act(2, { type: 'call' });
  h.act(0, { type: 'allin' });
  h.act(1, { type: 'allin' });
  h.act(2, { type: 'call' });
  assert.equal(h.finished, true);
  assert.equal(h.endReason, 'showdown');
  assert.equal(h.results[0].finalStack, 300, 'A(AA)는 메인팟 300');
  assert.equal(h.results[1].finalStack, 400, 'B(KK)는 사이드팟 400');
  assert.equal(h.results[2].finalStack, 0);
});

test('홀덤 NL: 최소 레이즈와 짧은 올인 규칙', () => {
  const deck = shuffle(createDecks(1));
  const h = new HoldemHand([{ id: 'A', stack: 1000 }, { id: 'B', stack: 1000 }, { id: 'C', stack: 130 }], { button: 0, sb: 10, bb: 20 });
  h.start(deck); // 버튼 A, SB B, BB C, 첫 행동 A
  assert.equal(h.legal(0).minTo, 40);
  h.act(0, { type: 'raise', to: 100 }); // 80 레이즈
  assert.equal(h.legal(1).minTo, 180, '다음 최소 레이즈 = 100 + 80');
  h.act(1, { type: 'call' });
  h.act(2, { type: 'allin' }); // C 130까지 = 30 짧은 레이즈
  assert.equal(h.currentBet, 130);
  assert.equal(h.legal(0).canRaise, false, '이미 행동한 A는 재레이즈 불가');
  assert.equal(h.legal(0).toCall, 30);
});

test('홀덤 NL: 헤즈업 블라인드 순서', () => {
  const h = new HoldemHand([{ id: 'A', stack: 500 }, { id: 'B', stack: 500 }], { button: 0, sb: 5, bb: 10 });
  h.start(shuffle(createDecks(1)));
  assert.equal(h.sbIndex, 0, '헤즈업은 버튼이 SB');
  assert.equal(h.actor, 0, '프리플랍은 SB(버튼) 먼저');
  h.act(0, { type: 'call' });
  h.act(1, { type: 'check' });
  assert.equal(h.streetName, '플롭');
  assert.equal(h.actor, 1, '포스트플랍은 BB 먼저');
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

// ───────────────────── P1~P3 순수 로직 ─────────────────────
const missions = require('../src/content/missions');
const achievements = require('../src/content/achievements');
const cosmetics = require('../src/content/cosmetics');
const analytics = require('../src/content/analytics');
const time = require('../src/content/time');

test('그래프 자동 캐시아웃: 목표 x의 성공 확률 ≈ 0.97/x (RTP 97% 유지)', () => {
  const N = 200_000;
  for (const target of [1.5, 2, 5]) {
    let paid = 0;
    for (let i = 0; i < N; i++) if (crash.autoCashoutWins(crash.generateCrashPoint(0.03, 1000), target)) paid += target;
    assert.ok(Math.abs(paid / N - 0.97) < 0.02, `target ${target}: RTP ${paid / N}`);
  }
});

test('미션: 날짜별로 결정적 선택 & 진행도 계산', () => {
  const a = missions.select('daily', '2026-10-31', 3);
  const b = missions.select('daily', '2026-10-31', 3);
  assert.deepEqual(a.map((m) => m.id), b.map((m) => m.id), '같은 날 = 같은 미션');
  assert.equal(new Set(a.map((m) => m.id)).size, 3);
  const days = new Set(Array.from({ length: 10 }, (_, k) => missions.select('daily', `2026-11-${k + 10}`, 3).map((m) => m.id).join()));
  assert.ok(days.size > 1, '날마다 바뀜');
  const m = { game: 'slot', metric: 'plays', goal: 10 };
  assert.equal(missions.increment(m, { game: 'slot', net: -1, staked: 100 }), 1);
  assert.equal(missions.increment(m, { game: 'dice', net: 5, staked: 100 }), 0);
  assert.equal(missions.increment({ metric: 'wagered' }, { game: 'dice', staked: 700 }), 700);
});

test('업적: 조건 판정과 중복 방지', () => {
  const profile = { totals: { games: 100, wins: 1, wagered: 0 }, maxWinStreak: 5 };
  const ev = { game: 'slot', staked: 100, payout: 77_700 + 100_000, net: 177_600, detail: { jackpot: 100_000 } };
  const got = achievements.evaluate({ ev, profile }, []).map((a) => a.id);
  for (const id of ['first_win', 'games_100', 'streak_5', 'lucky_10x', 'slot_jackpot']) assert.ok(got.includes(id), id);
  assert.ok(!got.includes('games_1000'));
  const again = achievements.evaluate({ ev, profile }, got).map((a) => a.id);
  assert.equal(again.length, 0, '이미 받은 업적은 다시 안 줌');
});

test('꾸미기: 테마 렌더링과 상점 카탈로그 무결성', () => {
  assert.equal(cosmetics.card({ rank: 'A', suit: '♠' }, 'outline'), 'A♤');
  assert.equal(cosmetics.slotSymbol('7️⃣', 'space'), '🚀');
  assert.equal(cosmetics.diceFace(6, 'roman'), 'Ⅵ');
  assert.equal(cosmetics.framed('홍길동', 'fire'), '🔥 홍길동 🔥');
  for (const item of cosmetics.SHOP) {
    assert.ok(item.price.points || item.price.chips, `${item.id} 가격`);
    if (item.type !== 'title') assert.ok(cosmetics.CATALOG[item.type][item.value], `${item.id} 값`);
  }
  assert.equal(new Set(cosmetics.SHOP.map((i) => i.id)).size, cosmetics.SHOP.length, 'id 중복 없음');
});

test('통계: 설계 RTP 대비 편차 판정', () => {
  // 공정한 동전 2배 게임 (설계 RTP 1.0) 1만 판 시뮬레이션 → 정상 범위
  let sumR = 0;
  let sumR2 = 0;
  for (let i = 0; i < 10_000; i++) {
    const r = Math.random() < 0.5 ? 2 : 0;
    sumR += r;
    sumR2 += r * r;
  }
  const fair = { game: 'coin', n: 10_000, staked: 10_000, payout: sumR, sumR, sumR2 };
  const rigged = { game: 'coin', n: 10_000, staked: 10_000, payout: 8_000, sumR: 8_000, sumR2: 16_000 }; // 40% 승률
  const [a, b] = analytics.balanceReport([fair, rigged], () => 1.0);
  assert.equal(a.verdict, '✅ 정상 범위');
  assert.equal(b.verdict, '⚠️ 편차 큼');
  assert.equal(analytics.balanceReport([{ ...fair, n: 50 }], () => 1)[0].verdict, '표본 부족');
});

test('개인 분석: 최대 손실 구간·최고 수익 구간', () => {
  const nets = [100, 200, -500, -100, 300, 400, -50];
  const logs = nets.map((net) => ({ status: 'settled', game: 'dice', net, staked: 100, payout: 100 + net }));
  const r = analytics.personal(logs);
  assert.equal(r.net, 350);
  assert.equal(r.maxDrawdown, 600, '고점 300 → 저점 -300');
  assert.equal(r.bestRun, 700, '+300 +400');
  assert.equal(analytics.sparkline([1, 2, 3]).length, 3);
});

test('시간 키: KST 기준 날짜·ISO 주차', () => {
  assert.equal(time.dayKey(new Date('2026-10-31T15:30:00Z')), '2026-11-01', 'UTC 15:30 = KST 다음날 00:30');
  assert.equal(time.weekKey(new Date('2026-01-01T03:00:00Z')), '2026-W01');
  assert.equal(time.weekKey(new Date('2026-10-31T03:00:00Z')), '2026-W44');
});
