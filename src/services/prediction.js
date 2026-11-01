/**
 * 토너먼트 예측 (관전자 참여).
 * - 토너먼트가 시작되면 참가자가 정해진 뒤 첫 핸드 전까지 예측 창(WINDOW_MS)을 연다. 첫 딜링부터는 제출·수정 불가.
 * - 토너먼트 참가자 본인은 예측할 수 없다 (이해 충돌).
 * - 칩을 걸면 wallet.reserve(game 'prediction')로 에스크로에 묶이고, 결과는 관전자끼리 나눔 (패리뮤추얼, 하우스 몫 0).
 *   맞힌 사람이 없으면 전액 환불. 정산은 settlement.batch (지급 총액 = 걸린 칩 총액 불변식, 중복 정산 불가).
 * - 칩 없이(0) 점수만 걸 수도 있다. 점수: 적중 +10, 연속 적중 보너스.
 */
const Prediction = require('../db/Prediction');
const Profile = require('../db/Profile');
const config = require('../config');
const wallet = require('./wallet');
const settlement = require('./settlement');
const profile = require('./profile');

const P = config.PREDICTION;
const fail = (reason) => ({ ok: false, reason });

/** 진행 중 예측 창 (메모리 — 단일 인스턴스, 창이 닫히면 DB의 lockedAt이 기준) */
const windows = new Map(); // tournamentId → { guildId, lockAt, entrants: [{id, name, type}], players: Set }

function open(tournamentId, { guildId, entrants, players, lockAt }) {
  windows.set(tournamentId, { guildId, entrants, players: new Set(players), lockAt });
}

function windowOf(tournamentId) {
  return windows.get(tournamentId) ?? null;
}

/** 제출 (같은 대회에 다시 내면 잠기기 전까지 교체 — 이전 칩은 환불 후 다시 묶음) */
async function submit({ tournamentId, guildId, userId, seatId, stake }) {
  const w = windows.get(tournamentId);
  if (!w || w.guildId !== guildId) return fail('예측을 받지 않는 대회예요.');
  if (Date.now() >= w.lockAt) return fail('예측이 마감됐어요. (첫 핸드가 시작되면 제출·수정 불가)');
  if (w.players.has(userId)) return fail('참가자는 자기 대회를 예측할 수 없어요.');
  if (!P.STAKES.includes(stake)) return fail('걸 수 있는 칩이 아니에요.');
  const seat = w.entrants.find((e) => e.id === seatId);
  if (!seat) return fail('참가자 목록에 없는 대상이에요.');

  const prev = await Prediction.findOne({ tournamentId, userId, predictionType: 'winner' }).lean();
  if (prev && prev.status !== 'open') return fail('이미 처리된 예측이에요.');
  let roundId = null;
  if (stake > 0) {
    const r = await wallet.reserve(userId, guildId, 'prediction', stake, { gameId: tournamentId });
    if (!r) return fail(`잔고가 부족해요. (${stake.toLocaleString('en-US')}칩 필요)`);
    roundId = r.roundId;
  }
  const lockedAt = new Date(w.lockAt);
  // 잠금 전에만 교체 (조건부)
  if (prev) {
    const res = await Prediction.updateOne(
      { _id: prev._id, status: 'open', lockedAt: { $gt: new Date() } },
      { $set: { predictedResult: seat.id, predictedName: seat.name, stake, roundId, submittedAt: new Date() } },
    );
    if (!res.modifiedCount) {
      if (roundId) await wallet.refund({ userId, guildId, roundId, reason: 'prediction-locked' });
      return fail('예측이 마감됐어요.');
    }
    if (prev.roundId) await wallet.refund({ userId, guildId, roundId: prev.roundId, reason: 'prediction-changed' });
  } else {
    try {
      await Prediction.create({ guildId, tournamentId, userId, predictionType: 'winner', predictedResult: seat.id, predictedName: seat.name, stake, roundId, status: 'open', submittedAt: new Date(), lockedAt });
      await profile.bumpMission(userId, 'predict').catch(() => {}); // 대회당 첫 제출만 (교체는 안 셈)
    } catch (err) {
      if (roundId) await wallet.refund({ userId, guildId, roundId, reason: 'prediction-dup' });
      if (err.code === 11000) return fail('잠시 후 다시 시도해 주세요.');
      throw err;
    }
  }
  return { ok: true, seat, stake };
}

/** 예측 창 닫기 (첫 핸드 딜링 직전) */
function lock(tournamentId) {
  const w = windows.get(tournamentId);
  if (w) w.lockAt = Math.min(w.lockAt, Date.now());
}

async function summary(tournamentId) {
  const list = await Prediction.find({ tournamentId }).lean();
  const by = new Map();
  for (const p of list) {
    const x = by.get(p.predictedResult) ?? { name: p.predictedName, count: 0, stake: 0 };
    x.count += 1;
    x.stake += p.stake;
    by.set(p.predictedResult, x);
  }
  return { total: list.length, pool: list.reduce((s, p) => s + p.stake, 0), by: [...by.entries()].sort((a, b) => b[1].count - a[1].count) };
}

