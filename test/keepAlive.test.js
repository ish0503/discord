const test = require('node:test');
const assert = require('node:assert/strict');
const keepAlive = require('../src/services/keepAlive');

test('keep-alive: URL·간격 해석', () => {
  assert.deepEqual(keepAlive.resolve({ KOYEB_PUBLIC_DOMAIN: 'my-bot-org.koyeb.app' }), { url: 'https://my-bot-org.koyeb.app/health', intervalMs: keepAlive.DEFAULT_INTERVAL_MS });
  assert.equal(keepAlive.resolve({ KOYEB_PUBLIC_DOMAIN: 'https://my-bot-org.koyeb.app/' }).url, 'https://my-bot-org.koyeb.app/health', '스킴·끝 슬래시 정리');
  assert.equal(keepAlive.resolve({ KEEP_ALIVE_URL: 'https://x.example/ping', KOYEB_PUBLIC_DOMAIN: 'y.koyeb.app' }).url, 'https://x.example/ping', '직접 지정이 우선');
  assert.equal(keepAlive.resolve({ KEEP_ALIVE_URL: 'x.example/health' }).url, 'https://x.example/health');
  assert.equal(keepAlive.resolve({ KOYEB_PUBLIC_DOMAIN: 'a.koyeb.app', KEEP_ALIVE_INTERVAL_MS: '1000' }).intervalMs, keepAlive.MIN_INTERVAL_MS, '최소 간격');
  assert.equal(keepAlive.resolve({ KOYEB_PUBLIC_DOMAIN: 'a.koyeb.app', KEEP_ALIVE_INTERVAL_MS: '120000' }).intervalMs, 120_000);
  assert.ok(keepAlive.resolve({}).disabled, '공개 주소 없으면 꺼짐');
  assert.ok(keepAlive.resolve({ KEEP_ALIVE: 'false', KOYEB_PUBLIC_DOMAIN: 'a.koyeb.app' }).disabled);
});

test('keep-alive: 핑 성공·연속 실패 콜백', async () => {
  const quiet = { log() {}, warn() {} };
  const calls = [];
  let ok = false;
  const fetchFn = async (url, opts) => {
    calls.push([url, opts.headers['User-Agent']]);
    return { ok, status: ok ? 200 : 503 };
  };
  const fails = [];
  const ka = keepAlive.start({ env: { KOYEB_PUBLIC_DOMAIN: 'a.koyeb.app' }, fetchFn, onFail: (n) => fails.push(n), log: quiet });
  assert.equal(await ka.ping(), false);
  assert.equal(await ka.ping(), false);
  assert.deepEqual(fails, [1, 2]);
  ok = true;
  assert.equal(await ka.ping(), true);
  ok = false;
  await ka.ping();
  assert.deepEqual(fails, [1, 2, 1], '성공하면 연속 실패 수 초기화');
  assert.deepEqual(calls[0], ['https://a.koyeb.app/health', 'casino-bot-keepalive']);
  ka.stop();
  const off = keepAlive.start({ env: {}, log: quiet });
  assert.ok(off.disabled);
  off.stop();
});
