/**
 * MongoDB 통합 테스트 — 실제 MongoDB의 원자적 업데이트·고유 인덱스·동시성으로 경제 핵심을 검증한다.
 *
 *   MONGODB_TEST_URI=mongodb://localhost:27017 npm run test:integration
 *
 * 안전장치: 항상 무작위 이름의 테스트 전용 DB(casino_it_xxxx)를 만들어 쓰고 끝나면 삭제한다.
 *          NODE_ENV=production 이거나 URI가 없으면 실행하지 않는다 (건너뜀으로 표시 — 통과로 위장하지 않음).
 * CI(.github/workflows/test.yml)에서는 MongoDB 서비스 컨테이너로 항상 실행된다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const URI = process.env.MONGODB_TEST_URI;
const skip = !URI ? 'MONGODB_TEST_URI 없음' : process.env.NODE_ENV === 'production' ? 'production 환경에서는 실행 안 함' : false;

let mongoose;
let wallet;
let outbox;
let M;
const dbName = `casino_it_${crypto.randomBytes(4).toString('hex')}`;
const uid = (n) => String(200000000000000000n + BigInt(n));
const G = '800000000000000001';

test.before(async () => {
  if (skip) return;
  mongoose = require('mongoose');
  await mongoose.connect(URI, { dbName, serverSelectionTimeoutMS: 10_000 });
  for (const m of ['User', 'GameLog', 'Ledger', 'AuditLog', 'OutboxEvent', 'Transfer', 'TransferQuota', 'SettlementRecord', 'Profile', 'SystemState', 'GameState']) require(`../../src/db/${m}`);
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  M = mongoose.models;
  wallet = require('../../src/services/wallet');
  outbox = require('../../src/services/outbox');
  require('../../src/services/profile');
});

test.after(async () => {
  if (skip || !mongoose) return;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const money = async (u, g = G) => (await M.User.findOne({ userId: u, guildId: g }).lean())?.money;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('[통합] 정산 재호출·정산/환불 경합: 칩은 정확히 한 번만', { skip }, async () => {
  const u = uid(1);
  await wallet.getAccount(u, G);
  const r = await wallet.reserve(u, G, 'dice', 1000);
  const results = await Promise.all([
    wallet.settle({ userId: u, guildId: G, roundId: r.roundId, payout: 2000, game: 'dice' }),
    wallet.settle({ userId: u, guildId: G, roundId: r.roundId, payout: 2000, game: 'dice' }),
    wallet.refund({ userId: u, guildId: G, roundId: r.roundId }),
  ]);
  assert.equal(results.filter((x) => x.ok).length, 1);
  const m = await money(u);
  assert.ok(m === 11_000 || m === 10_000, `잔고 ${m}`);
  assert.equal(await M.GameLog.countDocuments({ roundId: r.roundId }), 1);
});

test('[통합] Outbox: 이벤트 1개·중복 처리해도 전적 1회', { skip }, async () => {
  const u = uid(2);
  await wallet.getAccount(u, G);
  const r = await wallet.reserve(u, G, 'slot', 100);
  const st = await wallet.settle({ userId: u, guildId: G, roundId: r.roundId, payout: 300, game: 'slot', wagered: 100 });
  await wait(200);
  await outbox.sweep();
  await M.OutboxEvent.updateOne({ eventId: st.eventId }, { $set: { status: 'pending', done: [], nextAttemptAt: new Date(0) } });
  await Promise.all([outbox.processEvent(st.eventId), outbox.processEvent(st.eventId), outbox.sweep()]);
  const p = await M.Profile.findOne({ userId: u }).lean();
  assert.equal(p.totals.games, 1);
  assert.equal(await M.OutboxEvent.countDocuments({ eventId: st.eventId }), 1);
});

test('[통합] 송금 동시성: 한도 합계 초과 불가·중복 요청 1회', { skip }, async () => {
  const from = uid(3);
  const to = uid(4);
  await wallet.getAccount(from, G);
  await M.User.updateOne({ userId: from, guildId: G }, { $set: { money: 1_000_000 } });
  const day = '2099-01-01';
  const res = await Promise.all(Array.from({ length: 10 }, (_, k) => wallet.transfer({ transferId: `it-${k}`, fromId: from, toId: to, guildId: G, amount: 30_000, fee: 1_500, limit: 100_000, day })));
  const okN = res.filter((r) => r.ok).length;
  assert.equal(okN, 3, `성공 ${okN} (31,500 × 3 = 94,500)`);
  const q = await M.TransferQuota.findOne({ economyKey: G, userId: from, day }).lean();
  assert.ok(q.used <= 100_000);
  assert.equal(await money(from), 1_000_000 - okN * 31_500);
  assert.equal(await money(to), 10_000 + okN * 30_000);
  const dup = await Promise.all(Array.from({ length: 5 }, () => wallet.transfer({ transferId: 'it-dup', fromId: to, toId: from, guildId: G, amount: 1000, fee: 0, limit: 100_000, day })));
  assert.ok(dup.some((r) => r.ok));
  assert.equal(await money(to), 10_000 + okN * 30_000 - 1000);
});

test('[통합] 리더 임대: 동시에 획득 시도해도 한 인스턴스만', { skip }, async () => {
  const instanceLock = require('../../src/services/instanceLock');
  const locks = Array.from({ length: 5 }, (_, k) => instanceLock.create(`it-inst-${k}`));
  const got = await Promise.all(locks.map((l) => l.tryAcquire()));
  assert.equal(got.filter(Boolean).length, 1);
  await Promise.all(locks.map((l) => l.release()));
});
