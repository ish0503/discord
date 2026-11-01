/**
 * 매일 바뀌는 특별 규칙 서비스 (Outbox 핸들러 'rule').
 * 규칙은 정산 결과를 "읽기만" 한다 → 게임 확률·배당은 그대로.
 * 멱등: 진행도 갱신과 처리 표식(rule:<eventId>)을 한 번의 조건부 업데이트로, 완수 보상은 completed=false일 때만 1회.
 */
const Profile = require('../db/Profile');
const profile = require('./profile'); // 'profile' 핸들러가 먼저 등록되도록
const outbox = require('./outbox');
const notifier = require('./notifier');
const events = require('./events');
const rules = require('../content/dailyRules');
const time = require('../content/time');
const { casUpdate } = require('../utils/cas');

/** 날짜가 바뀌었으면 어제 기록을 이력으로 옮기고 오늘 규칙으로 초기화 */
async function roll(userId, day) {
  const p = await profile.get(userId);
  if (p.dailyRule?.key === day) return;
  const rule = rules.forDay(day);
  const hist = p.dailyRule?.key ? [{ key: p.dailyRule.key, ruleId: p.dailyRule.ruleId, progress: p.dailyRule.progress ?? 0, completed: !!p.dailyRule.completed }] : [];
  await Profile.updateOne(
    { userId, 'dailyRule.key': p.dailyRule?.key ?? null },
    {
      $set: { dailyRule: { key: day, ruleId: rule.id, progress: 0, streak: 0, games: [], completed: false, v: 0 } },
      ...(hist.length ? { $push: { ruleHistory: { $each: hist, $slice: -14 } } } : {}),
    },
  );
}

async function onSettled(ev, { eventId }) {
  if (require('../games/registry').isMeta(ev.game)) return;
  const day = time.dayKey(new Date(ev.at ?? Date.now()));
  if (day !== time.dayKey()) return; // 지난 날의 이벤트가 늦게 처리되면 오늘 규칙에는 반영하지 않음
  const rule = rules.forDay(day);
  await roll(ev.userId, day);
  const mark = `rule:${eventId}`;
  const r = await casUpdate(Profile, { userId: ev.userId, 'dailyRule.key': day }, (p) => {
    if ((p.processedEvents || []).includes(mark)) return null;
    const next = rules.advance(rule, p.dailyRule, ev);
    return { update: { $set: { 'dailyRule.progress': next.progress, 'dailyRule.streak': next.streak, 'dailyRule.games': next.games }, $push: { processedEvents: { $each: [mark], $slice: -600 } } } };
  }, { versionPath: 'dailyRule.v' });
  if (!r.ok) return;
  await maybeComplete(ev.userId, day, rule, ev);
}

/** 목표 달성 시 1회 보상 */
async function maybeComplete(userId, day, rule, ev) {
  const mult = await events.pointsMultiplier(ev.guildId);
  const points = Math.floor(rule.points * mult);
  const done = await Profile.findOneAndUpdate(
    { userId, 'dailyRule.key': day, 'dailyRule.progress': { $gte: rule.goal }, 'dailyRule.completed': { $ne: true } },
    { $set: { 'dailyRule.completed': true }, $inc: { rewardPoints: points, ruleCompletions: 1 } },
    { new: true },
  ).lean();
  if (!done) return false;
  notifier.announce(ev.guildId, ev.recovered ? null : ev.channelId, { content: `🎯 <@${userId}> 오늘의 특별 규칙 **「${rule.name}」** 완수! ⭐ +${points}P`, allowedMentions: { parse: [] } });
  await profile.checkTrigger(userId, ev.guildId, 'rule', {}, ev.recovered ? null : ev.channelId);
  return true;
}

/** 화면용: 오늘·내일 규칙과 내 진행 */
async function view(userId) {
  const today = time.dayKey();
  const tomorrow = time.dayKey(new Date(Date.now() + 86400_000));
  await roll(userId, today);
  const p = await profile.get(userId);
  return { today: rules.forDay(today), tomorrow: rules.forDay(tomorrow), state: p.dailyRule, history: p.ruleHistory || [], completions: p.ruleCompletions ?? 0 };
}

outbox.register('round.settled', 'rule', onSettled);

module.exports = { onSettled, view, roll };
