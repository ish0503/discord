/**
 * 게임 상태 머신 기록 & 재시작 복구.
 * 칩 복구는 wallet(에스크로)이 담당하고, 여기서는 게임 단위 상태와 디스코드 메시지를 정리한다.
 *
 * 복구 정책 (게임 공통):
 *   SETTLING  → 결과가 선기록된 판은 확정 결과대로 정산 → COMPLETED
 *   BETTING/PLAYING/CREATED → 결과 미확정 판은 전액 환불 → CANCELLED
 *   정산·환불 중 오류 → RECOVERY_REQUIRED (관리자 /관리자 복구 로 재시도)
 */
const GameState = require('../db/GameState');
const wallet = require('./wallet');
const notifier = require('./notifier');
const bus = require('./bus');

const TERMINAL = ['COMPLETED', 'CANCELLED'];

function safe(p) {
  return p.catch((err) => console.error('[gameState]', err.message));
}

function create({ gameId, game, guildId, channelId, messageId = null, players = [], state = 'CREATED' }) {
  return safe(GameState.create({ gameId, game, guildId, channelId, messageId, players, state, instance: wallet.INSTANCE_ID, history: [{ state, at: new Date() }] }));
}

function transition(gameId, state, note) {
  return safe(GameState.updateOne({ gameId }, { $set: { state }, $push: { history: { $each: [{ state, at: new Date(), note }], $slice: -30 } } }));
}

function update(gameId, patch) {
  return safe(GameState.updateOne({ gameId }, { $set: patch }));
}

function addPlayer(gameId, userId) {
  return safe(GameState.updateOne({ gameId }, { $addToSet: { players: userId } }));
}

/** 부팅 시: 이전 프로세스의 미종료 게임 정리 (에스크로 복구 후 호출) */
async function recoverBoot(escrowResult) {
  const open = await GameState.find({ state: { $nin: TERMINAL }, instance: { $ne: wallet.INSTANCE_ID } }).lean();
  let cancelled = 0;
  let completed = 0;
  for (const g of open) {
    const settling = g.state === 'SETTLING';
    const state = settling ? 'COMPLETED' : 'CANCELLED';
    const note = settling ? '재시작 복구: 확정된 결과로 정산 완료' : '재시작 복구: 진행 중이던 판 전액 환불';
    await GameState.updateOne(
      { gameId: g.gameId },
      { $set: { state, recovery: { action: state, at: new Date(), note } }, $push: { history: { state, at: new Date(), note } } },
    );
    settling ? completed++ : cancelled++;
    await notifier.editMessage(g.channelId, g.messageId, {
      content: `🔧 봇이 재시작되어 이 게임은 종료되었습니다. ${settling ? '결과가 확정된 판은 정상 정산되었습니다.' : '진행 중이던 판의 베팅은 전액 환불되었습니다.'}`,
      components: [],
    });
  }
  if (open.length || escrowResult?.settled || escrowResult?.refunded) {
    bus.emit('alert', {
      level: 'warn',
      title: '재시작 복구 실행',
      message: `게임 ${open.length}개 정리 (취소 ${cancelled}, 완료 ${completed}) · 판 정산 ${escrowResult?.settled ?? 0}, 환불 ${escrowResult?.refunded ?? 0}, 실패 ${escrowResult?.failed ?? 0}`,
    });
  }
  return { cancelled, completed };
}

/** 정산 실패 표시 (관리자 확인 필요) */
function flag(gameId, note) {
  bus.emit('alert', { level: 'error', title: '정산 실패', message: `${gameId}: ${note}` });
  return transition(gameId, 'RECOVERY_REQUIRED', note);
}

async function listRecovery(guildId) {
  return GameState.find({ guildId, state: 'RECOVERY_REQUIRED' }).sort({ updatedAt: -1 }).limit(20).lean();
}

/** 관리자 재시도: 해당 게임의 남은 판 정산/환불 */
async function retry(gameId) {
  const out = await wallet.recoverGame(gameId);
  if (!out.failed) await transition(gameId, 'COMPLETED', `관리자 재시도: 정산 ${out.settled}, 환불 ${out.refunded}`);
  return out;
}

module.exports = { create, transition, update, addPlayer, recoverBoot, flag, listRecovery, retry, TERMINAL };
