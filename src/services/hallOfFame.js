/**
 * 명예의 전당 (Outbox 핸들러 'hof' + 시즌·보스 결과).
 * - 검증된 정산 이벤트에서만 기록을 만든다 (지급액 검증을 통과해 실제 칩이 오간 판).
 * - 기록은 덮어쓰지 않는다: 새 기록이 나오면 이전 기록은 current=false 로 이력에 남는다.
 * - "최고 기록" 분류는 HallOfFameBest 의 조건부 갱신(value < 새 값)으로 동시에 들어와도 하나만 이긴다.
 * - 모두 서버(guildId)별로 분리된다.
 */
const HallOfFameRecord = require('../db/HallOfFameRecord');
const Profile = require('../db/Profile');
require('./profile'); // 'profile' 핸들러(연승 갱신)가 먼저 실행되도록 등록 순서 보장
const outbox = require('./outbox');
const notifier = require('./notifier');
const config = require('../config');
const registry = require('../games/registry');

const { Best } = HallOfFameRecord;

const CATEGORIES = {
  biggest_net: { label: '💥 한 판 최대 순이익', unit: '칩' },
  biggest_multi: { label: '🚀 최고 배수 (지급 ÷ 베팅)', unit: '배' },
  win_streak: { label: '🔥 최장 연승', unit: '연승' },
  tournament_win: { label: '🏆 토너먼트 우승', unit: '', list: true },
  season_champion: { label: '👑 시즌 우승', unit: '', list: true },
  boss_top: { label: '🐉 월드 보스 최고 기여', unit: '점', list: true },
  clan_season: { label: '🛡️ 클랜 시즌 1위', unit: '점', list: true },
};
for (const id of registry.ids()) CATEGORIES[`best_net:${id}`] = { label: `${registry.label(id)} 최대 순이익`, unit: '칩', game: id };

/**
 * 최고 기록 도전. 이기면 이력 기록을 남기고 이전 기록을 current=false 로.
 * 멱등: recordId = `${category}:${refId}` (같은 이벤트를 다시 처리해도 1개)
 */
async function challenge({ guildId, category, userId, value, refId, extra = {} }) {
  const recordId = `${category}:${refId}`;
  try {
    await Best.updateOne({ guildId, category }, { $setOnInsert: { value: 0 } }, { upsert: true });
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
  const prev = await Best.findOne({ guildId, category }).lean();
  const won = await Best.findOneAndUpdate(
    { guildId, category, value: { $lt: value } },
    { $set: { value, userId, recordId, updatedAt: new Date() } },
    { new: false },
  ).lean();
  const mine = won || prev?.recordId === recordId; // 갱신 직후 기록 저장 전에 죽었다가 재시도한 경우 포함
  if (!mine) return null;
  const previous = won?.recordId ? { userId: won.userId, value: won.value, recordId: won.recordId } : null;
  try {
    await HallOfFameRecord.create({ recordId, guildId, category, userId, value, previous, current: true, achievedAt: new Date(), ...extra });
  } catch (err) {
    if (err.code !== 11000) throw err;
    return null;
  }
  if (previous?.recordId) await HallOfFameRecord.updateOne({ recordId: previous.recordId }, { $set: { current: false } });
  return { recordId, previous };
}

/** 목록형 기록 (우승자 등) — 누적 */
async function append({ guildId, category, userId, value = 0, refId, extra = {} }) {
  try {
    await HallOfFameRecord.create({ recordId: `${category}:${refId}`, guildId, category, userId, value, current: true, achievedAt: new Date(), ...extra });
    return true;
  } catch (err) {
    if (err.code !== 11000) throw err;
    return false;
  }
}

async function onSettled(ev, { eventId }) {
  if (!ev.guildId || ev.status !== 'settled') return;
  if (require('../games/registry').isMeta(ev.game) || ev.detail?.roomId) return; // 예측·비공개 방 판은 기록 제외
  const base = { gameId: ev.gameId ?? null, roundId: ev.roundId, game: ev.game };
  const news = [];
  const tryBest = async (category, value) => {
    const r = await challenge({ guildId: ev.guildId, category, userId: ev.userId, value, refId: eventId, extra: base });
    if (r) news.push({ category, value, previous: r.previous });
  };
  if (ev.net > 0) {
    await tryBest('biggest_net', ev.net);
    await tryBest(`best_net:${ev.game}`, ev.net);
  }
  if (ev.staked >= config.MIN_BET && ev.payout > ev.staked) await tryBest('biggest_multi', Math.floor((ev.payout / ev.staked) * 100) / 100);
  if (ev.net > 0) {
    const p = await Profile.findOne({ userId: ev.userId }, { winStreak: 1 }).lean();
    if (p?.winStreak >= 3) await tryBest('win_streak', p.winStreak);
  }
  if (ev.game === 'tournament' && ev.detail?.place === 1) {
    await append({ guildId: ev.guildId, category: 'tournament_win', userId: ev.userId, value: ev.payout, refId: eventId, extra: { ...base, gameId: ev.detail.tournamentId ?? ev.gameId } });
  }
  // 이전 기록이 있던 분류를 새로 갈아치운 경우만 알림 (첫 기록은 조용히)
  const broken = news.filter((n) => n.previous);
  if (broken.length && !ev.recovered) {
    const lines = broken.map((n) => `${CATEGORIES[n.category]?.label ?? n.category}: **${n.value.toLocaleString('en-US')}${CATEGORIES[n.category]?.unit ?? ''}** (이전 ${n.previous.value.toLocaleString('en-US')} · <@${n.previous.userId}>)`);
    notifier.announce(ev.guildId, ev.channelId, { content: `🏛️ <@${ev.userId}> 명예의 전당 기록 경신!\n${lines.join('\n')}`, allowedMentions: { parse: [] } }, 'important');
    await require('./profile').checkTrigger(ev.userId, ev.guildId, 'hof', {}, ev.channelId);
  } else if (news.length) await require('./profile').checkTrigger(ev.userId, ev.guildId, 'hof', {}, null);
}

/** 분류별 현재 기록 */
async function board(guildId) {
  const bests = await Best.find({ guildId }).lean();
  const lists = await HallOfFameRecord.find({ guildId, category: { $in: Object.keys(CATEGORIES).filter((c) => CATEGORIES[c].list) } }).sort({ achievedAt: -1 }).limit(15).lean();
  return { bests: bests.filter((b) => b.recordId), lists };
}

/** 한 분류의 기록 이력 (최신순) */
function history(guildId, category, limit = 10) {
  return HallOfFameRecord.find({ guildId, category }).sort({ achievedAt: -1 }).limit(limit).lean();
}

/** 유저가 이 서버에서 세운 기록 */
async function ofUser(guildId, userId) {
  const all = await HallOfFameRecord.find({ guildId, userId }).sort({ achievedAt: -1 }).limit(50).lean();
  return { current: all.filter((r) => r.current), all };
}

/** 개인정보 요청: 기록의 사용자 식별자를 지움 (수치·날짜는 보존) */
async function anonymize(guildId, userId) {
  const res = await HallOfFameRecord.updateMany({ guildId, userId }, { $set: { userId: 'deleted', anonymized: true } });
  await Best.updateMany({ guildId, userId }, { $set: { userId: 'deleted' } });
  return res.modifiedCount;
}

outbox.register('round.settled', 'hof', onSettled);

module.exports = { CATEGORIES, challenge, append, onSettled, board, history, ofUser, anonymize };
