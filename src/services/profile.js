/**
 * 전역 프로필 서비스: 누적 전적·연승, 미션 진행, 업적 해금, 보상 포인트, 상점·장착.
 * round:settled 이벤트를 구독해 자동 갱신된다 (정산 로직과 분리).
 */
const Profile = require('../db/Profile');
const outbox = require('./outbox');
const wallet = require('./wallet');
const notifier = require('./notifier');
const events = require('./events');
const time = require('../content/time');
const missions = require('../content/missions');
const achievements = require('../content/achievements');
const cosmetics = require('../content/cosmetics');
const config = require('../config');

async function get(userId) {
  return Profile.findOneAndUpdate({ userId }, { $setOnInsert: { userId } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
}

/** 장착 아이템만 가볍게 (게임 화면 렌더링용) */
async function cosmeticsOf(userId) {
  try {
    const p = await get(userId);
    return { ...cosmetics.DEFAULTS, ...(p.equipped || {}) };
  } catch {
    return { ...cosmetics.DEFAULTS };
  }
}

/** 미션 기간이 바뀌었으면 초기화 */
async function rollMissions(p) {
  const k = time.keys();
  const set = {};
  if (p.missions?.dailyKey !== k.day) Object.assign(set, { 'missions.dailyKey': k.day, 'missions.daily': {}, 'missions.dailyClaimed': [] });
  if (p.missions?.weeklyKey !== k.week) Object.assign(set, { 'missions.weeklyKey': k.week, 'missions.weekly': {}, 'missions.weeklyClaimed': [] });
  if (!Object.keys(set).length) return p;
  return Profile.findOneAndUpdate({ userId: p.userId }, { $set: set }, { new: true }).lean();
}

function currentMissions() {
  const k = time.keys();
  return {
    daily: missions.select('daily', k.day, config.MISSIONS.DAILY_COUNT),
    weekly: missions.select('weekly', k.week, config.MISSIONS.WEEKLY_COUNT),
  };
}

async function unlock(userId, guildId, list, channelId) {
  const mult = await events.pointsMultiplier(guildId);
  const got = [];
  for (const a of list) {
    const points = Math.floor(a.points * mult);
    const res = await Profile.updateOne(
      { userId, 'achievements.id': { $ne: a.id } },
      { $push: { achievements: { id: a.id, at: new Date() } }, $addToSet: { titles: a.title }, $inc: { rewardPoints: points } },
    );
    if (res.modifiedCount === 1) got.push({ ...a, points });
  }
  if (got.length && channelId) {
    const top = got.reduce((m, a) => (achievements.tierOf(a).rank > achievements.tierOf(m).rank ? a : m), got[0]);
    const tier = achievements.tierOf(top);
    const lines = got.map((a) => `${achievements.RARITY[a.rarity]} **${achievements.display(a)}** (${achievements.tierOf(a).label}) — 칭호 「${a.title}」 + ${points(a.points)}`);
    if (tier.rank >= 2) {
      // 영웅 이상: 등급 색 임베드로 크게 알림
      const head = tier.rank >= 4 ? '🔴✨ 신화 업적 달성! ✨🔴' : tier.rank >= 3 ? '🟡✨ 전설 업적 달성! ✨🟡' : '🟣 영웅 업적 달성!';
      notifier.announce(guildId, channelId, {
        content: `<@${userId}>`,
        embeds: [{ color: parseInt(tier.color[0].slice(1), 16), title: head, description: lines.join('\n') }],
        allowedMentions: { parse: [] },
      }, 'important');
    } else notifier.announce(guildId, channelId, `🏆 <@${userId}> 업적 달성!\n${lines.join('\n')}`);
  }
  return got;
}
const points = (n) => `${n.toLocaleString('en-US')}P`;

/**
 * 정산 이벤트 → 누적 전적·연승·미션·업적 (Outbox 핸들러).
 * 멱등: 전적·연승·미션 증가와 "처리한 이벤트 표식(processedEvents)"을 한 번의 조건부 업데이트로 반영 →
 *       같은 이벤트가 몇 번 다시 와도 한 번만 반영된다. 업적 해금은 원래 중복 불가($ne).
 * 복구(재시작) 정산도 같은 경로로 들어와 전적·미션·업적에 반영된다.
 */
async function onRoundSettled(ev, meta = {}) {
  if (require('../games/registry').isMeta(ev.game)) return { applied: false }; // 예측 정산은 전적·미션에 넣지 않음
  const eventId = meta.eventId ?? `settle:${ev.roundId}`;
  const win = ev.net > 0;
  const lose = ev.net < 0;
  await get(ev.userId);
  let p = await rollMissions(await get(ev.userId));
  const inc = { 'totals.games': 1, 'totals.wagered': ev.staked };
  if (win) {
    inc['totals.wins'] = 1;
    inc.winStreak = 1;
  }
  const { daily, weekly } = currentMissions();
  for (const m of daily) {
    const d = missions.increment(m, ev);
    if (d) inc[`missions.daily.${m.id}`] = d;
  }
  for (const m of weekly) {
    const d = missions.increment(m, ev);
    if (d) inc[`missions.weekly.${m.id}`] = d;
  }
  const update = { $inc: inc, $push: { processedEvents: { $each: [eventId], $slice: -300 } } };
  if (lose) update.$set = { winStreak: 0 };
  const applied = await Profile.findOneAndUpdate({ userId: ev.userId, processedEvents: { $ne: eventId } }, update, { new: true }).lean();
  p = applied ?? (await get(ev.userId)); // 이미 반영된 이벤트면 현재 상태로 업적만 다시 확인 (업적은 중복 지급 안 됨)
  if (p.winStreak > p.maxWinStreak) {
    p = await Profile.findOneAndUpdate({ userId: ev.userId }, { $max: { maxWinStreak: p.winStreak } }, { new: true }).lean();
  }
  const unlocked = achievements.evaluate({ ev, profile: p }, (p.achievements || []).map((a) => a.id));
  if (unlocked.length) await unlock(ev.userId, ev.guildId, unlocked, ev.recovered ? null : ev.channelId);
  return { applied: !!applied };
}

/** 게임 외 트리거(출석·시즌)로 업적 판정 */
async function checkTrigger(userId, guildId, trigger, extra = {}, channelId) {
  const p = await get(userId);
  const unlocked = achievements.evaluate({ ev: null, profile: p, trigger, ...extra }, (p.achievements || []).map((a) => a.id));
  return unlock(userId, guildId, unlocked, channelId);
}

async function addPoints(userId, amount) {
  return Profile.findOneAndUpdate({ userId }, { $inc: { rewardPoints: amount } }, { new: true, upsert: true, setDefaultsOnInsert: true }).lean();
}

/** 미션 보상 수령 (진행도 확인 + 중복 수령 방지를 한 번의 조건부 업데이트로) */
async function claimMission(userId, guildId, kind, missionId) {
  const p = await rollMissions(await get(userId));
  const list = currentMissions()[kind];
  const m = list.find((x) => x.id === missionId);
  if (!m) return { ok: false, reason: '이번 기간의 미션이 아니에요.' };
  const progress = p.missions?.[kind]?.[m.id] ?? 0;
  if (progress < m.goal) return { ok: false, reason: '아직 목표를 달성하지 못했어요.' };
  const mult = await events.pointsMultiplier(guildId);
  const reward = Math.floor(m.points * mult);
  const claimedField = `missions.${kind}Claimed`;
  const res = await Profile.updateOne(
    { userId, [claimedField]: { $ne: m.id }, [`missions.${kind}Key`]: kind === 'daily' ? time.keys().day : time.keys().week },
    { $push: { [claimedField]: m.id }, $inc: { rewardPoints: reward } },
  );
  if (res.modifiedCount !== 1) return { ok: false, reason: '이미 받은 보상이에요.' };
  return { ok: true, reward, mission: m, multiplier: mult };
}

/** 상점 구매 — 소유권 선점 후 결제, 결제 실패 시 소유권 회수 */
async function purchase(userId, guildId, itemId) {
  const item = cosmetics.SHOP.find((i) => i.id === itemId);
  if (!item) return { ok: false, reason: '없는 상품이에요.' };
  await get(userId);
  const titleAdd = item.type === 'title' ? { $addToSet: { titles: item.value } } : {};

  if (item.price.points) {
    const res = await Profile.updateOne(
      { userId, inventory: { $ne: item.id }, rewardPoints: { $gte: item.price.points } },
      { $push: { inventory: item.id }, $inc: { rewardPoints: -item.price.points }, ...titleAdd },
    );
    if (res.modifiedCount !== 1) {
      const p = await get(userId);
      return { ok: false, reason: p.inventory.includes(item.id) ? '이미 가진 아이템이에요.' : '보상 포인트가 부족해요.' };
    }
    return { ok: true, item };
  }

  const claim = await Profile.updateOne({ userId, inventory: { $ne: item.id } }, { $push: { inventory: item.id }, ...titleAdd });
  if (claim.modifiedCount !== 1) return { ok: false, reason: '이미 가진 아이템이에요.' };
  const paid = await wallet.debit({ userId, guildId, amount: item.price.chips, type: 'shop', reason: item.id });
  if (!paid) {
    await Profile.updateOne({ userId }, { $pull: { inventory: item.id, ...(item.type === 'title' ? { titles: item.value } : {}) } });
    return { ok: false, reason: '칩이 부족해요.' };
  }
  return { ok: true, item, balance: paid.money };
}

/** 장착: 기본값이거나 보유한 아이템만 */
async function equip(userId, type, value) {
  const p = await get(userId);
  if (type === 'title') {
    if (value !== null && !p.titles.includes(value)) return { ok: false, reason: '보유하지 않은 칭호예요.' };
  } else if (value !== cosmetics.DEFAULTS[type]) {
    const item = cosmetics.ownableItems().find((i) => i.type === type && i.value === value);
    if (!item || !p.inventory.includes(item.id)) return { ok: false, reason: '보유하지 않은 아이템이에요.' };
  }
  await Profile.updateOne({ userId }, { $set: { [`equipped.${type}`]: value } });
  return { ok: true };
}

outbox.register('round.settled', 'profile', (payload, ev) => onRoundSettled(payload, { eventId: ev.eventId }));

module.exports = { get, cosmeticsOf, currentMissions, rollMissions, claimMission, checkTrigger, addPoints, purchase, equip, onRoundSettled };
