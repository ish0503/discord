/**
 * 읽기 전용 웹 대시보드 (헬스 체크 서버에 붙음).
 *
 * 인증 (URL 쿼리 토큰은 지원하지 않음 — 주소창·프록시 로그·브라우저 기록에 남기 때문):
 *   GET  /dashboard/login              로그인 폼
 *   POST /dashboard/login (token=…)    DASHBOARD_TOKEN과 비교 → 무작위 세션 ID를 HttpOnly·SameSite=Strict(·Secure) 쿠키로 발급
 *   POST /dashboard/logout             세션 폐기
 *   GET  /dashboard?guild=…&period=7d  HTML (세션 쿠키 필요)
 *   GET  /api/overview?guild=…         JSON (세션 쿠키 또는 Authorization: Bearer <DASHBOARD_TOKEN>)
 *
 * 정책
 *   - DASHBOARD_TOKEN은 32자 이상 무작위 값이어야 함 (짧으면 대시보드 비활성)
 *   - 비교는 SHA-256 다이제스트끼리 timingSafeEqual (길이 노출 없음)
 *   - 세션 만료: DASHBOARD_SESSION_TTL_MS (기본 1시간). 토큰 만료: DASHBOARD_TOKEN_EXPIRES_AT (선택, ISO 날짜)
 *   - 재발급: DASHBOARD_TOKEN을 바꾸고 재시작 → 이전 토큰으로 만든 세션은 모두 무효 (세션이 토큰 지문에 묶임)
 *   - 폐기: /관리자 대시보드세션폐기 (감사 로그) 또는 /dashboard/logout
 *   - 인증 실패는 IP·경로만 기록 (토큰 값은 절대 기록하지 않음), IP당 15분에 10회 실패하면 잠금
 *   - 배포 환경은 HTTPS 전제 (Koyeb 기본 제공). 쿠키 Secure 속성은 X-Forwarded-Proto=https 또는 DASHBOARD_COOKIE_SECURE=true일 때
 * 쓰기 작업은 제공하지 않음 (관리 작업은 /관리자 명령어 + 감사 로그).
 */
const crypto = require('node:crypto');
const config = require('../config');
const stats = require('./stats');
const registry = require('../games/registry');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const n = (x) => Math.round(x).toLocaleString('en-US');
const pct = (x) => `${(x * 100).toFixed(2)}%`;

const D = config.DASHBOARD;
const COOKIE = 'casino_dash';
const sessions = new Map(); // sessionId → { exp, tokenFp, ip }
const failures = new Map(); // ip → { count, first }
const FAIL_WINDOW_MS = 15 * 60_000;
const FAIL_MAX = 10;

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
const fingerprint = () => sha(`fp:${D.TOKEN}`).toString('hex').slice(0, 16);

/** 대시보드 사용 가능 여부와 사유 */
function enabledState(now = Date.now()) {
  if (!D.TOKEN) return { ok: false, why: 'disabled' };
  if (D.TOKEN.length < D.MIN_TOKEN_LENGTH) return { ok: false, why: 'weak-token' };
  if (D.TOKEN_EXPIRES_AT && now > D.TOKEN_EXPIRES_AT) return { ok: false, why: 'token-expired' };
  return { ok: true };
}

/** 토큰 비교: 다이제스트끼리 상수 시간 비교 */
function tokenMatches(given) {
  if (typeof given !== 'string' || !given) return false;
  return crypto.timingSafeEqual(sha(given), sha(D.TOKEN));
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?').split(',')[0].trim();
}

function locked(ip, now = Date.now()) {
  const f = failures.get(ip);
  if (!f) return false;
  if (now - f.first > FAIL_WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return f.count >= FAIL_MAX;
}

function recordFailure(ip, path, why) {
  const now = Date.now();
  const f = failures.get(ip);
  if (!f || now - f.first > FAIL_WINDOW_MS) failures.set(ip, { count: 1, first: now });
  else f.count += 1;
  console.warn(`[dashboard] 인증 실패 ip=${ip} path=${path} 사유=${why} (최근 ${failures.get(ip).count}회)`); // 토큰 값은 기록하지 않음
}

function newSession(ip) {
  const id = crypto.randomBytes(32).toString('base64url');
  sessions.set(id, { exp: Date.now() + D.SESSION_TTL_MS, tokenFp: fingerprint(), ip });
  return id;
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k, v]) => k && v)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]),
  );
}

/** 요청의 세션 확인 (만료·토큰 교체·폐기된 세션은 거부) */
function sessionOf(req, now = Date.now()) {
  const id = parseCookies(req)[COOKIE];
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (s.exp < now || s.tokenFp !== fingerprint()) {
    sessions.delete(id);
    return null;
  }
  return { id, ...s };
}

