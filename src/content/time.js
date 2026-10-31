/** 서비스 기준 시간대(기본 KST)의 날짜·주 키 */
const config = require('../config');

function parts(date, tz = config.TIMEZONE) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const [y, m, d] = f.format(date).split('-').map(Number);
  return { y, m, d };
}

function dayKey(date = new Date()) {
  const { y, m, d } = parts(date);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** ISO 주차 키 (예: 2026-W44) — 월요일 시작 */
function weekKey(date = new Date()) {
  const { y, m, d } = parts(date);
  const t = new Date(Date.UTC(y, m - 1, d));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function keys(now = new Date()) {
  return { day: dayKey(now), yesterday: dayKey(new Date(now.getTime() - 86400000)), week: weekKey(now) };
}

module.exports = { dayKey, weekKey, keys };
