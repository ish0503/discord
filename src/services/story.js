/**
 * 스토리 챌린지 서비스 (Outbox 핸들러 'story').
 * 진행도는 서버×유저 단위(StoryProgress). 보상(칭호·포인트·한정 테두리)은 유저당 챕터별 1회 (서버를 바꿔 반복 획득 불가).
 * 칩을 걸거나 잃는 일이 없다 — 평소 게임의 정산 결과로만 진행된다.
 */
const StoryProgress = require('../db/StoryProgress');
const Profile = require('../db/Profile');
const profile = require('./profile');
const outbox = require('./outbox');
const notifier = require('./notifier');
const events = require('./events');
const story = require('../content/story');
const { casUpdate } = require('../utils/cas');

async function get(guildId, userId) {
  try {
    return await StoryProgress.findOneAndUpdate({ guildId, userId }, { $setOnInsert: { guildId, userId } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  } catch (err) {
    if (err.code === 11000) return StoryProgress.findOne({ guildId, userId }).lean();
    throw err;
  }
}

/** 다음 챕터 시작. 이미 진행 중이면 그대로 */
async function start(guildId, userId) {
  const s = await get(guildId, userId);
  if (s.chapterId) return { ok: true, already: true, chapter: story.byId[s.chapterId], state: s };
  const ch = story.nextChapter(s.completedChapters);
  if (!ch) return { ok: false, reason: s.completedChapters.length >= story.CHAPTERS.length ? 'all-done' : 'locked' };
  await StoryProgress.updateOne({ guildId, userId, chapterId: null }, { $set: { chapterId: ch.id, stage: 0, progress: 0, games: [], streak: 0 }, $inc: { v: 1 } });
  return { ok: true, chapter: ch, state: await get(guildId, userId) };
}

async function onSettled(ev, { eventId }) {
  if (require('../games/registry').isMeta(ev.game)) return;
  const s = await StoryProgress.findOne({ guildId: ev.guildId, userId: ev.userId }).lean();
  if (!s?.chapterId) return; // 시작하지 않았으면 무관
  const mark = `story:${eventId}`;
  const r = await casUpdate(StoryProgress, { guildId: ev.guildId, userId: ev.userId }, (doc) => {
    if (!doc.chapterId || (doc.processed || []).includes(mark)) return null;
    const ch = story.byId[doc.chapterId];
    if (!ch) return null;
    const out = story.advance(ch, doc, ev);
    const set = { stage: out.state.stage, progress: out.state.progress, games: out.state.games, streak: out.state.streak };
    const update = { $set: set, $push: { processed: { $each: [mark], $slice: -300 } } };
    if (out.stageDone) update.$addToSet = { completedStages: `${ch.id}:${ch.stages[doc.stage].id}` };
    if (out.chapterDone) {
      update.$set.chapterId = null;
      update.$addToSet = { ...(update.$addToSet || {}), completedChapters: ch.id };
    }
    return { update, ch, out };
  });
  if (!r.ok) return;
  const channel = ev.recovered ? null : ev.channelId;
  if (r.noop) return reconcile(ev.guildId, ev.userId); // 재시도: 완료 기록은 됐는데 보상 전에 멈췄다면 마저 지급
  if (r.out.chapterDone) await reward(ev.userId, ev.guildId, r.ch, channel);
  else if (r.out.stageDone) {
    const next = r.ch.stages[r.out.state.stage];
    notifier.announce(ev.guildId, channel, { content: `📖 <@${ev.userId}> 스토리 **${r.ch.name}** 단계 완료! 다음 목표: ${next.text}`, allowedMentions: { parse: [] } });
  }
}

/** 챕터 보상 (유저당 챕터별 1회) */
async function reward(userId, guildId, ch, channelId) {
  const mult = await events.pointsMultiplier(guildId);
  const points = Math.floor(ch.reward.points * mult);
  await profile.get(userId);
  const res = await Profile.updateOne(
    { userId, storyRewards: { $ne: ch.id } },
    { $push: { storyRewards: ch.id }, $addToSet: { titles: ch.reward.title, ...(ch.reward.item ? { inventory: ch.reward.item } : {}) }, $inc: { rewardPoints: points } },
  );
  const first = res.modifiedCount === 1;
  await require('./collection').grant(userId, `story:${ch.id}`, { source: `story:${ch.id}`, guildId, channelId }).catch(console.error);
  notifier.announce(
    guildId,
    channelId,
    { content: `📕 <@${userId}> **${ch.name}** 완료!\n${ch.outro}${first ? `\n🎁 칭호 「${ch.reward.title}」 · ⭐ +${points}P${ch.reward.item ? ' · 🖼️ 한정 테두리 「전설의 왕좌」' : ''}` : '\n(이미 다른 서버에서 받은 보상이라 기록만 남겨요)'}`, allowedMentions: { parse: [] } },
    'important',
  );
  await profile.checkTrigger(userId, guildId, 'story', {}, channelId);
  return first;
}

/** 완료한 챕터 중 보상이 빠진 것을 지급 (멱등) */
async function reconcile(guildId, userId) {
  const [s, p] = await Promise.all([StoryProgress.findOne({ guildId, userId }).lean(), profile.get(userId)]);
  for (const id of s?.completedChapters ?? []) if (!p.storyRewards?.includes(id) && story.byId[id]) await reward(userId, guildId, story.byId[id], null);
}

outbox.register('round.settled', 'story', onSettled);

module.exports = { get, start, onSettled, reward, reconcile };
