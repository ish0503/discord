/**
 * 운영 알림: ALERT_WEBHOOK_URL(디스코드 웹훅)로 장애 상황 전송.
 * 같은 제목은 THROTTLE_MS 동안 1번만 보냄 (알림 폭주 방지). URL이 없으면 콘솔에만 기록.
 */
const config = require('../config');
const bus = require('./bus');

const last = new Map();
const COLORS = { info: 0x5865f2, warn: 0xf1c40f, error: 0xe74c3c };

async function alert(level, title, message = '') {
  const now = Date.now();
  if (now - (last.get(title) ?? 0) < config.ALERTS.THROTTLE_MS) return;
  last.set(title, now);
  const line = `[ALERT:${level}] ${title} ${message}`;
  if (level === 'error') console.error(line);
  else console.warn(line);
  if (!config.ALERTS.WEBHOOK_URL) return;
  try {
    await fetch(config.ALERTS.WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Casino Bot Monitor',
        embeds: [{ title: `${level === 'error' ? '🚨' : level === 'warn' ? '⚠️' : 'ℹ️'} ${title}`, description: String(message).slice(0, 3900), color: COLORS[level], timestamp: new Date().toISOString() }],
      }),
    });
  } catch (err) {
    console.error('[alerts] 웹훅 전송 실패:', err.message);
  }
}

bus.on('alert', ({ level = 'warn', title, message }) => alert(level, title, message));

module.exports = { alert };
