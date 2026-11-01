/**
 * 게임 → 지갑 정산 표준 절차.
 *   commit()   결과가 정해진 즉시 호출 (연출 전) — 서버가 죽어도 이 결과로 복구 정산
 *   finalize() 연출이 끝난 뒤 실제 정산. 오류·검증 실패 시 게임을 RECOVERY_REQUIRED로 표시하고 알림
 *   batch()    여러 명이 한 결과를 나누는 정산(포커 핸드·토너먼트):
 *              ① 참가자·금액 불변식 검증 → ② SettlementRecord 선기록 → ③ 전원 결과 선기록 → ④ 정산 → ⑤ 상태 기록
 *              같은 settlementId로 다시 호출하면 이미 반영된 참가자는 건너뛴다 (지갑은 roundId로도 멱등).
 */
const wallet = require('./wallet');
const gameState = require('./gameState');
const SettlementRecord = require('../db/SettlementRecord');
const AuditLog = require('../db/AuditLog');
const GameLog = require('../db/GameLog');
const rules = require('../content/settlementRules');

async function commit({ userId, guildId, roundId, payout, game, detail, maxPayout = null }) {
  try {
    return await wallet.commitResult(userId, guildId, roundId, payout, { game, ...(detail || {}) }, { maxPayout });
  } catch (err) {
    console.error('[commit]', err.message); // 선기록 실패는 치명적이지 않음 (정산 단계에서 다시 시도)
    return false;
  }
}

async function finalize(opts) {
  try {
    const r = await wallet.settle(opts);
    if (r.rejected) {
      if (opts.gameId) gameState.flag(opts.gameId, `${opts.userId} ${opts.roundId}: 정산 검증 실패 — ${r.reason}`);
      return { ...r, error: true };
    }
    if (!r.ok && opts.gameId) console.warn(`[finalize] 이미 처리된 판: ${opts.roundId}`);
    return r;
  } catch (err) {
    console.error('[finalize]', err);
    if (opts.gameId) gameState.flag(opts.gameId, `${opts.userId} ${opts.roundId}: ${err.message}`);
    return { ok: false, error: true };
  }
}

/**
 * 다인 정산.
 * @param o.settlementId 고유 ID (예: `poker:<gameId>:<핸드>`, `tournament:<id>`)
 * @param o.entries [{ userId, roundId, payout, staked?, inc, wagered, detail, maxPayout? }]
 * @param o.expectTotal / o.maxTotal 지급 총액 불변식 (예: 토너먼트 상금 합 = 상금 풀)
 * @param o.check() 추가 불변식 (예: 포커 칩 보존) → { ok } | { ok:false, reason }
 * @returns { ok, status, results: Map(roundId → settle 결과), reason? }
 */
async function batch({ settlementId, game, guildId, gameId, channelId = null, entries, expectTotal = null, maxTotal = null, check = null }) {
  const results = new Map();
  const v = rules.validateBatch(entries, { expectTotal, maxTotal });
  const extra = v.ok && check ? check() : { ok: true };
  if (!v.ok || !extra.ok) {
    const reason = v.reason ?? extra.reason;
    await SettlementRecord.create({ settlementId, gameId, game, guildId, participants: entries.map((e) => ({ userId: e.userId, roundId: e.roundId, payout: e.payout })), status: 'rejected', issues: [reason] }).catch(() => {});
    await AuditLog.create({ guildId, actorId: 'system', action: 'settlement.batch-rejected', targetId: gameId, reason, after: { settlementId, entries: entries.map((e) => ({ userId: e.userId, payout: e.payout })) } }).catch(() => {});
    if (gameId) gameState.flag(gameId, `다인 정산 검증 실패 — ${reason} (지갑 변경 없음)`);
    return { ok: false, status: 'rejected', reason, results };
  }

  let rec;
  try {
    rec = (await SettlementRecord.create({
      settlementId,
      gameId,
      game,
      guildId,
      participants: entries.map((e) => ({ userId: e.userId, roundId: e.roundId, payout: e.payout, staked: e.staked ?? null, result: 'pending' })),
      totals: { payout: v.total, expectTotal, maxTotal },
      status: 'committed',
    })).toObject?.();
  } catch (err) {
    if (err.code !== 11000) throw err;
    rec = await SettlementRecord.findOne({ settlementId }).lean();
    if (rec?.status === 'applied') return { ok: true, status: 'applied', already: true, results };
    if (rec?.status === 'rejected') return { ok: false, status: 'rejected', reason: rec.issues?.[0], results };
  }

  // ③ 전원 결과 선기록 (이후 서버가 죽어도 이 금액으로 복구 정산)
  for (const e of entries) await commit({ userId: e.userId, guildId, roundId: e.roundId, payout: e.payout, game, detail: e.detail, maxPayout: e.maxPayout ?? null });

  // ④ 정산
  const errors = [];
  for (const e of entries) {
    const st = await finalize({ userId: e.userId, guildId, roundId: e.roundId, payout: e.payout, game, gameId, channelId, inc: e.inc ?? {}, wagered: e.wagered ?? 0, detail: e.detail, maxPayout: e.maxPayout ?? null });
    let result = st.ok ? 'applied' : st.rejected ? 'rejected' : st.error ? 'error' : 'already';
    if (result === 'already' && !(await GameLog.findOne({ roundId: e.roundId }).lean())) result = 'missing'; // 에스크로에도 기록에도 없음 → 확인 필요
    if (!['applied', 'already'].includes(result)) errors.push(`${e.userId}: ${result}${st.reason ? ` (${st.reason})` : ''}`);
    results.set(e.roundId, st);
    await SettlementRecord.updateOne({ settlementId, 'participants.roundId': e.roundId }, { $set: { 'participants.$.result': result } }).catch(() => {});
  }
  // ⑤ 상태
  const status = errors.length ? 'partial' : 'applied';
  await SettlementRecord.updateOne({ settlementId }, { $set: { status, appliedAt: new Date(), issues: errors } }).catch(() => {});
  if (errors.length && gameId) gameState.flag(gameId, `부분 정산 (${errors.join(', ')}) — 남은 판은 자동 복구 대상, /관리자 정산상태 확인`);
  return { ok: !errors.length, status, results };
}

/** 관리자용: 확인이 필요한 다인 정산 */
function pendingRecords(guildId) {
  return SettlementRecord.find({ guildId, status: { $in: ['committed', 'partial', 'rejected'] } }).sort({ createdAt: -1 }).limit(10).lean();
}

/** 정산 결과 표시용 꼬리말 */
const tail = (st, chips) => (st.ok ? ` · 잔고 ${chips(st.balance)}` : st.error ? ' · ⚠️ 정산 지연 (자동 복구 예정)' : ' · ⚠️ 이미 처리된 판');

module.exports = { commit, finalize, batch, pendingRecords, tail };
