/**
 * Koyeb 등 "트래픽이 없으면 재우는(scale-to-zero / sleep)" 호스팅에서 봇이 잠들지 않게 하는 keep-alive.
 *
 * 디스코드 봇은 게이트웨이(WebSocket)로 "나가는" 연결만 쓰기 때문에, 호스팅 입장에서는
 * 들어오는 HTTP 트래픽이 0인 유휴 서비스로 보여 일정 시간 뒤 인스턴스가 잠든다.
 * → 주기적으로 서비스의 "공개 URL"(호스팅 엣지 경유)로 헬스 체크 요청을 보내 들어오는 트래픽을 만든다.
 *   localhost로 보내면 엣지를 거치지 않아 트래픽으로 집계되지 않으므로 반드시 공개 주소를 쓴다.
 *
 * 설정 (환경 변수):
 *   KEEP_ALIVE_URL         핑할 주소 (예: https://my-bot-myorg.koyeb.app/health). 없으면 자동 감지
 *   KOYEB_PUBLIC_DOMAIN    Koyeb가 넣어 주는 공개 도메인 → https://<도메인>/health 로 자동 사용
 *   KEEP_ALIVE_INTERVAL_MS 핑 간격 (기본 4분, 최소 30초)
 *   KEEP_ALIVE=false       끄기
 */

const DEFAULT_INTERVAL_MS = 4 * 60_000;
const MIN_INTERVAL_MS = 30_000;
const TIMEOUT_MS = 10_000;

/** 순수 함수: 환경 변수 → { url, intervalMs } | { disabled: 사유 } */
function resolve(env = process.env) {
  if (String(env.KEEP_ALIVE ?? '').toLowerCase() === 'false') return { disabled: 'KEEP_ALIVE=false' };
  let url = (env.KEEP_ALIVE_URL || '').trim();
  if (!url && env.KOYEB_PUBLIC_DOMAIN) {
    const domain = env.KOYEB_PUBLIC_DOMAIN.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (domain) url = `https://${domain}/health`;
  }
  if (!url) return { disabled: '공개 URL 없음 (KEEP_ALIVE_URL 또는 KOYEB_PUBLIC_DOMAIN 설정 필요)' };
  if (!/^https?:\/\//.test(url)) url = `https://${url}`;
  try {
    new URL(url);
  } catch {
    return { disabled: `잘못된 KEEP_ALIVE_URL: ${url}` };
  }
  const n = Number(env.KEEP_ALIVE_INTERVAL_MS);
  const intervalMs = Number.isFinite(n) && n > 0 ? Math.max(MIN_INTERVAL_MS, n) : DEFAULT_INTERVAL_MS;
  return { url, intervalMs };
}

/**
 * keep-alive 시작. 반환값의 stop()으로 중지.
 * @param opts.onFail(streak, err) 연속 실패 시 호출 (알림 연동용)
 */
function start({ env = process.env, fetchFn = globalThis.fetch, onFail = null, log = console } = {}) {
  const cfg = resolve(env);
  if (cfg.disabled) {
    log.log(`💤 keep-alive 꺼짐 — ${cfg.disabled}`);
    return { ...cfg, stop() {}, ping: async () => false };
  }
  let failStreak = 0;
  const ping = async () => {
    try {
      const res = await fetchFn(cfg.url, { headers: { 'User-Agent': 'casino-bot-keepalive' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (failStreak) log.log(`☀️ keep-alive 복구 (${failStreak}회 실패 후)`);
      failStreak = 0;
      return true;
    } catch (err) {
      failStreak += 1;
      log.warn(`[keep-alive] 핑 실패 ${failStreak}회: ${err.message}`);
      if (onFail) onFail(failStreak, err);
      return false;
    }
  };
  const timer = setInterval(ping, cfg.intervalMs);
  timer.unref?.();
  // 부팅 직후 한 번 (서버가 listen을 마친 뒤)
  const first = setTimeout(ping, 5_000);
  first.unref?.();
  log.log(`☀️ keep-alive 켜짐 — ${Math.round(cfg.intervalMs / 1000)}초마다 ${cfg.url}`);
  return {
    ...cfg,
    ping,
    stop() {
      clearInterval(timer);
      clearTimeout(first);
    },
  };
}

module.exports = { resolve, start, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS };
