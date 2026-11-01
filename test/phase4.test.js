/**
 * 4단계: 랭크 리그 · 비공개 방 · 토너먼트 예측 (인메모리 fakeMongo로 실제 서비스 실행)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { M, settle: wait } = require('../test-support/useFakes');

const config = require('../src/config');
const wallet = require('../src/services/wallet');
const outbox = require('../src/services/outbox');
const rank = require('../src/content/rank');
const rankService = require('../src/services/rank');
const rooms = require('../src/services/privateRoom');
const prediction = require('../src/services/prediction');

const G = '930000000000000001';
const G2 = '930000000000000002';
const uid = (n) => String(130000000000000000n + BigInt(n));
const money = (u, g = G) => M.User.docs.find((d) => d.userId === u && d.guildId === g)?.money;
const rp = (u, game = 'poker') => M.RankProfile.docs.find((d) => d.userId === u && d.guildId === G && d.gameType === game);

async function pokerHand(u, { net, opponents = [], seats = 2, roomId = null, g = G }) {
  await wallet.getAccount(u, g);
  const r = await wallet.reserve(u, g, 'poker', 1000);
  const st = await wallet.settle({ userId: u, guildId: g, roundId: r.roundId, payout: 1000 + net, game: 'poker', wagered: 1000, maxPayout: 1000 * seats, detail: { opponents, seats, endReason: 'showdown', roomId } });
  await wait(15);
  return st;
}

// ───────────────────────── 랭크 ─────────────────────────

test('랭크(순수): 등급·강등 보호·K·반복 감소·시즌 시드', () => {
  assert.equal(rank.tierFor(1000), 'bronze');
  assert.equal(rank.tierFor(1305), 'gold');
  assert.equal(rank.tierFor(1280, 'gold'), 'gold', '하한 아래 50점까지는 유지');
  assert.equal(rank.tierFor(1240, 'gold'), 'silver');
  assert.ok(rank.delta({ rating: 1000, games: 0, opponents: [1400], S: 1 }) > rank.delta({ rating: 1000, games: 0, opponents: [800], S: 1 }), '강한 상대를 이기면 더 많이 오름');
  assert.ok(rank.delta({ rating: 1000, games: 50, S: 1, bots: 1 }) < rank.delta({ rating: 1000, games: 0, S: 1, bots: 1 }), '경기 수 많으면 K 감소');
  assert.equal(rank.delta({ rating: 1000, games: 0, opponents: [1000], S: 1, repeat: 0 }), 0);
  assert.equal(rank.seasonSeed(1600), 1300);
  assert.equal(rank.scoreOf({ game: 'slot', status: 'settled' }), null, '운 게임 제외');
  assert.equal(rank.scoreOf({ game: 'poker', status: 'settled', net: 5, detail: { roomId: 'r' } }), null, '비공개 방 제외');
});

test('랭크: 포커 결과로 점수 변화 · 재처리 중복 없음 · 칩 보유량과 무관', async () => {
  const [a, b] = [uid(1), uid(2)];
  await pokerHand(a, { net: 500, opponents: [b], seats: 2 });
  await pokerHand(b, { net: -500, opponents: [a], seats: 2 });
  const ra = rp(a);
  const rb = rp(b);
  assert.ok(ra.rating > 1000 && rb.rating < 1000);
  assert.equal(ra.wins, 1);
  assert.equal(rb.losses, 1);
  const r0 = ra.rating;
  for (const ev of M.OutboxEvent.docs.filter((e) => e.userId === a)) {
    ev.status = 'pending';
    ev.done = [];
    ev.nextAttemptAt = new Date(0);
  }
  await outbox.sweep();
  assert.equal(rp(a).rating, r0, '재처리 중복 없음');
  M.User.docs.find((d) => d.userId === a && d.guildId === G).money = 10 ** 9;
  assert.equal(rp(a).rating, r0, '칩이 늘어도 점수 그대로');
});

test('랭크: 같은 상대와 반복하면 반영 축소 → 0, 부스팅 의심 감사 로그, 비공개 방 판은 제외', async () => {
  const [a, b] = [uid(3), uid(4)];
  const ratings = [];
  for (let k = 0; k < 8; k++) {
    await pokerHand(a, { net: 100, opponents: [b] });
    ratings.push(rp(a).rating);
  }
  const gains = ratings.map((r, k) => r - (ratings[k - 1] ?? 1000));
  assert.ok(gains[0] > gains[4], '반복할수록 덜 오름');
  assert.equal(gains[7], 0, '6판 넘게 반복하면 0');
  assert.ok(M.AuditLog.docs.some((x) => x.action === 'rank.suspicious' && x.targetId === a), '부스팅 의심 기록');
  const before = rp(a).rating;
  await pokerHand(a, { net: 100, opponents: [uid(99)], roomId: 'room-x' });
  assert.equal(rp(a).rating, before, '비공개 방 판은 랭크 제외');
});

test('랭크: 서버별 분리 · 시즌 종료 처리 1회 · 다음 시즌은 절반 초기화', async () => {
  const a = uid(5);
  await pokerHand(a, { net: 200, opponents: [], seats: 3 });
  await pokerHand(a, { net: 200, opponents: [], seats: 3, g: G2 });
  assert.equal(M.RankProfile.docs.filter((d) => d.userId === a).length, 2, '서버마다 따로');
  const sk = await rankService.seasonKey(G);
  const doc = rp(a);
  doc.rating = 1600;
  doc.peakTier = 'platinum';
  assert.ok((await rankService.closeSeason(G, sk)) >= 1);
  assert.equal((await rankService.closeSeason(G, sk)), 0, '두 번째 종료는 처리할 것 없음');
  assert.ok(M.Profile.docs.find((p) => p.userId === a).achievements.some((x) => x.id === 'rank_plat_season'));
  const next = await rankService.ensure(G, a, 'poker', String(Number(sk) + 1));
  assert.equal(next.rating, 1300, '다음 시즌 시작 점수 = 1000 + (1600−1000)/2');
});

// ───────────────────────── 비공개 방 ─────────────────────────

test('비공개 방: 코드로만 참가 · 원문 코드 미저장 · 다른 서버에서 같은 코드 불가', async () => {
  const owner = uid(10);
  const r = await rooms.create({ guildId: G, ownerId: owner, name: '친구 포커', gameType: 'poker', settings: { amount: 5000, bots: 1, maxHumans: 4 } });
  assert.equal(r.ok, true);
  assert.match(r.code, /^[A-Z2-9]{10}$/);
  const doc = M.PrivateRoom.docs.find((x) => x.roomId === r.room.roomId);
  assert.ok(!JSON.stringify(doc).includes(r.code), 'DB에 코드 원문 없음');
  assert.equal((await rooms.join({ guildId: G2, userId: uid(11), code: r.code })).ok, false, '다른 서버에서는 불가');
  const j = await rooms.join({ guildId: G, userId: uid(11), code: r.code.toLowerCase() });
  assert.equal(j.ok, true);
  assert.equal(await rooms.allowFor(r.room.roomId, uid(11)), null, '멤버는 게임 참가 가능');
  assert.ok(await rooms.allowFor(r.room.roomId, uid(12)), '비멤버는 게임 참가 불가');
});

test('비공개 방: 코드 무차별 대입 잠금 + 감사 로그, 재발급하면 이전 코드 무효', async () => {
  const owner = uid(20);
  const r = await rooms.create({ guildId: G, ownerId: owner, name: '잠금 테스트', gameType: 'tournament', settings: { amount: 2000, bots: 2, maxHumans: 4 } });
  const attacker = uid(21);
  for (let k = 0; k < config.ROOM.JOIN_FAIL_LIMIT; k++) assert.equal((await rooms.join({ guildId: G, userId: attacker, code: `WRONG${k}AAAA` })).ok, false);
  const locked = await rooms.join({ guildId: G, userId: attacker, code: r.code });
  assert.equal(locked.ok, false, '맞는 코드여도 잠금 중');
  assert.ok(M.AuditLog.docs.some((x) => x.action === 'room.code-bruteforce' && x.targetId === attacker));
  const s = await rooms.settings({ guildId: G, ownerId: owner, regenerate: true });
  assert.ok(s.code && s.code !== r.code);
  assert.equal((await rooms.join({ guildId: G, userId: uid(22), code: r.code })).ok, false, '이전 코드 무효');
  assert.equal((await rooms.join({ guildId: G, userId: uid(22), code: s.code })).ok, true);
});

test('비공개 방: 승인제·초대·방장 권한 (방장만 추방·설정·닫기)', async () => {
  const owner = uid(30);
  const r = await rooms.create({ guildId: G, ownerId: owner, name: '승인제 방', gameType: 'poker', settings: { amount: 3000, maxHumans: 3 }, approval: true });
  const guest = uid(31);
  const j = await rooms.join({ guildId: G, userId: guest, code: r.code });
  assert.equal(j.pending, true);
  assert.ok(await rooms.allowFor(r.room.roomId, guest), '승인 전엔 게임 불가');
  assert.equal((await rooms.approve({ guildId: G, ownerId: guest, targetId: guest })).ok, false, '방장만 승인');
  assert.equal((await rooms.approve({ guildId: G, ownerId: owner, targetId: guest })).ok, true);
  assert.equal(await rooms.allowFor(r.room.roomId, guest), null);
  const invited = uid(32);
  await rooms.invite({ guildId: G, ownerId: owner, targetId: invited });
  assert.equal((await rooms.join({ guildId: G, userId: invited })).ok, true, '초대받으면 코드 없이 (승인제여도)');
  assert.equal((await rooms.kick({ guildId: G, ownerId: guest, targetId: invited })).ok, false, '방장 아니면 추방 불가');
  assert.equal((await rooms.kick({ guildId: G, ownerId: owner, targetId: invited })).ok, true);
  assert.equal((await rooms.close({ guildId: G, ownerId: guest })).ok, false);
  assert.equal((await rooms.close({ guildId: G, ownerId: owner })).ok, true);
  assert.ok(await rooms.allowFor(r.room.roomId, guest), '닫힌 방은 게임 불가');
  const bad = await rooms.create({ guildId: G, ownerId: owner, name: '@everyone 방', gameType: 'poker', settings: { amount: 3000 } });
  assert.equal(bad.ok, false, '멘션 이름 거부');
  assert.equal((await rooms.create({ guildId: G, ownerId: owner, name: '슬롯방', gameType: 'slot', settings: { amount: 3000 } })).ok, false, '허용되지 않은 게임');
});

// ───────────────────────── 예측 ─────────────────────────

const T1 = 'tourney-pred-1';
const entrants = [
  { id: uid(40), name: '선수A', type: 'human' },
  { id: uid(41), name: '선수B', type: 'human' },
  { id: 'bot0', name: '봇 알파', type: 'bot' },
];

test('예측: 참가자 본인 불가 · 칩은 에스크로 · 마감 전 교체(이전 칩 환불) · 마감 후 수정 불가', async () => {
  prediction.open(T1, { guildId: G, entrants, players: [uid(40), uid(41)], lockAt: Date.now() + 60_000 });
  assert.equal((await prediction.submit({ tournamentId: T1, guildId: G, userId: uid(40), seatId: uid(40), stake: 0 })).ok, false, '참가자는 예측 불가');
  const [s1, s2, s3] = [uid(50), uid(51), uid(52)];
  for (const s of [s1, s2, s3]) await wallet.getAccount(s, G);
  assert.equal((await prediction.submit({ tournamentId: T1, guildId: G, userId: s1, seatId: 'bot0', stake: 1000 })).ok, true);
  assert.equal(money(s1), 9000, '칩은 에스크로로');
  assert.equal((await prediction.submit({ tournamentId: T1, guildId: G, userId: s1, seatId: uid(40), stake: 5000 })).ok, true, '마감 전 교체');
  assert.equal(money(s1), 5000, '이전 1000 환불 후 5000 묶음');
  assert.equal((await prediction.submit({ tournamentId: T1, guildId: G, userId: s2, seatId: uid(40), stake: 1000 })).ok, true);
  assert.equal((await prediction.submit({ tournamentId: T1, guildId: G, userId: s3, seatId: uid(41), stake: 5000 })).ok, true);
  assert.equal((await prediction.submit({ tournamentId: T1, guildId: G, userId: uid(53), seatId: uid(41), stake: 777 })).ok, false, '정해진 금액만');
  prediction.lock(T1);
  assert.equal((await prediction.submit({ tournamentId: T1, guildId: G, userId: s2, seatId: uid(41), stake: 0 })).ok, false, '마감 후 수정 불가');
  M.Prediction.docs.forEach((p) => p.tournamentId === T1 && (p.lockedAt = new Date(Date.now() - 1)));
});

test('예측: 결과 채점 — 적중자끼리 풀 분배(총액 보존), 다시 채점해도 중복 없음, 점수·연속 적중', async () => {
  const [s1, s2, s3] = [uid(50), uid(51), uid(52)];
  const before = [s1, s2, s3].map((u) => money(u));
  const r = await prediction.resolve({ tournamentId: T1, guildId: G, winnerId: uid(40) });
  assert.equal(r.pool, 11_000);
  assert.equal(r.correct, 2);
  const after = [s1, s2, s3].map((u) => money(u));
  const paid = after.map((x, k) => x - before[k]);
  assert.equal(paid.reduce((a, b) => a + b, 0), 11_000, '풀 전액 분배 (하우스 몫 0)');
  assert.equal(paid[2], 0, '빗나간 사람은 0');
  assert.ok(paid[0] > paid[1], '많이 건 적중자가 더 받음');
  await prediction.resolve({ tournamentId: T1, guildId: G, winnerId: uid(40) });
  assert.deepEqual([s1, s2, s3].map((u) => money(u)), after, '중복 정산 없음');
  const p1 = M.Profile.docs.find((p) => p.userId === s1);
  assert.equal(p1.predict.correct, 1);
  assert.equal(p1.predict.score, config.PREDICTION.SCORE_CORRECT);
  assert.ok(M.SettlementRecord.docs.some((x) => x.settlementId === `prediction:${T1}` && x.status === 'applied'));
  await wait(20);
  assert.equal(M.Profile.docs.find((p) => p.userId === s1).totals?.games ?? 0, 0, '예측 정산은 게임 전적에 안 들어감');
});

test('예측: 적중자 없으면 전액 환불', async () => {
  const T2 = 'tourney-pred-2';
  prediction.open(T2, { guildId: G, entrants, players: [], lockAt: Date.now() + 60_000 });
  const s = uid(60);
  await wallet.getAccount(s, G);
  await prediction.submit({ tournamentId: T2, guildId: G, userId: s, seatId: 'bot0', stake: 5000 });
  assert.equal(money(s), 5000);
  const r = await prediction.resolve({ tournamentId: T2, guildId: G, winnerId: uid(41) });
  assert.equal(r.refunded, true);
  assert.equal(money(s), 10_000);
});
