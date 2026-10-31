/**
 * 지갑(에스크로 정산) 테스트 — 인메모리 가짜 모델로 실제 wallet.js 코드를 실행.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makeModel } = require('../test-support/fakeMongo');

const User = makeModel('User', () => ({ money: 10_000, escrow: [], stats: {}, diceLossStreak: 0, lastBailoutAt: null, lastDailyKey: null, dailyStreak: 0 }));
const GameLog = makeModel('GameLog');
const Ledger = makeModel('Ledger');
const inject = (rel, exp) => {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exp };
};
inject('src/db/User.js', User);
inject('src/db/GameLog.js', GameLog);
inject('src/db/Ledger.js', Ledger);

const wallet = require('../src/services/wallet');
const bus = require('../src/services/bus');
const G = 'guild1';
const money = (u, g = G) => User.docs.find((d) => d.userId === u && d.guildId === g)?.money;
const settledEvents = [];
bus.raw.on('round:settled', (e) => settledEvents.push(e));

test('reserve: 잔고 조건부 차감, 부족하면 null', async () => {
  await wallet.getAccount('u1', G);
  const r = await wallet.reserve('u1', G, 'slot', 3000);
  assert.ok(r.roundId);
  assert.equal(r.balance, 7000);
  assert.equal(await wallet.reserve('u1', G, 'slot', 7001), null);
  assert.equal(money('u1'), 7000);
});

test('settle: 지급·로그·이벤트 1회, 같은 roundId 재정산은 무시 (멱등)', async () => {
  const r = await wallet.reserve('u1', G, 'dice', 1000);
  const a = await wallet.settle({ userId: 'u1', guildId: G, roundId: r.roundId, payout: 2000, game: 'dice', wagered: 1000 });
  const b = await wallet.settle({ userId: 'u1', guildId: G, roundId: r.roundId, payout: 2000, game: 'dice', wagered: 1000 });
  assert.equal(a.ok, true);
  assert.equal(a.net, 1000);
  assert.equal(b.ok, false, '두 번째 정산은 거절');
  assert.equal(GameLog.docs.filter((l) => l.roundId === r.roundId).length, 1);
  assert.equal(settledEvents.filter((e) => e.net === 1000 && e.game === 'dice').length, 1);
  const doc = User.docs.find((d) => d.userId === 'u1');
  assert.equal(doc.stats.biggestWin, 1000);
});

test('addStake: 더블·스플릿 추가 베팅은 escrow 금액에 합산, 잔고 부족 시 null', async () => {
  await wallet.getAccount('u2', G);
  const r = await wallet.reserve('u2', G, 'blackjack', 4000);
  assert.equal(await wallet.addStake('u2', G, r.roundId, 4000), 2000);
  assert.equal(await wallet.addStake('u2', G, r.roundId, 4000), null, '잔고 2000 < 4000');
  const s = await wallet.settle({ userId: 'u2', guildId: G, roundId: r.roundId, payout: 16_000, game: 'blackjack' });
  assert.equal(s.staked, 8000);
  assert.equal(s.net, 8000);
  assert.equal(money('u2'), 18_000);
});

test('refund vs settle 경합: 둘 중 하나만 성공', async () => {
  await wallet.getAccount('u3', G);
  const r = await wallet.reserve('u3', G, 'crash', 5000);
  const [x, y] = await Promise.all([
    wallet.refund({ userId: 'u3', guildId: G, roundId: r.roundId, reason: 'test' }),
    wallet.settle({ userId: 'u3', guildId: G, roundId: r.roundId, payout: 0, game: 'crash' }),
  ]);
  assert.equal([x.ok, y.ok].filter(Boolean).length, 1);
  assert.ok(money('u3') === 10_000 || money('u3') === 5000);
});

test('복구: 결과 선기록된 판은 그 결과로 정산, 나머지는 환불', async () => {
  await wallet.getAccount('u4', G);
  const decided = await wallet.reserve('u4', G, 'slot', 1000);
  const undecided = await wallet.reserve('u4', G, 'slot', 1000);
  await wallet.commitResult('u4', G, decided.roundId, 3000, { reels: ['🔔', '🔔', '🔔'] });
  // 이전 프로세스가 남긴 것처럼 instance 변경
  for (const e of User.docs.find((d) => d.userId === 'u4').escrow) e.instance = 'dead-process';
  const out = await wallet.recoverPrevious();
  assert.equal(out.settled, 1);
  assert.equal(out.refunded, 1);
  assert.equal(money('u4'), 10_000 - 1000 + 3000, '확정 결과(3000) 지급 + 미확정 판 원금 반환');
  assert.ok(GameLog.docs.find((l) => l.roundId === decided.roundId).recovered);
  assert.equal(User.docs.find((d) => d.userId === 'u4').escrow.length, 0);
});

test('stale 스윕: TTL 지난 판만 처리', async () => {
  await wallet.getAccount('u5', G);
  const old = await wallet.reserve('u5', G, 'dice', 500);
  await wallet.reserve('u5', G, 'dice', 500);
  const e = User.docs.find((d) => d.userId === 'u5').escrow.find((x) => x.roundId === old.roundId);
  e.createdAt = new Date(Date.now() - 60 * 60_000);
  const out = await wallet.recoverStale(20 * 60_000);
  assert.equal(out.refunded, 1);
  assert.equal(User.docs.find((d) => d.userId === 'u5').escrow.length, 1);
});

test('출석: 하루 1회, 연속 출석 보너스, 원장 기록', async () => {
  const a = await wallet.claimDaily('u6', G, '2026-10-30', '2026-10-29');
  const b = await wallet.claimDaily('u6', G, '2026-10-30', '2026-10-29');
  const c = await wallet.claimDaily('u6', G, '2026-10-31', '2026-10-30');
  const d = await wallet.claimDaily('u6', G, '2026-11-02', '2026-11-01');
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(c.streak, 2);
  assert.equal(c.amount, 2000 + 200);
  assert.equal(d.streak, 1, '하루 빠지면 연속 초기화');
  assert.equal(Ledger.docs.filter((l) => l.userId === 'u6' && l.type === 'daily').length, 3);
});

test('관리자 지급·회수: 회수는 잔고 이상 불가, 원장 기록', async () => {
  await wallet.grant({ userId: 'u7', guildId: G, amount: 5000, type: 'admin_grant', reason: '이벤트', actorId: 'admin' });
  assert.equal(money('u7'), 15_000);
  assert.equal(await wallet.debit({ userId: 'u7', guildId: G, amount: 20_000, type: 'admin_revoke', actorId: 'admin' }), null);
  await wallet.debit({ userId: 'u7', guildId: G, amount: 15_000, type: 'admin_revoke', actorId: 'admin' });
  assert.equal(money('u7'), 0);
  assert.deepEqual(Ledger.docs.filter((l) => l.userId === 'u7').map((l) => l.amount), [5000, -15_000]);
});

test('서버별 경제: 같은 유저라도 서버마다 지갑이 다름', async () => {
  await wallet.reserve('u1', 'guild2', 'slot', 100).then((r) => assert.equal(r, null, 'guild2 지갑 미생성'));
  await wallet.getAccount('u1', 'guild2');
  assert.equal(money('u1', 'guild2'), 10_000);
  assert.notEqual(money('u1', 'guild2'), money('u1', G));
});