/** 패리뮤추얼 분배 (순수): 맞힌 사람의 건 칩 비율대로 전체 풀 분배, 나머지 칩은 가장 많이 건 적중자에게 */
function distribute(preds, winnerId) {
  const pool = preds.reduce((s, p) => s + p.stake, 0);
  const correct = preds.filter((p) => p.predictedResult === winnerId && p.stake > 0);
  const correctStake = correct.reduce((s, p) => s + p.stake, 0);
  if (!pool || !correctStake) return { pool, refundAll: pool > 0, payouts: new Map() };
  const payouts = new Map(preds.filter((p) => p.stake > 0).map((p) => [p.userId, 0]));
  for (const p of correct) payouts.set(p.userId, Math.floor((pool * p.stake) / correctStake));
  const rest = pool - [...payouts.values()].reduce((a, b) => a + b, 0);
  const top = [...correct].sort((a, b) => b.stake - a.stake)[0];
  payouts.set(top.userId, payouts.get(top.userId) + rest);
  return { pool, refundAll: false, payouts };
}

/** 대회 종료 → 채점·정산 (멱등: batch settlementId + 예측별 조건부 상태 변경) */
async function resolve({ tournamentId, guildId, winnerId }) {
  windows.delete(tournamentId);
  const preds = await Prediction.find({ tournamentId, status: 'open' }).lean();
  if (!preds.length) return { total: 0 };
  const d = distribute(preds, winnerId);
  if (d.refundAll) {
    for (const p of preds.filter((x) => x.roundId)) await wallet.refund({ userId: p.userId, guildId, roundId: p.roundId, reason: 'prediction-no-winner' });
  } else if (d.pool > 0) {
    const staked = preds.filter((p) => p.stake > 0);
    await settlement.batch({
      settlementId: `prediction:${tournamentId}`,
      game: 'prediction',
      guildId,
      gameId: tournamentId,
      entries: staked.map((p) => ({ userId: p.userId, roundId: p.roundId, payout: d.payouts.get(p.userId) ?? 0, staked: p.stake, maxPayout: d.pool, wagered: p.stake, detail: { tournamentId, predicted: p.predictedResult, winner: winnerId, pool: d.pool } })),
      expectTotal: d.pool,
    });
  }
  let correctN = 0;
  for (const p of preds) {
    const hit = p.predictedResult === winnerId;
    if (hit) correctN += 1;
    const status = d.refundAll && p.stake > 0 ? 'refunded' : hit ? 'won' : 'lost';
    const res = await Prediction.updateOne({ _id: p._id, status: 'open' }, { $set: { status, payout: d.refundAll ? p.stake : d.payouts.get(p.userId) ?? 0, resolvedAt: new Date() } });
    if (res.modifiedCount) await score(p, hit, guildId);
  }
  return { total: preds.length, correct: correctN, pool: d.pool, refunded: d.refundAll };
}

/** 예측 점수·연속 적중 (멱등: predictProcessed) */
async function score(p, hit, guildId) {
  await profile.get(p.userId);
  const key = `${p.tournamentId}`;
  const doc = await Profile.findOne({ userId: p.userId }).lean();
  const streak = hit ? (doc.predict?.streak ?? 0) + 1 : 0;
  const gain = hit ? P.SCORE_CORRECT + (streak >= 2 ? P.SCORE_STREAK_BONUS * (streak - 1) : 0) : 0;
  const res = await Profile.updateOne(
    { userId: p.userId, predictProcessed: { $ne: key } },
    {
      $inc: { 'predict.score': gain, 'predict.total': 1, 'predict.correct': hit ? 1 : 0 },
      $set: { 'predict.streak': streak },
      $max: { 'predict.bestStreak': streak },
      $push: { predictProcessed: { $each: [key], $slice: -200 } },
    },
  );
  if (res.modifiedCount) {
    await Prediction.updateOne({ _id: p._id }, { $set: { score: gain } });
    await profile.checkTrigger(p.userId, guildId, 'predict', {}, null);
  }
}

/** 대회 취소 → 걸린 칩 환불 */
async function cancel(tournamentId, guildId) {
  windows.delete(tournamentId);
  const preds = await Prediction.find({ tournamentId, status: 'open' }).lean();
  for (const p of preds) {
    if (p.roundId) await wallet.refund({ userId: p.userId, guildId, roundId: p.roundId, reason: 'tournament-cancelled' });
    await Prediction.updateOne({ _id: p._id, status: 'open' }, { $set: { status: 'refunded', resolvedAt: new Date() } });
  }
}

async function leaderboard(guildId) {
  const users = await Prediction.distinct('userId', { guildId });
  const docs = await Profile.find({ userId: { $in: users } }, { userId: 1, predict: 1 }).lean();
  return docs.filter((d) => d.predict?.total).sort((a, b) => b.predict.score - a.predict.score).slice(0, 15);
}

const openList = (guildId) => [...windows.entries()].filter(([, w]) => w.guildId === guildId && Date.now() < w.lockAt).map(([id, w]) => ({ tournamentId: id, ...w }));
const history = (guildId, userId) => Prediction.find({ guildId, userId }).sort({ submittedAt: -1 }).limit(10).lean();

module.exports = { open, windowOf, submit, lock, summary, distribute, resolve, cancel, leaderboard, openList, history, score };
