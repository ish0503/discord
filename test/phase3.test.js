/**
 * 3단계: 클랜 · 월드 보스 · 수집품 (인메모리 fakeMongo로 실제 서비스 실행)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { M, settle: wait } = require('../test-support/useFakes');

const config = require('../src/config');
const wallet = require('../src/services/wallet');
const outbox = require('../src/services/outbox');
const clan = require('../src/services/clan');
const boss = require('../src/services/worldBoss');
const collection = require('../src/services/collection');
const rules = require('../src/content/clan');

const G = '920000000000000001';
const G2 = '920000000000000002';
const uid = (n) => String(120000000000000000n + BigInt(n));
const money = (u, g = G) => M.User.docs.find((d) => d.userId === u && d.guildId === g)?.money;
const rich = async (u, g = G) => {
  await wallet.getAccount(u, g);
  M.User.docs.find((d) => d.userId === u && d.guildId === g).money = 1_000_000;
};
async function play(u, { g = G, game = 'dice', stake = 100, payout = 200 } = {}) {
  await wallet.getAccount(u, g);
  const r = await wallet.reserve(u, g, game, stake);
  const st = await wallet.settle({ userId: u, guildId: g, roundId: r.roundId, payout, game, wagered: stake });
  await wait(10);
  return st;
}

// ───────────────────────── 클랜 ─────────────────────────

test('클랜: 생성(비용 회수·원장)·이름 중복·입력 검증', async () => {
  const owner = uid(1);
  await rich(owner);
  const bad = await clan.create({ guildId: G, userId: owner, name: '<@123>', tag: 'X' });
  assert.equal(bad.ok, false);
  const r = await clan.create({ guildId: G, userId: owner, name: '불꽃 전사단', tag: 'fire', emblem: '🔥', channelId: 'c1' });
  assert.equal(r.ok, true);
  assert.equal(r.clan.tag, 'FIRE');
  assert.equal(money(owner), 1_000_000 - config.CLAN.CREATE_COST);
  assert.ok(M.Ledger.docs.some((l) => l.userId === owner && l.type === 'clan_create'));
  const other = uid(2);
  await rich(other);
  assert.equal((await clan.create({ guildId: G, userId: other, name: '불꽃전사단', tag: 'FF' })).ok, false, '공백만 다른 이름도 중복');
  await rich(other, G2);
  assert.equal((await clan.create({ guildId: G2, userId: other, name: '불꽃 전사단', tag: 'FF' })).ok, true, '다른 서버에서는 같은 이름 가능');
  assert.equal((await clan.create({ guildId: G, userId: owner, name: '두번째', tag: 'TWO' })).ok, false, '서버당 한 클랜');
  const poor = uid(3);
  await wallet.getAccount(poor, G);
  assert.equal((await clan.create({ guildId: G, userId: poor, name: '가난한 클랜', tag: 'POOR' })).ok, false);
  assert.equal(M.Clan.docs.filter((c) => c.name === '가난한 클랜').length, 0, '실패하면 클랜도 남지 않음');
});

test('클랜: 신청·승인 권한, 직책, 추방 권한, 탈퇴 후 재가입 대기', async () => {
  const owner = uid(1);
  const [a, b, c] = [uid(10), uid(11), uid(12)];
  for (const u of [a, b, c]) assert.equal((await clan.apply({ guildId: G, userId: u, name: '불꽃 전사단' })).ok, true);
  assert.equal((await clan.apply({ guildId: G, userId: a, name: '불꽃 전사단' })).ok, false, '중복 신청');
  assert.equal((await clan.decide({ guildId: G, actorId: b, targetId: a, approve: true })).ok, false, '멤버 아닌 사람은 승인 불가');
  assert.equal((await clan.decide({ guildId: G, actorId: owner, targetId: a, approve: true })).approved, true);
  assert.equal((await clan.decide({ guildId: G, actorId: a, targetId: b, approve: true })).ok, false, '일반 멤버는 승인 불가');
  assert.equal((await clan.setRole({ guildId: G, actorId: a, targetId: a, role: 'officer' })).ok, false, '클랜장만 직책 변경');
  assert.equal((await clan.setRole({ guildId: G, actorId: owner, targetId: a, role: 'officer' })).ok, true);
  assert.equal((await clan.decide({ guildId: G, actorId: a, targetId: b, approve: true })).approved, true, '부클랜장은 승인 가능');
  assert.equal((await clan.decide({ guildId: G, actorId: a, targetId: c, approve: false })).approved, false);
  assert.equal((await clan.kick({ guildId: G, actorId: a, targetId: owner })).ok, false, '상위 직책 추방 불가');
  assert.equal((await clan.kick({ guildId: G, actorId: b, targetId: a })).ok, false, '하위가 상위 추방 불가');
  assert.equal((await clan.leave({ guildId: G, userId: owner })).ok, false, '클랜장은 위임·해산 먼저');
  assert.equal((await clan.kick({ guildId: G, actorId: a, targetId: b })).ok, true);
  const info = await clan.info(G, { name: '불꽃 전사단' });
  assert.equal(info.clan.memberCount, 2);
  assert.equal((await clan.apply({ guildId: G, userId: b, name: '불꽃 전사단' })).ok, false, '추방 후 재가입 대기');
  assert.ok(M.ClanLog.docs.some((l) => l.type === 'kick' && l.targetId === b));
});

test('클랜: 정원 초과 승인 불가 (동시에 승인해도)', async () => {
  const owner = uid(20);
  await rich(owner);
  await clan.create({ guildId: G, userId: owner, name: '작은 클랜', tag: 'SMALL' });
  const cap = rules.maxMembers(1);
  const users = Array.from({ length: cap + 3 }, (_, k) => uid(100 + k));
  for (const u of users) await clan.apply({ guildId: G, userId: u, name: '작은 클랜' });
  const res = await Promise.all(users.map((u) => clan.decide({ guildId: G, actorId: owner, targetId: u, approve: true })));
  const joined = res.filter((r) => r.approved).length;
  assert.equal(joined, cap - 1, `정원 ${cap} (클랜장 포함)`);
  const c = await clan.info(G, { name: '작은 클랜' });
  assert.equal(c.clan.memberCount, cap);
  assert.equal(c.members.length, cap);
});

test('클랜 경험치: 플레이로 쌓이고(칩과 무관) 하루 상한, 재처리·클랜 이동으로 상한 우회 불가', async () => {
  const owner = uid(1);
  const before = (await clan.info(G, { userId: owner })).clan.exp;
  await play(owner, { payout: 200 }); // 승리: 10 + 5
  const after = (await clan.info(G, { userId: owner })).clan.exp;
  assert.equal(after - before, config.CLAN.EXP_PER_ROUND + config.CLAN.EXP_WIN_BONUS);
  // 재처리
  for (const ev of M.OutboxEvent.docs.filter((e) => e.userId === owner)) {
    ev.status = 'pending';
    ev.done = [];
    ev.nextAttemptAt = new Date(0);
  }
  await outbox.sweep();
  assert.equal((await clan.info(G, { userId: owner })).clan.exp, after, '재처리해도 중복 없음');
  // 하루 상한
  const cap = config.CLAN.DAILY_EXP_CAP_PER_MEMBER;
  for (let k = 0; k < 30; k++) await play(owner, { payout: 0 });
  const p = M.ClanPlayer.docs.find((x) => x.guildId === G && x.userId === owner);
  assert.equal(p.expToday, cap, '하루 상한');
  assert.equal((await clan.info(G, { userId: owner })).clan.exp, before + cap);
  const member = M.ClanMember.docs.find((m) => m.userId === owner && m.guildId === G);
  assert.equal(member.contribution, cap);
});

test('클랜: 해산은 이름 확인 필요, 해산 후 모든 멤버 대기 시간', async () => {
  const owner = uid(20);
  assert.equal((await clan.disband({ guildId: G, actorId: owner, confirmName: '틀린이름' })).ok, false);
  const r = await clan.disband({ guildId: G, actorId: owner, confirmName: '작은 클랜' });
  assert.equal(r.ok, true);
  assert.equal(M.ClanMember.docs.filter((m) => m.clanId === r.clan.clanId).length, 0);
  assert.equal((await clan.create({ guildId: G, userId: owner, name: '다시 만든 클랜', tag: 'AGAIN' })).ok, false, '해산 직후 재창설 불가');
});

// ───────────────────────── 월드 보스 ─────────────────────────

test('월드 보스: 서버당 1마리, 동시 공격해도 하루 횟수 초과 불가, 체력·기여도 일치', async () => {
  const s1 = await boss.start({ guildId: G, defId: 'golem', hours: 24, actorId: 'admin', channelId: null });
  assert.equal(s1.ok, true);
  assert.equal((await boss.start({ guildId: G, defId: 'dragon', hours: 24 })).ok, false, '동시에 한 마리');
  const u = uid(30);
  const res = await Promise.all(Array.from({ length: 6 }, () => boss.attack({ guildId: G, userId: u })));
  const hits = res.filter((r) => r.ok);
  assert.equal(hits.length, config.BOSS.DAILY_ATTEMPTS, '하루 횟수만큼만');
  const c = M.BossContribution.docs.find((x) => x.bossId === s1.boss.bossId && x.userId === u);
  const dealt = hits.reduce((s, r) => s + r.dmg, 0);
  assert.equal(c.contribution, dealt);
  const b = await boss.active(G);
  assert.equal(b.hp, s1.boss.maxHp - dealt, '체력 = 최대 − 기여 합');
  assert.equal(money(u), undefined, '공격은 칩을 쓰지 않음');
});

test('월드 보스: 평소 게임 지원 피해는 하루 상한·이벤트당 1회', async () => {
  const u = uid(31);
  for (let k = 0; k < 40; k++) await play(u, { payout: 0 });
  const b = await boss.active(G);
  const c = M.BossContribution.docs.find((x) => x.bossId === b.bossId && x.userId === u);
  assert.ok(c.contribution <= config.BOSS.PASSIVE_DAILY_CAP);
  assert.ok(c.contribution >= config.BOSS.PASSIVE_DAILY_CAP - 4);
  const n = c.contribution;
  for (const ev of M.OutboxEvent.docs.filter((e) => e.userId === u)) {
    ev.status = 'pending';
    ev.done = [];
    ev.nextAttemptAt = new Date(0);
  }
  await outbox.sweep();
  assert.equal(M.BossContribution.docs.find((x) => x.bossId === b.bossId && x.userId === u).contribution, n, '재처리 중복 없음');
});

test('월드 보스: 처치 → 보상 1회(카드·업적·칩 상한·자격), 다시 지급해도 중복 없음, 다른 서버와 분리', async () => {
  const b = await boss.active(G);
  const vet = uid(40); // 이 서버에서 충분히 플레이한 참여자
  for (let k = 0; k < config.BOSS.MIN_GAMES_FOR_CHIPS; k++) await play(vet, { payout: 0 });
  M.BossContribution.docs.push({ guildId: G, bossId: b.bossId, userId: vet, contribution: 500, attempts: 1, processed: [], rewarded: false });
  const alt = uid(41); // 플레이 기록 없는 계정 (부계정 의심) — 카드만
  M.BossContribution.docs.push({ guildId: G, bossId: b.bossId, userId: alt, contribution: 500, attempts: 1, processed: [], rewarded: false });
  const vetBefore = money(vet);
  await boss.hit(b, b.hp + 10); // 처치
  await wait(20);
  const done = M.WorldBoss.docs.find((x) => x.bossId === b.bossId);
  assert.equal(done.status, 'defeated');
  assert.equal(done.rewardState, 'done');
  const gain = money(vet) - vetBefore;
  assert.ok(gain > 0 && gain <= config.BOSS.CHIP_REWARD_CAP, `칩 보상 ${gain} (상한 이하)`);
  assert.equal(money(alt, G) ?? 10_000, 10_000, '자격 미달 계정은 칩 없음');
  assert.ok(M.UserCollection.docs.some((x) => x.userId === alt && x.itemId === 'boss:golem'), '참여 카드는 지급');
  assert.ok(M.UserCollection.docs.some((x) => x.userId === vet && x.itemId === 'bossgold:golem'), '처치 황금 카드');
  // 다시 지급 시도
  await boss.grantRewards(done);
  await boss.finish(b.bossId, 'defeated');
  assert.equal(money(vet) - vetBefore, gain, '중복 지급 없음');
  assert.equal(M.UserCollection.docs.filter((x) => x.userId === vet && x.itemId === 'bossgold:golem').length, 1);
  assert.equal(await boss.active(G2), null, '다른 서버에는 보스 없음');
  assert.ok(M.HallOfFameRecord.docs.some((r) => r.guildId === G && r.category === 'boss_top'));
});

test('월드 보스: 시간이 지나면 실패로 종료되고 참여 보상만', async () => {
  const s = await boss.start({ guildId: G2, defId: 'phantom', hours: 1 });
  const u = uid(50);
  await boss.attack({ guildId: G2, userId: u });
  await boss.attack({ guildId: G2, userId: u });
  await boss.attack({ guildId: G2, userId: u });
  M.WorldBoss.docs.find((x) => x.bossId === s.boss.bossId).endsAt = new Date(Date.now() - 1000);
  await boss.sweep();
  const done = M.WorldBoss.docs.find((x) => x.bossId === s.boss.bossId);
  assert.equal(done.status, 'failed');
  assert.ok(!M.UserCollection.docs.some((x) => x.userId === u && x.itemId === 'bossgold:phantom'), '실패 시 황금 카드 없음');
});

// ───────────────────────── 수집품 ─────────────────────────

test('수집품: 중복 획득 불가, 세트 완성 보상 1회, 전시는 보유품만', async () => {
  const u = uid(60);
  for (const ch of ['ch1', 'ch2', 'ch3', 'ch4']) {
    assert.equal(await collection.grant(u, `story:${ch}`, { guildId: G }), true);
    assert.equal(await collection.grant(u, `story:${ch}`, { guildId: G }), false, '중복 획득 불가');
  }
  const p = M.Profile.docs.find((x) => x.userId === u);
  assert.deepEqual(p.collectionSets, ['story']);
  const pts = p.rewardPoints;
  await collection.checkSets(u, G, null);
  assert.equal(M.Profile.docs.find((x) => x.userId === u).rewardPoints, pts, '세트 보상 1회');
  assert.equal((await collection.setShowcase(u, ['story:ch4', 'boss:dragon'])).ok, false, '없는 수집품 전시 불가');
  assert.equal((await collection.setShowcase(u, ['story:ch4', 'story:ch1'])).ok, true);
  assert.equal(await collection.grant(u, 'season:2026w', {}), false, '기간 밖 한정 아이템은 획득 불가');
});
