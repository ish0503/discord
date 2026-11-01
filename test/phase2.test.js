/**
 * 2단계: 특별 규칙 · 스토리 챌린지 · 명예의 전당 (인메모리 fakeMongo로 실제 서비스 실행)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { M, settle: wait } = require('../test-support/useFakes');

const wallet = require('../src/services/wallet');
const outbox = require('../src/services/outbox');
const rules = require('../src/content/dailyRules');
const dailyRule = require('../src/services/dailyRule');
const storyContent = require('../src/content/story');
const storyService = require('../src/services/story');
const hof = require('../src/services/hallOfFame');

const G = '910000000000000001';
const G2 = '910000000000000002';
const uid = (n) => String(110000000000000000n + BigInt(n));
const prof = (u) => M.Profile.docs.find((p) => p.userId === u);
const money = (u, g = G) => M.User.docs.find((d) => d.userId === u && d.guildId === g)?.money;

/** 실제 정산 경로로 한 판 (Outbox 처리까지) */
async function play(u, { g = G, game = 'dice', stake = 500, payout = 1000, detail = {} } = {}) {
  await wallet.getAccount(u, g);
  const r = await wallet.reserve(u, g, game, stake);
  const st = await wallet.settle({ userId: u, guildId: g, roundId: r.roundId, payout, game, wagered: stake, detail, channelId: null });
  await wait(15);
  return st;
}

// ───────────────────────── 특별 규칙 ─────────────────────────

test('특별 규칙: 날짜별로 결정적, 내일 규칙도 미리 공개 가능', () => {
  assert.equal(rules.forDay('2026-11-01').id, rules.forDay('2026-11-01').id);
  const seen = new Set(Array.from({ length: 60 }, (_, k) => rules.forDay(`2026-12-${String((k % 28) + 1).padStart(2, '0')}-${k}`).id));
  assert.ok(seen.size >= 5, '여러 규칙이 돌아가며 선택됨');
});

test('특별 규칙: 연승 규칙은 지면 초기화, 서로 다른 게임 규칙은 종류만 셈', () => {
  const streak = rules.byId.streak3;
  let s = rules.advance(streak, null, { net: 1 });
  s = rules.advance(streak, s, { net: 1 });
  s = rules.advance(streak, s, { net: -1 });
  assert.equal(s.streak, 0);
  assert.equal(s.progress, 2, '최고 기록은 유지');
  const v = rules.byId.variety;
  let t = null;
  for (const g of ['dice', 'dice', 'slot', 'crash']) t = rules.advance(v, t, { game: g, net: 0 });
  assert.equal(t.progress, 3);
});

test('특별 규칙: 달성하면 보상 1회 — 같은 이벤트 재처리·동시 처리해도 중복 없음, 칩·배당은 그대로', async () => {
  const orig = rules.forDay;
  rules.forDay = () => rules.byId.smallwin; // 오늘 규칙을 고정
  try {
    const u = uid(1);
    const results = await Promise.all(Array.from({ length: 5 }, () => play(u, { stake: 500, payout: 1000 })));
    assert.ok(results.every((r) => r.ok));
    await wait(30);
    await outbox.sweep();
    const p = prof(u);
    assert.equal(p.dailyRule.progress, 5, '동시 처리해도 진행도 누락 없음');
    assert.equal(p.dailyRule.completed, true);
    assert.equal(p.ruleCompletions, 1);
    const pts = p.rewardPoints;
    // 같은 이벤트 강제 재처리
    for (const ev of M.OutboxEvent.docs.filter((e) => e.userId === u)) {
      ev.status = 'pending';
      ev.done = [];
      ev.nextAttemptAt = new Date(0);
    }
    await outbox.sweep();
    assert.equal(prof(u).rewardPoints, pts, '보상 중복 없음');
    assert.equal(prof(u).dailyRule.progress, 5);
    assert.equal(money(u), 10_000 + 5 * 500, '규칙은 칩 정산에 관여하지 않음 (판당 +500 그대로)');
    assert.ok(prof(u).achievements.some((a) => a.id === 'rule_1'), '규칙 업적');
  } finally {
    rules.forDay = orig;
  }
});

// ───────────────────────── 스토리 ─────────────────────────