function bearerOk(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') && tokenMatches(h.slice(7).trim());
}

/** 모든 세션 폐기 (관리자 명령어) */
function revokeAll() {
  const count = sessions.size;
  sessions.clear();
  return count;
}

function secureCookie(req) {
  return D.COOKIE_SECURE || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS, ...extra });
  res.end(body);
}

function readBody(req, max = 4096) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > max) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function page(title, body) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{--bg:#f6f7f9;--fg:#1d2330;--card:#fff;--muted:#667;--line:#e3e6eb;--accent:#2f6fe4}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--fg:#e8eaee;--card:#1d2128;--muted:#99a;--line:#2c313a;--accent:#6f9cff}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Noto Sans KR",sans-serif}
main{max-width:1000px;margin:auto;padding:24px}h1{font-size:22px}h2{font-size:17px;margin-top:28px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}.card b{display:block;font-size:20px}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;background:var(--card)}th,td{border-bottom:1px solid var(--line);padding:8px;text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left}small,.muted{color:var(--muted)}a{color:var(--accent)}
</style></head><body><main>${body}</main></body></html>`;
}

async function render(url, client) {
  const guild = url.searchParams.get('guild');
  const period = url.searchParams.get('period') || '7d';
  if (!guild) {
    const list = client ? [...client.guilds.cache.values()] : [];
    return page('카지노 대시보드', `<h1>🎰 카지노 대시보드</h1><p>서버를 선택하세요.</p><ul>${list.map((g) => `<li><a href="/dashboard?guild=${encodeURIComponent(g.id)}">${esc(g.name)}</a> <small>${g.id}</small></li>`).join('')}</ul>`);
  }
  const [o, bal] = await Promise.all([stats.overview(guild, period), stats.balance(guild, period === '24h' ? '7d' : period)]);
  const periods = Object.keys(stats.PERIODS).map((p) => `<a href="/dashboard?guild=${encodeURIComponent(guild)}&period=${p}">${p}</a>`).join(' · ');
  return page(
    '카지노 대시보드',
    `<h1>🎰 카지노 대시보드 <small>${esc(guild)}</small></h1><p class="muted">기간: ${periods} · 현재 ${esc(period)}</p>
<div class="cards">
<div class="card">총 베팅<b>${n(o.totals.staked)}</b></div>
<div class="card">총 지급<b>${n(o.totals.payout)}</b></div>
<div class="card">실제 RTP<b>${pct(o.totals.rtp)}</b></div>
<div class="card">하우스 순손익<b>${n(o.totals.houseNet)}</b></div>
<div class="card">활성 플레이어<b>${n(o.activePlayers)}</b></div>
<div class="card">시간당 게임<b>${o.gamesPerHour.toFixed(1)}</b></div>
<div class="card">유통 칩<b>${n(o.supply.money)}</b><small>묶임 ${n(o.supply.escrow)}</small></div>
<div class="card">발행 / 회수<b>${n(o.minted)} / ${n(o.burned)}</b></div>
<div class="card">복구 정산 / 확인 필요<b>${n(o.recovered)} / ${n(o.needRecovery)}</b></div>
</div>
<h2>게임별</h2><div class="wrap"><table><tr><th>게임</th><th>판</th><th>플레이어</th><th>베팅</th><th>지급</th><th>실제 RTP</th></tr>
${o.byGame.map((g) => `<tr><td>${esc(registry.label(g._id))}</td><td>${n(g.rounds)}</td><td>${n(g.players)}</td><td>${n(g.staked)}</td><td>${n(g.payout)}</td><td>${pct(g.payout / Math.max(1, g.staked))}</td></tr>`).join('')}
</table></div>
<h2>설계 RTP vs 실제 RTP</h2><div class="wrap"><table><tr><th>게임 (종류)</th><th>표본</th><th>설계</th><th>실제</th><th>z</th><th>판정</th></tr>
${bal.map((r) => `<tr><td>${esc(registry.label(r.game))}${r.sub ? ` (${esc(r.sub)})` : ''}</td><td>${n(r.n)}</td><td>${r.design != null ? pct(r.design) : '—'}</td><td>${pct(r.actual)}</td><td>${r.z != null ? r.z.toFixed(2) : '—'}</td><td>${esc(r.verdict)}</td></tr>`).join('')}
</table></div>
<form method="post" action="/dashboard/logout"><button>로그아웃</button></form>
<p class="muted">RTP = 지급액(원금 포함) ÷ 베팅액. 읽기 전용 화면입니다. 관리 작업은 디스코드의 /관리자 명령어로 하며 모두 감사 로그에 남습니다.</p>`,
  );
}

function loginPage(msg = '') {
  return page(
    '대시보드 로그인',
    `<h1>🎰 카지노 대시보드</h1>${msg ? `<p class="muted">${esc(msg)}</p>` : ''}
