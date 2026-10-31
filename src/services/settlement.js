/**
 * 게임 → 지갑 정산 표준 절차.
 *   commit()   결과가 정해진 즉시 호출 (연출 전) — 서버가 죽어도 이 결과로 복구 정산
 *   finalize() 연출이 끝난 뒤 실제 정산. 오류 시 게임을 RECOVERY_REQUIRED로 표시하고 알림
 */
const wallet = require('./wallet');
const gameState = require('./gameState');

async function commit({ userId, guildId, roundId, payout, game, detail }) {
  try {
    await wallet.commitResult(userId, guildId, roundId, payout, { game, ...(detail || {}) });
  } catch (err) {
    console.error('[commit]', err.message); // 선기록 실패는 치명적이지 않음 (정산 단계에서 다시 시도)
  }
}

async function finalize(opts) {
  try {
    const r = await wallet.settle(opts);
    if (!r.ok && opts.gameId) console.warn(`[finalize] 이미 처리된 판: ${opts.roundId}`);
    return r;
  } catch (err) {
    console.error('[finalize]', err);
    if (opts.gameId) gameState.flag(opts.gameId, `${opts.userId} ${opts.roundId}: ${err.message}`);
    return { ok: false, error: true };
  }
}

/** 정산 결과 표시용 꼬리말 */
const tail = (st, chips) => (st.ok ? ` · 잔고 ${chips(st.balance)}` : st.error ? ' · ⚠️ 정산 지연 (자동 복구 예정)' : ' · ⚠️ 이미 처리된 판');

module.exports = { commit, finalize, tail };
