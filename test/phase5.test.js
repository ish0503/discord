/**
 * 5단계: 라이벌 · 수집 도감·전시 · 시즌 한정 (인메모리 fakeMongo로 실제 서비스 실행)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { M, settle: wait } = require('../test-support/useFakes');

const wallet = require('../src/services/wallet');
const outbox = require('../src/services/outbox');
const rival = require('../src/services/rival');
const collection = require('../src/services/collection');
const catalog = require('../src/content/collection');

const G = '950000000000000001';
const uid = (n) => String(150000000000000000n + BigInt(n));
const [A, B, C] = [uid(1), uid(2), uid(3)];

/** 두 사람이 같은 포커 핸드에 앉은 것처럼 각자 정산 */
async function hand(gameId, nets, { roomId = null } = {}) {
  const ids = Object.keys(nets);
  for (const u of ids) {
    await wallet.getAccount(u, G);
    const r = await wallet.reserve(u, G, 'poker', 1000, { gameId });
    await wallet.settle({ userId: u, guildId: G, roundId: r.roundId, payout: 1000 + nets[u], game: 'poker', gameId, wagered: 1000, maxPayout: 4000, detail: { opponents: ids.filter((x) => x !== u), seats: ids.length, roomId } });
  }
  await wait(30);
}
const rv = () => M.Rivalry.docs.find((x) => x.pairKey === rival.pairOf(A, B).pairKey);
const winsOf = (u) => (rv().a === u ? rv().aWins : rv().bWins);

test('라이벌: 상대 동의 필요 · 자기 자신·봇 불가 · 최대 인원', async () => {
  assert.equal((await rival.request({ guildId: G, from: A, to: A })).ok, false);
  assert.equal((await rival.request({ guildId: G, from: A, to: B, isBot: true })).ok, false);
  assert.equal((await rival.request({ guildId: G, from: A, to: B })).ok, true);
  assert.equal((await rival.respond({ guildId: G, userId: A, other: B, accept: true })).ok, false, '신청한 사람이 수락할 수 없음');
  await hand('g-before', { [A]: 500, [B]: -500 });
  assert.equal(rv().aWins + rv().bWins, 0, '수락 전 게임은 기록 안 함');
  assert.equal((await rival.respond({ guildId: G, userId: B, other: A, accept: true })).accepted, true);
  assert.equal(rv().status, 'active');
  for (const k of [4, 5, 6]) await rival.request({ guildId: G, from: A, to: uid(k) }).then(() => rival.respond({ guildId: G, userId: uid(k), other: A, accept: true }));
  assert.equal(M.Rivalry.docs.filter((x) => x.status === 'active' && (x.a === A || x.b === A)).length, rival.MAX, '최대 인원');
});

test('라이벌: 같은 게임은 두 사람 결과가 모이면 한 번만 반영, 재처리 중복 없음, 다른 사람과의 게임은 무관', async () => {
  await hand('g1', { [A]: 500, [B]: -500 });
  assert.equal(winsOf(A), 1);
  assert.equal(winsOf(B), 0);
  for (const ev of M.OutboxEvent.docs.filter((e) => e.gameId === 'g1')) {
    ev.status = 'pending';
    ev.done = [];
    ev.nextAttemptAt = new Date(0);
  }
  await outbox.sweep();
  assert.equal(winsOf(A), 1, '재처리 중복 없음');
  await hand('g2', { [A]: 300, [C]: -300 });
  assert.equal(winsOf(A), 1, '라이벌이 아닌 상대와의 게임은 무관');
});

test('라이벌: 주간 도전 보상은 주 1회, 비공개 방 맞대결은 전적만 (도전 제외)', async () => {
  const pts0 = M.Profile.docs.find((p) => p.userId === A).rewardPoints;
  await hand('g-room-1', { [A]: 100, [B]: -100 }, { roomId: 'room-1' });
  await hand('g-room-2', { [A]: 100, [B]: -100 }, { roomId: 'room-1' });
  assert.equal(winsOf(A), 3, '비공개 방도 전적엔 남음');
  assert.equal(rv().weekly.wins?.[A] ?? 0, 1, '주간 도전은 공개 게임만 (g1 하나)');
  await hand('g3', { [A]: 100, [B]: -100 });
  await hand('g4', { [A]: 100, [B]: -100 });
  await hand('g5', { [A]: 100, [B]: -100 });
  const p = M.Profile.docs.find((x) => x.userId === A);
  assert.equal(p.rewardPoints - pts0 >= rival.WEEKLY_POINTS, true);
  assert.equal(p.rivalWeekly, 1, '주간 보상 1회');
  assert.equal(rv().streakHolder, A);
  assert.ok(rv().streak >= 5);
  assert.ok(p.achievements.some((x) => x.id === 'rival_streak5'), '5연승 업적');
});

test('수집 도감: 게임 기념품은 정산 이벤트로 1회, 한정 아이템은 기간 안에만, 수집품은 칩·확률 무관', async () => {
  const u = uid(20);
  await wallet.getAccount(u, G);
  for (let k = 0; k < 2; k++) {
    const r = await wallet.reserve(u, G, 'dice', 100);
    await wallet.settle({ userId: u, guildId: G, roundId: r.roundId, payout: 500, game: 'dice', wagered: 100, detail: { choice: 'seven' } });
  }
  await wait(30);
  assert.equal(M.UserCollection.docs.filter((x) => x.userId === u && x.itemId === 'game:lucky7').length, 1, '두 번 맞혀도 1개');
  const item = catalog.byId['season:2026w'];
  assert.equal(catalog.obtainable(item, new Date('2026-12-15T00:00:00+09:00')), true);
  assert.equal(catalog.obtainable(item, new Date('2027-03-02T00:00:00+09:00')), false);
  const before = M.User.docs.find((d) => d.userId === u).money;
  await collection.grant(u, 'story:ch1', {});
  assert.equal(M.User.docs.find((d) => d.userId === u).money, before, '수집품은 칩을 주지 않음');
});

test('미션 연동: 활동형 미션(규칙·보스·클랜·스토리·예측)은 게임 정산으로 진행되지 않음', () => {
  const missions = require('../src/content/missions');
  for (const metric of missions.ACTIVITY_METRICS) assert.equal(missions.increment({ metric }, { game: 'dice', net: 10, staked: 100 }), 0);
  const ids = [...missions.POOL.daily, ...missions.POOL.weekly].map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, '미션 id 중복 없음');
});