<form method="post" action="/dashboard/login"><label>관리 토큰<br><input type="password" name="token" autocomplete="current-password" required style="width:100%;max-width:420px;padding:8px"></label><br><br><button>로그인</button></form>
<p class="muted">토큰은 URL에 넣지 마세요. 로그인하면 ${Math.round(D.SESSION_TTL_MS / 60000)}분 동안 유지되는 세션 쿠키가 발급됩니다.</p>`,
  );
}

const PATHS = ['/dashboard', '/dashboard/login', '/dashboard/logout', '/api/overview'];

/** 처리했으면 true */
async function handle(req, res, client) {
  const url = new URL(req.url, 'http://localhost');
  if (!PATHS.includes(url.pathname)) return false;
  const state = enabledState();
  if (!state.ok) {
    if (state.why === 'weak-token') console.warn(`[dashboard] DASHBOARD_TOKEN이 ${D.MIN_TOKEN_LENGTH}자 미만이라 비활성화됨`);
    send(res, 404, 'text/plain; charset=utf-8', state.why === 'token-expired' ? 'dashboard token expired' : 'dashboard disabled');
    return true;
  }
  const ip = clientIp(req);
  if (url.searchParams.has('token')) {
    // 예전 방식(쿼리 토큰) 차단 — 값은 기록하지 않음
    recordFailure(ip, url.pathname, 'query-token');
    send(res, 400, 'text/plain; charset=utf-8', 'URL 토큰은 보안상 더 이상 지원하지 않습니다. /dashboard/login 에서 로그인하세요.');
    return true;
  }
  if (locked(ip)) {
    send(res, 429, 'text/plain; charset=utf-8', 'too many failed attempts');
    return true;
  }
  try {
    if (url.pathname === '/dashboard/login') {
      if (req.method !== 'POST') {
        send(res, 200, 'text/html; charset=utf-8', loginPage());
        return true;
      }
      const body = new URLSearchParams(await readBody(req));
      if (!tokenMatches(body.get('token') || '')) {
        recordFailure(ip, url.pathname, 'bad-token');
        send(res, 401, 'text/html; charset=utf-8', loginPage('토큰이 올바르지 않아요.'));
        return true;
      }
      failures.delete(ip);
      const id = newSession(ip);
      const cookie = `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(D.SESSION_TTL_MS / 1000)}${secureCookie(req) ? '; Secure' : ''}`;
      console.log(`[dashboard] 로그인 ip=${ip}`);
      send(res, 303, 'text/plain; charset=utf-8', '', { 'Set-Cookie': cookie, Location: '/dashboard' });
      return true;
    }
    if (url.pathname === '/dashboard/logout') {
      const s = sessionOf(req);
      if (s) sessions.delete(s.id);
      send(res, 303, 'text/plain; charset=utf-8', '', { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`, Location: '/dashboard/login' });
      return true;
    }
    const authed = sessionOf(req) || (url.pathname === '/api/overview' && bearerOk(req));
    if (!authed) {
      if (parseCookies(req)[COOKIE] || req.headers.authorization) recordFailure(ip, url.pathname, 'invalid-session');
      if (url.pathname === '/dashboard') send(res, 303, 'text/plain; charset=utf-8', '', { Location: '/dashboard/login' });
      else send(res, 401, 'text/plain; charset=utf-8', 'unauthorized');
      return true;
    }
    if (req.method !== 'GET') {
      send(res, 405, 'text/plain; charset=utf-8', 'read only');
      return true;
    }
    if (url.pathname === '/api/overview') {
      const guild = url.searchParams.get('guild');
      const period = url.searchParams.get('period') || '7d';
      const body = guild ? { overview: await stats.overview(guild, period), balance: await stats.balance(guild, period) } : { error: 'guild 파라미터 필요' };
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify(body));
    } else {
      send(res, 200, 'text/html; charset=utf-8', await render(url, client));
    }
  } catch (err) {
    console.error('[dashboard]', err.message);
    send(res, 500, 'text/plain; charset=utf-8', 'error');
  }
  return true;
}

// 만료 세션 청소
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.exp < now) sessions.delete(id);
}, 60_000).unref();

module.exports = { handle, revokeAll, enabledState, _sessions: sessions };