test('스토리: 시작 → 평소 게임으로 단계 진행 → 챕터 보상 1회, 진행도 저장', async () => {
  const u = uid(2);
  const start = await storyService.start(G, u);
  assert.equal(start.chapter.id, 'ch1');
  for (const g of ['dice', 'slot', 'crash']) await play(u, { game: g, stake: 100, payout: g === 'crash' ? 0 : 200, detail: g === 'crash' ? { cashedAt: null } : {} });
  let s = await storyService.get(G, u);
  assert.equal(s.stage, 1, '1단계(3판) 완료 → 2단계');
  assert.ok(s.completedStages.includes('ch1:s1'));
  await play(u); // 승리 1
  await play(u); // 승리 2 → 2단계 완료
  s = await storyService.get(G, u);
  assert.equal(s.stage, 2);
  for (const g of ['dice', 'slot', 'baccarat']) await play(u, { game: g, stake: 100, payout: 0 });
  s = await storyService.get(G, u);
  assert.equal(s.chapterId, null);
  assert.deepEqual(s.completedChapters, ['ch1']);
  const p = prof(u);
  assert.ok(p.titles.includes('카지노 신입생'));
  assert.deepEqual(p.storyRewards, ['ch1']);
  const pts = p.rewardPoints;

  // 다른 서버에서 같은 챕터를 다시 깨도 보상은 다시 안 줌
  await storyService.start(G2, u);
  for (const g of ['dice', 'slot', 'crash']) await play(u, { g: G2, game: g, stake: 100, payout: g === 'crash' ? 0 : 200 });
  await play(u, { g: G2 });
  await play(u, { g: G2 });
  for (const g of ['dice', 'slot', 'baccarat']) await play(u, { g: G2, game: g, stake: 100, payout: 0 });
  assert.deepEqual((await storyService.get(G2, u)).completedChapters, ['ch1']);
  assert.equal(prof(u).rewardPoints - pts < 200, true, '챕터 보상 포인트(200)는 다시 안 줌');
});

test('스토리: 완료 기록 후 보상 전에 멈췄어도 재처리 때 마저 지급 (1회)', async () => {
  const u = uid(3);
  await storyService.get(G, u);
  M.StoryProgress.docs.find((d) => d.userId === u && d.guildId === G).completedChapters = ['ch1'];
  await storyService.reconcile(G, u);
  await storyService.reconcile(G, u);
  assert.deepEqual(prof(u).storyRewards, ['ch1']);
  assert.equal(prof(u).titles.filter((t) => t === '카지노 신입생').length, 1);
});

test('스토리: 시작 안 한 유저는 진행 없음, 실패(패배)해도 칩 외 손실 없음', async () => {
  const u = uid(4);
  await play(u, { payout: 0 });
  const s = await storyService.get(G, u);
  assert.equal(s.chapterId, null);
  assert.equal(s.completedStages.length, 0);
  assert.equal(storyContent.nextChapter([]).id, 'ch1');
  assert.equal(storyContent.nextChapter(['ch1', 'ch2', 'ch3', 'ch4']), null);
});

// ───────────────────────── 명예의 전당 ─────────────────────────

test('명예의 전당: 기록 경신 시 이전 기록은 이력으로 보존, 작은 기록·재처리는 무시, 서버별 분리', async () => {
  const [a, b] = [uid(10), uid(11)];
  await play(a, { stake: 1000, payout: 3000 });
  await play(b, { stake: 1000, payout: 5000 });
  await play(a, { stake: 1000, payout: 2000 });
  const hist = await hof.history(G, 'biggest_net');
  const mine = hist.filter((r) => [a, b].includes(r.userId));
  assert.equal(mine.length >= 1, true);
  const best = M.HallOfFameBest.docs.find((x) => x.guildId === G && x.category === 'biggest_net');
  assert.ok(best.value >= 4000);
  const cur = M.HallOfFameRecord.docs.filter((r) => r.guildId === G && r.category === 'biggest_net' && r.current);
  assert.equal(cur.length, 1, '현재 기록은 1개');
  const old = M.HallOfFameRecord.docs.filter((r) => r.guildId === G && r.category === 'biggest_net' && !r.current);
  assert.ok(old.length >= 1, '이전 기록은 지우지 않고 이력으로');
  const n = M.HallOfFameRecord.docs.length;
  for (const ev of M.OutboxEvent.docs.filter((e) => e.userId === b)) {
    ev.status = 'pending';
    ev.done = [];
    ev.nextAttemptAt = new Date(0);
  }
  await outbox.sweep();
  assert.equal(M.HallOfFameRecord.docs.length, n, '재처리해도 기록 중복 없음');
  assert.equal((await hof.board(G2)).bests.filter((x) => [a, b].includes(x.userId)).length, 0, '다른 서버에는 없음');
  const anon = await hof.anonymize(G, b);
  assert.ok(anon >= 1);
  assert.ok(M.HallOfFameRecord.docs.filter((r) => r.guildId === G && r.userId === 'deleted').every((r) => r.anonymized && r.value > 0), '수치는 보존');
});

test('명예의 전당: 동시에 들어온 기록 중 가장 큰 값만 현재 기록', async () => {
  const users = [uid(20), uid(21), uid(22)];
  await Promise.all(users.map((u, k) => play(u, { g: G2, game: 'crash', stake: 1000, payout: 10_000 * (k + 2), detail: { cashedAt: 10 * (k + 2) } })));
  await wait(30);
  await outbox.sweep();
  const best = M.HallOfFameBest.docs.find((x) => x.guildId === G2 && x.category === 'biggest_net');
  assert.equal(best.value, 39_000);
  assert.equal(M.HallOfFameRecord.docs.filter((r) => r.guildId === G2 && r.category === 'biggest_net' && r.current).length, 1);
});
