/** 여러 명이 함께 쓰는 테이블(포커·블랙잭·바카라) 공통 유틸 */
const { LiveMessage } = require('./liveMessage');

const displayName = (i) => i.member?.displayName ?? i.user.globalName ?? i.user.username;
const unixIn = (ms) => Math.floor((Date.now() + ms) / 1000);

/** 테이블 단위 락: 진행 중이면 false를 돌려주고 건너뜀 */
async function runExclusive(t, fn) {
  if (t.busy) return false;
  t.busy = true;
  try {
    await fn();
    return true;
  } catch (err) {
    console.error(`[table ${t.id}]`, err);
    return false;
  } finally {
    t.busy = false;
  }
}

/**
 * 공용 메시지 편집기.
 * 최근 버튼 인터랙션 토큰(t.ui)으로 편집하고, 토큰이 만료(15분)되면 봇 토큰으로 메시지를 직접 편집한다.
 * → 여러 판 이어지는 장시간 테이블도 끊기지 않음.
 */
function attachLive(t) {
  t.live = new LiveMessage(async (payload) => {
    try {
      return await t.ui.editReply(payload);
    } catch (err) {
      if (t.message) return t.message.edit(payload);
      throw err;
    }
  });
}

async function captureMessage(t, i) {
  try {
    t.message = await i.fetchReply();
  } catch {
    t.message = null;
  }
}

module.exports = { displayName, unixIn, runExclusive, attachLive, captureMessage };
