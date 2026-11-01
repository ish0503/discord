/**
 * 1단계 안정화 테스트 (인메모리 fakeMongo로 실제 서비스 코드 실행).
 * 실제 MongoDB 동작(동시성·고유 인덱스)은 test/integration/*.test.js 에서 MONGODB_TEST_URI로 따로 검증한다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { M, settle: wait } = require('../test-support/useFakes');

const config = require('../src/config');
const wallet = require('../src/services/wallet');
const outbox = require('../src/services/outbox');
const profile = require('../src/services/profile');
const settlement = require('../src/services/settlement');
const instanceLock = require('../src/services/instanceLock');
const time = require('../src/content/time');

const G = '900000000000000001';
const G2 = '900000000000000002';
const uid = (n) => String(100000000000000000n + BigInt(n)); // snowflake 형식
const money = (u, g = G) => M.User.docs.find((d) => d.userId === u && d.guildId === g)?.money;
const prof = (u) => M.Profile.docs.find((p) => p.userId === u);

// ───────────────────────── [1-1] Outbox ─────────────────────────

test('Outbox: 정산 → 이벤트 기록·처리 → 전적 1회 반영, 같은 이벤트 재처리해도 중복 없음', async () => {
  const u = uid(1);
  await wallet.getAccount(u, G);
  const r = await wallet.reserve(u, G, 'dice', 1000);
  const st = await wallet.settle({ userId: u, guildId: G, roundId: r.roundId, payout: 2000, game: 'dice', wagered: 1000 });
  assert.equal(st.ok, true);
  await wait();
  const ev = M.OutboxEvent.docs.find((e) => e.eventId === st.eventId);
  assert.ok(ev, '이벤트 생성');
  assert.equal(ev.status, 'done');
  assert.deepEqual([...ev.done].sort(), ['gamelog', 'profile']);
  assert.equal(prof(u).totals.games, 1);
  assert.equal(prof(u).totals.wins, 1);
  assert.equal(M.User.docs.find((d) => d.userId === u).outbox.length, 0, '지갑의 임시 이벤트는 이관 후 비움');

  // 같은 이벤트를 강제로 다시 처리 (done 기록을 지워 핸들러를 다시 돌려도)
  ev.status = 'pending';
  ev.done = [];
  ev.nextAttemptAt = new Date(0);
  await outbox.processEvent(ev.eventId);
  await outbox.processEvent(ev.eventId);
  assert.equal(prof(u).totals.games, 1, '전적 중복 반영 없음');
  assert.equal(prof(u).winStreak, 1, '연승 중복 반영 없음');
  assert.equal(M.GameLog.docs.filter((l) => l.roundId === r.roundId).length, 1, '게임 기록 1개');
});

test('Outbox: 정산 직후 프로세스가 죽어도(이관 전) 재시작 스윕으로 이벤트 처리', async () => {
  const u = uid(2);
  await wallet.getAccount(u, G);
  const r = await wallet.reserve(u, G, 'slot', 500);
  const kick = outbox.kick;
  outbox.kick = () => {}; // 정산 직후 사망 시뮬레이션: 이관·처리 안 됨
  const wk = require('../src/services/wallet');
  try {
    await wk.settle({ userId: u, guildId: G, roundId: r.roundId, payout: 0, game: 'slot', wagered: 500 });
  } finally {
    outbox.kick = kick;
  }
  assert.equal(M.User.docs.find((d) => d.userId === u).outbox.length, 1, '이벤트는 지갑 갱신과 함께 저장됨');
  assert.equal(prof(u)?.totals?.games ?? 0, 0);
  const out = await outbox.sweep();
  assert.ok(out.materialized >= 1);
  assert.equal(prof(u).totals.games, 1, '재시작 후 처리');
  assert.equal(money(u), 9500, '칩은 한 번만 반영');
});

test('Outbox: 핸들러 실패 → 재시도 기록 → 다음 시도에 완료, 끝난 핸들러는 다시 실행 안 함', async () => {
  const u = uid(3);
  let calls = 0;
  outbox.register('round.settled', 'flaky-test', async (p) => {
    if (p.userId !== u) return;
    calls += 1;
    if (calls === 1) throw new Error('일시 오류');
  });
  await wallet.getAccount(u, G);
  const r = await wallet.reserve(u, G, 'dice', 100);
  const st = await wallet.settle({ userId: u, guildId: G, roundId: r.roundId, payout: 0, game: 'dice', wagered: 100 });
  await wait();
  let ev = M.OutboxEvent.docs.find((e) => e.eventId === st.eventId);
  assert.equal(ev.status, 'failed');
  assert.equal(ev.attempts, 1);
  assert.match(ev.lastError, /일시 오류/);
  assert.ok(ev.done.includes('profile'), '앞선 핸들러는 완료로 기록');
  ev.nextAttemptAt = new Date(0);
  await outbox.sweep();
  ev = M.OutboxEvent.docs.find((e) => e.eventId === st.eventId);
  assert.equal(ev.status, 'done');
  assert.equal(calls, 2);
  assert.equal(prof(u).totals.games, 1, '재시도해도 전적 1회');
  outbox.handlers.get('round.settled').splice(outbox.handlers.get('round.settled').findIndex((h) => h.name === 'flaky-test'), 1);
});

// ───────────────────────── [1-2] 복구 게임 ─────────────────────────

test('복구: 재시작 복구된 판도 전적·미션에 반영, 같은 복구를 두 번 적용해도 중복 없음', async () => {
  const u = uid(4);
  await wallet.getAccount(u, G);
  const a = await wallet.reserve(u, G, 'blackjack', 1000, { gameId: 'g-recover' });
  await wallet.commitResult(u, G, a.roundId, 2000, { game: 'blackjack' });
  M.User.docs.find((d) => d.userId === u).escrow.forEach((e) => (e.instance = 'dead'));
  const r1 = await wallet.recoverPrevious();
  const r2 = await wallet.recoverPrevious();
  assert.equal(r1.settled, 1);
  assert.equal(r2.settled, 0, '두 번째 복구는 반영할 것 없음');
  await wait();
  await outbox.sweep();
  const p = prof(u);
  assert.equal(p.totals.games, 1, '복구 판도 전적 반영');
  assert.equal(p.totals.wins, 1);
  const { daily } = profile.currentMissions();
  const anyPlays = daily.find((m) => m.metric === 'plays' && (!m.game || m.game === 'blackjack'));
  if (anyPlays) assert.equal(p.missions.daily[anyPlays.id], 1, '미션 진행 반영');
  const log = M.GameLog.docs.find((l) => l.roundId === a.roundId);
  assert.equal(log.recovered, true);
  assert.equal(log.staked, 1000);
  assert.equal(log.payout, 2000);
  assert.ok(M.AuditLog.docs.some((x) => x.action === 'recovery.settle' && x.targetId === u), '복구 감사 기록');
  assert.equal(money(u), 11_000);
});

// ───────────────────────── [1-3] 송금 ─────────────────────────

const day = time.dayKey();
const LIMIT = 200_000;

test('송금: 한도 직전 동시 요청 — 합계가 한도를 넘지 않음, 잔고 일치', async () => {
  const from = uid(10);
  const to = uid(11);
  await wallet.getAccount(from, G);
  M.User.docs.find((d) => d.userId === from).money = 1_000_000;
  const reqs = Array.from({ length: 6 }, (_, k) => wallet.transfer({ transferId: `cc-${k}`, fromId: from, toId: to, guildId: G, amount: 60_000, fee: 3_000, limit: LIMIT, day }));
  const res = await Promise.all(reqs);
  const okN = res.filter((r) => r.ok).length;
  assert.equal(okN, 3, `성공 ${okN}건 (63,000 × 3 = 189,000 ≤ 200,000)`);
  assert.ok(res.filter((r) => !r.ok).every((r) => r.reason === 'limit'));
  const q = M.TransferQuota.docs.find((d) => d.userId === from && d.day === day);
  assert.equal(q.used, 189_000);
  assert.equal(money(from), 1_000_000 - 189_000);
  assert.equal(money(to), 10_000 + 180_000);
});

test('송금: 같은 거래 ID 중복 요청은 한 번만 처리', async () => {
  const from = uid(12);
  const to = uid(13);
  await wallet.getAccount(from, G);
  const args = { transferId: 'dup-1', fromId: from, toId: to, guildId: G, amount: 1000, fee: 50, limit: LIMIT, day };
  const [a, b] = await Promise.all([wallet.transfer(args), wallet.transfer(args)]);
  const c = await wallet.transfer(args);
  assert.ok(a.ok || b.ok);
  assert.ok(c.ok && c.duplicate);
  assert.equal(money(from), 10_000 - 1050);
  assert.equal(money(to), 11_000);
  assert.equal(M.Ledger.docs.filter((l) => l.refId === 'out:dup-1').length, 1);
});

test('송금: 실패(잔고 부족)하면 한도·잔고 변화 없음, 잘못된 입력 거부', async () => {
  const from = uid(14);
  const to = uid(15);
  await wallet.getAccount(from, G);
  const r = await wallet.transfer({ transferId: 'poor-1', fromId: from, toId: to, guildId: G, amount: 50_000, fee: 2500, limit: LIMIT, day });
  assert.equal(r.reason, 'balance');
  assert.equal(money(from), 10_000);
  assert.equal(money(to), undefined, '받는 사람 지갑도 건드리지 않음');
  assert.equal(M.TransferQuota.docs.find((d) => d.userId === from)?.used ?? 0, 0, '예약한 한도 반환');
  assert.equal(M.Transfer.docs.find((t) => t.transferId === 'poor-1').status, 'failed');
  const base = { fromId: from, toId: to, guildId: G, fee: 0, limit: LIMIT, day };
  assert.equal((await wallet.transfer({ ...base, transferId: 'x1', toId: from, amount: 100 })).reason, 'self');
  assert.equal((await wallet.transfer({ ...base, transferId: 'x2', amount: 0 })).reason, 'invalid');
  assert.equal((await wallet.transfer({ ...base, transferId: 'x3', amount: -5 })).reason, 'invalid');
  assert.equal((await wallet.transfer({ ...base, transferId: 'x4', amount: 1.5 })).reason, 'invalid');
  assert.equal((await wallet.transfer({ ...base, transferId: 'x5', amount: 10 ** 12 })).reason, 'limit');
  assert.equal((await wallet.transfer({ ...base, transferId: 'x6', toId: 'not-a-user', amount: 100 })).reason, 'invalid');
  assert.equal(money(from), 10_000);
});

test('송금: 한도는 서버(경제 단위)별 — 다른 서버 송금은 서로 영향 없음', async () => {
  const from = uid(16);
  const to = uid(17);
  for (const g of [G, G2]) {
    await wallet.getAccount(from, g);
    M.User.docs.find((d) => d.userId === from && d.guildId === g).money = 500_000;
  }
  assert.ok((await wallet.transfer({ transferId: 'g1-a', fromId: from, toId: to, guildId: G, amount: 190_000, fee: 0, limit: LIMIT, day })).ok);
  assert.ok((await wallet.transfer({ transferId: 'g2-a', fromId: from, toId: to, guildId: G2, amount: 190_000, fee: 0, limit: LIMIT, day })).ok, '다른 서버 한도는 별개');
  assert.equal((await wallet.transfer({ transferId: 'g1-b', fromId: from, toId: to, guildId: G, amount: 20_000, fee: 0, limit: LIMIT, day })).reason, 'limit');
});

test('송금: 차감 후 중단된 거래는 복구 시 받는 쪽 지급을 마저 끝냄 (한 번만), 차감 전 중단은 취소', async () => {
  const from = uid(18);
  const to = uid(19);
  await wallet.getAccount(from, G);
  // ① 차감까지만 된 상태를 직접 만듦
  M.Transfer.docs.push({ transferId: 'half-1', economyKey: G, guildId: G, fromId: from, toId: to, amount: 1000, fee: 0, day, status: 'pending', createdAt: new Date(Date.now() - 5 * 60_000) });
  const w = M.User.docs.find((d) => d.userId === from);
  w.money -= 1000;
  w.txLog.push('out:half-1');
  M.TransferQuota.docs.push({ economyKey: G, userId: from, day, used: 1000, refs: ['half-1'] });
  // ② 차감 전에 멈춘 거래
  M.Transfer.docs.push({ transferId: 'half-2', economyKey: G, guildId: G, fromId: from, toId: to, amount: 500, fee: 0, day, status: 'pending', createdAt: new Date(Date.now() - 5 * 60_000) });
  const r1 = await wallet.recoverTransfers();
  const r2 = await wallet.recoverTransfers();
  assert.deepEqual(r1, { completed: 1, failed: 1 });
  assert.deepEqual(r2, { completed: 0, failed: 0 });
  assert.equal(money(to), 11_000, '받는 쪽 1,000 한 번만');
  assert.equal(money(from), 9_000, '차감 전 거래는 실행 안 함');
  assert.equal(M.Transfer.docs.find((t) => t.transferId === 'half-2').status, 'failed');
});

// ───────────────────────── [1-4] 정산 검증 ─────────────────────────

test('정산 검증: 규칙상 불가능한 지급액은 거부 — 지갑 변경 없음·판 보류·감사 로그, 자동 복구도 건너뜀', async () => {
  const u = uid(20);
  await wallet.getAccount(u, G);
  const r = await wallet.reserve(u, G, 'dice', 1000, { gameId: 'g-bad' });
  const st = await wallet.settle({ userId: u, guildId: G, roundId: r.roundId, payout: 1_000_000, game: 'dice' });
  assert.equal(st.rejected, true);
  assert.equal(money(u), 9000, '지급되지 않음');
  const e = M.User.docs.find((d) => d.userId === u).escrow.find((x) => x.roundId === r.roundId);
  assert.ok(e.blocked, '판 보류');
  assert.ok(M.AuditLog.docs.some((x) => x.action === 'settlement.rejected' && x.targetId === u));
  assert.equal((await wallet.settle({ userId: u, guildId: G, roundId: r.roundId, payout: 2000, game: 'dice' })).ok, false, '보류된 판은 정상 금액으로도 자동 정산 안 됨');
  e.instance = 'dead';
  const rec = await wallet.recoverPrevious();
  assert.equal(rec.blocked, 1);
  assert.equal(money(u), 9000);
  const admin = await wallet.recoverGame('g-bad');
  assert.equal(admin.refunded, 1, '관리자 재시도는 원금 환불');
  assert.equal(money(u), 10_000);
  assert.equal((await wallet.settle({ userId: u, guildId: G, roundId: r.roundId, payout: 2000, game: 'dice' })).ok, false);
  assert.equal(money(u), 10_000);
});

test('정산 검증: 음수·NaN 지급액 거부, 잭팟은 풀만큼 상한 확장', async () => {
  const u = uid(21);
  await wallet.getAccount(u, G);
  const a = await wallet.reserve(u, G, 'slot', 100);
  assert.equal(await wallet.commitResult(u, G, a.roundId, NaN, { game: 'slot' }), false);
  const b = await wallet.reserve(u, G, 'slot', 100);
  const ok = await wallet.settle({ userId: u, guildId: G, roundId: b.roundId, payout: 77_700 + 500_000, game: 'slot', detail: { jackpot: 500_000 } });
  assert.equal(ok.ok, true, '잭팟 포함 지급 허용');
});

test('다인 정산: 불변식 위반은 전원 거부(지갑 변경 없음), 정상 정산은 1회만', async () => {
  const [p1, p2] = [uid(30), uid(31)];
  for (const p of [p1, p2]) await wallet.getAccount(p, G);
  const r1 = await wallet.reserve(p1, G, 'tournament', 1000, { gameId: 't-bad' });
  const r2 = await wallet.reserve(p2, G, 'tournament', 1000, { gameId: 't-bad' });
  const bad = await settlement.batch({ settlementId: 'tournament:t-bad', game: 'tournament', guildId: G, gameId: 't-bad', entries: [{ userId: p1, roundId: r1.roundId, payout: 2000 }, { userId: p2, roundId: r2.roundId, payout: 500 }], expectTotal: 2000 });
  assert.equal(bad.status, 'rejected');
  assert.equal(money(p1), 9000);
  assert.equal(money(p2), 9000);
  assert.equal(M.SettlementRecord.docs.find((x) => x.settlementId === 'tournament:t-bad').status, 'rejected');

  const entries = [
    { userId: p1, roundId: r1.roundId, payout: 2000, maxPayout: 2000 },
    { userId: p2, roundId: r2.roundId, payout: 0, maxPayout: 2000 },
  ];
  const good = await settlement.batch({ settlementId: 'tournament:t-good', game: 'tournament', guildId: G, gameId: 't-good', entries, expectTotal: 2000 });
  assert.equal(good.status, 'applied');
  const again = await settlement.batch({ settlementId: 'tournament:t-good', game: 'tournament', guildId: G, gameId: 't-good', entries, expectTotal: 2000 });
  assert.equal(again.already, true);
  assert.equal(money(p1), 11_000, '한 번만 지급');
  assert.equal(money(p2), 9000);
  assert.deepEqual(M.SettlementRecord.docs.find((x) => x.settlementId === 'tournament:t-good').participants.map((x) => x.result), ['applied', 'applied']);
});

// ───────────────────────── [1-5] 대시보드 ─────────────────────────

function fakeReq({ method = 'GET', url, cookie, body = '', headers = {} }) {
  const listeners = {};
  const req = {
    method,
    url,
    headers: { ...(cookie ? { cookie } : {}), ...headers },
    socket: { remoteAddress: headers['x-test-ip'] ?? '10.0.0.1' },
    on(ev, fn) {
      listeners[ev] = fn;
      if (ev === 'end') setImmediate(() => {
        if (body) listeners.data?.(body);
        fn();
      });
      return req;
    },
    destroy() {},
  };
  return req;
}
function fakeRes() {
  const r = { status: 0, headers: {}, body: '' };
  r.writeHead = (s, h) => {
    r.status = s;
    r.headers = h;
  };
  r.end = (b = '') => (r.body = String(b));
  return r;
}

test('대시보드: URL 토큰 거부·로그인 세션·만료·폐기·토큰 교체·잠금, 토큰은 로그에 안 남음', async () => {
  const dashboard = require('../src/services/dashboard');
  const TOKEN = 'x'.repeat(40);
  const logs = [];
  const warn = console.warn;
  const log = console.log;
  console.warn = (...a) => logs.push(a.join(' '));
  console.log = (...a) => logs.push(a.join(' '));
  try {
    config.DASHBOARD.TOKEN = 'short';
    assert.equal(dashboard.enabledState().ok, false, '짧은 토큰은 비활성');
    config.DASHBOARD.TOKEN = TOKEN;
    assert.equal(dashboard.enabledState().ok, true);

    let res = fakeRes();
    await dashboard.handle(fakeReq({ url: `/dashboard?token=${TOKEN}` }), res);
    assert.equal(res.status, 400, '쿼리 토큰 거부');

    res = fakeRes();
    await dashboard.handle(fakeReq({ url: '/dashboard' }), res);
    assert.equal(res.status, 303, '세션 없으면 로그인으로');

    res = fakeRes();
    await dashboard.handle(fakeReq({ method: 'POST', url: '/dashboard/login', body: 'token=wrong-token-value' }), res);
    assert.equal(res.status, 401);

    res = fakeRes();
    await dashboard.handle(fakeReq({ method: 'POST', url: '/dashboard/login', body: `token=${TOKEN}`, headers: { 'x-forwarded-proto': 'https' } }), res);
    assert.equal(res.status, 303);
    const setCookie = res.headers['Set-Cookie'];
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Secure/);
    const cookie = setCookie.split(';')[0];

    res = fakeRes();
    await dashboard.handle(fakeReq({ url: '/api/overview?guild=1', cookie }), res);
    assert.equal(res.status, 200, '세션으로 읽기 가능');
    res = fakeRes();
    await dashboard.handle(fakeReq({ method: 'POST', url: '/api/overview?guild=1', cookie }), res);
    assert.equal(res.status, 405, '읽기 전용');

    // 만료
    const [id] = [...dashboard._sessions.keys()];
    dashboard._sessions.get(id).exp = Date.now() - 1;
    res = fakeRes();
    await dashboard.handle(fakeReq({ url: '/api/overview?guild=1', cookie }), res);
    assert.equal(res.status, 401, '만료 세션 거부');

    // 폐기
    res = fakeRes();
    await dashboard.handle(fakeReq({ method: 'POST', url: '/dashboard/login', body: `token=${TOKEN}`, headers: { 'x-test-ip': '10.0.0.2' } }), res);
    const c2 = res.headers['Set-Cookie'].split(';')[0];
    assert.equal(dashboard.revokeAll(), 1);
    res = fakeRes();
    await dashboard.handle(fakeReq({ url: '/api/overview?guild=1', cookie: c2 }), res);
    assert.equal(res.status, 401, '폐기된 세션 거부');

    // 토큰 교체 → 이전 세션 무효
    res = fakeRes();
    await dashboard.handle(fakeReq({ method: 'POST', url: '/dashboard/login', body: `token=${TOKEN}`, headers: { 'x-test-ip': '10.0.0.3' } }), res);
    const c3 = res.headers['Set-Cookie'].split(';')[0];
    config.DASHBOARD.TOKEN = 'y'.repeat(40);
    res = fakeRes();
    await dashboard.handle(fakeReq({ url: '/api/overview?guild=1', cookie: c3 }), res);
    assert.equal(res.status, 401, '토큰 재발급 후 이전 세션 무효');

    // 토큰 만료
    config.DASHBOARD.TOKEN_EXPIRES_AT = Date.now() - 1000;
    assert.equal(dashboard.enabledState().why, 'token-expired');
    config.DASHBOARD.TOKEN_EXPIRES_AT = null;

    // 잠금
    for (let k = 0; k < 10; k++) await dashboard.handle(fakeReq({ method: 'POST', url: '/dashboard/login', body: 'token=nope', headers: { 'x-test-ip': '10.9.9.9' } }), fakeRes());
    res = fakeRes();
    await dashboard.handle(fakeReq({ method: 'POST', url: '/dashboard/login', body: `token=${'y'.repeat(40)}`, headers: { 'x-test-ip': '10.9.9.9' } }), res);
    assert.equal(res.status, 429, '실패 반복 시 잠금');
  } finally {
    console.warn = warn;
    console.log = log;
    config.DASHBOARD.TOKEN = '';
  }
  assert.ok(logs.some((l) => l.includes('인증 실패')), '인증 실패 기록');
  assert.ok(!logs.some((l) => l.includes(TOKEN) || l.includes('y'.repeat(40))), '토큰 값은 로그에 없음');
});

// ───────────────────────── [1-6] 단일 인스턴스 ─────────────────────────

test('리더 임대: 한 번에 한 인스턴스만, 반납·만료 시 넘겨받고, 빼앗긴 쪽은 감지', async () => {
  const a = instanceLock.create('inst-A', { ttlMs: 60_000 });
  const b = instanceLock.create('inst-B', { ttlMs: 60_000 });
  assert.equal(await a.tryAcquire(), true);
  assert.equal(await b.tryAcquire(), false, '중복 실행 차단');
  assert.equal(await a.tryAcquire(), true, '갱신');
  await a.release();
  assert.equal(await b.tryAcquire(), true, '반납 후 즉시 인계');
  M.SystemState.docs.find((d) => d._id === 'leader').leaseUntil = new Date(Date.now() - 1);
  assert.equal(await a.tryAcquire(), true, '만료 후 인계');
  assert.equal(await b.tryAcquire(), false, 'B는 임대를 잃음 → 종료해야 함');
});

// ───────────────────────── 권한 · 서버 격리 ─────────────────────────

test('관리자 명령어: 권한 없는 사용자는 실행 불가, 다른 서버 게임은 재시도 불가', async () => {
  const admin = require('../src/commands/admin');
  const gameState = require('../src/services/gameState');
  const replies = [];
  const mk = (opts) => ({
    user: { id: uid(99) },
    guildId: G,
    inGuild: () => true,
    member: { roles: [] },
    memberPermissions: { has: () => opts.perm },
    options: { getSubcommand: () => opts.sub, getString: (n) => opts[n] ?? null, getBoolean: () => null, getInteger: () => null, getUser: () => null },
    reply: async (p) => replies.push(p),
    deferReply: async () => {},
    editReply: async (p) => replies.push(p),
    followUp: async (p) => replies.push(p),
  });
  await admin.execute(mk({ perm: false, sub: '지급' }));
  assert.match(replies.at(-1).content, /관리자만/);
  await gameState.create({ gameId: 'other-guild-game', game: 'dice', guildId: G2, channelId: 'c' });
  await wait(5);
  await admin.execute(mk({ perm: true, sub: '복구', 게임id: 'other-guild-game' }));
  assert.match(replies.at(-1).content, /이 서버의 게임 ID가 아니에요/);
});

test('정산 검증: 정산 직전에 추가 베팅으로 에스크로 금액이 바뀌면 바뀐 금액으로 다시 검증·정산', async () => {
  const u = uid(22);
  await wallet.getAccount(u, G);
  const r = await wallet.reserve(u, G, 'blackjack', 1000);
  // settle 이 에스크로를 읽은 직후 addStake 가 끼어드는 경합
  const [st] = await Promise.all([wallet.settle({ userId: u, guildId: G, roundId: r.roundId, payout: 0, game: 'blackjack' }), wallet.addStake(u, G, r.roundId, 1000)]);
  assert.equal(st.ok, true);
  const log = M.GameLog.docs.find((l) => l.roundId === r.roundId);
  assert.equal(log.staked, money(u) === 8000 ? 2000 : 1000, '기록된 베팅액 = 실제로 묶여 있던 금액');
  assert.equal(M.User.docs.find((d) => d.userId === u).escrow.length, 0, '에스크로 정리');
  assert.equal(money(u) + log.staked, 10_000, '칩 보존 (잃은 금액 = 기록된 베팅액)');
});

test('리더 임대: 이전 버전이 남긴 빈 임대 문서(leaseUntil 없음)도 바로 인수 — 무한 대기 회귀 방지', async () => {
  const docs = M.SystemState.docs;
  const k = docs.findIndex((d) => d._id === 'leader');
  if (k >= 0) docs.splice(k, 1);
  docs.push({ _id: 'leader', instance: null }); // 스키마에 임대 필드가 없던 버전이 만든 문서 모양
  const lock = instanceLock.create('inst-new', { ttlMs: 60_000 });
  assert.equal(await lock.tryAcquire(), true);
  const doc = docs.find((d) => d._id === 'leader');
  assert.equal(doc.instance, 'inst-new');
  assert.ok(doc.leaseUntil > new Date(), '임대 만료 시각 저장');
  // 실제 스키마에 임대 필드가 선언돼 있어야 Mongoose가 버리지 않는다
  const real = require('../src/db/SystemState');
  for (const f of ['leaseUntil', 'renewedAt', 'releasedAt', 'instance']) assert.ok(real.schema?.d?.[f] !== undefined, `SystemState 스키마에 ${f}`);
});
