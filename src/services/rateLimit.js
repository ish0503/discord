/** 유저별 슬라이딩 윈도 레이트 리밋 (명령어·버튼 공통) */
const config = require('../config');

const hits = new Map();

function allow(userId, now = Date.now()) {
  const { WINDOW_MS, MAX_ACTIONS } = config.RATE_LIMIT;
  const list = (hits.get(userId) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= MAX_ACTIONS) {
    hits.set(userId, list);
    return false;
  }
  list.push(now);
  hits.set(userId, list);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (!v.some((t) => now - t < config.RATE_LIMIT.WINDOW_MS)) hits.delete(k);
}, 60_000).unref();

module.exports = { allow };
