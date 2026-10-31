/**
 * 읽기 전용 웹 대시보드 (헬스 체크 서버에 붙음).
 *   GET /dashboard?token=…&guild=…&period=7d   → HTML
 *   GET /api/overview?token=…&guild=…&period=7d → JSON
 * DASHBOARD_TOKEN 환경 변수가 없으면 비활성. 쓰기 작업은 제공하지 않음 (관리 작업은 /관리자 명령어 + 감사 로그).
 */
const crypto = require('node:crypto');
const config = require('../config');
const stats = require('./stats');
const registry = require('../games/registry');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const n = (x) => Math.round(x).toLocaleString('en-US');
const pct = (x) => `${(x * 100).toFixed(2)}%`;

function authorized(url, req) {
  const want = config.DASHBOARD.TOKEN;
  if (!want) return false;
  const got = url.searchParams.get('token') || req.headers['x-dashboard-token'] || '';
  const a = Buffer.from(String(got));
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
  const token = encodeURIComponent(url.searchParams.get('token') || '');
  if (!guild) {
    const list = client ? [...client.guilds.cache.values()] : [];
    return page('카지노 대시보드', `<h1>🎰 카지노 대시보드</h1><p>서버를 선택하세요.</p><ul>${list.map((g) => `<li><a href="/dashboard?token=${token}&guild=${g.id}">${esc(g.name)}</a> <small>${g.id}</small></li>`).join('')}</ul>`);
  }
  const [o, bal] = await Promise.all([stats.overview(guild, period), stats.balance(guild, period === '24h' ? '7d' : period)]);
  const periods = Object.keys(stats.PERIODS).map((p) => `<a href="/dashboard?token=${token}&guild=${guild}&period=${p}">${p}</a>`).join(' · ');
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
<p class="muted">RTP = 지급액(원금 포함) ÷ 베팅액. 읽기 전용 화면입니다. 관리 작업은 디스코드의 /관리자 명령어로 하며 모두 감사 로그에 남습니다.</p>`,
  );
}

/** 처리했으면 true */
async function handle(req, res, client) {
  const url = new URL(req.url, 'http://localhost');
  if (!['/dashboard', '/api/overview'].includes(url.pathname)) return false;
  if (!authorized(url, req)) {
    res.writeHead(config.DASHBOARD.TOKEN ? 401 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(config.DASHBOARD.TOKEN ? 'unauthorized' : 'dashboard disabled');
    return true;
  }
  try {
    if (url.pathname === '/api/overview') {
      const guild = url.searchParams.get('guild');
      const period = url.searchParams.get('period') || '7d';
      const body = guild ? { overview: await stats.overview(guild, period), balance: await stats.balance(guild, period) } : { error: 'guild 파라미터 필요' };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(await render(url, client));
    }
  } catch (err) {
    console.error('[dashboard]', err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('error');
  }
  return true;
}

module.exports = { handle };
