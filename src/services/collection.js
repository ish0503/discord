/**
 * 수집 도감 서비스. 수집품은 장식·기록 용도 (확률·배당 무관).
 * - grant(): (유저, 아이템) 고유 인덱스로 중복 획득 차단, 획득 경로·서버·날짜 기록
 * - 세트를 모두 모으면 세트 보상(칭호·포인트) 1회 — Profile.collectionSets 조건부 업데이트
 * - 전시: 프로필에 최대 3개 (Profile.showcase)
 * - Outbox 핸들러 'collection': 게임 기념품 (잭팟·로열 플러시 등)
 */
const UserCollection = require('../db/UserCollection');
const Profile = require('../db/Profile');
const profile = require('./profile');
const outbox = require('./outbox');
const notifier = require('./notifier');
const catalog = require('../content/collection');

const SHOWCASE_MAX = 3;

/** 수집품 지급. 새로 얻었으면 true */
async function grant(userId, itemId, { source = '', guildId = null, seasonKey = null, channelId = null } = {}) {
  const item = catalog.byId[itemId];
  if (!item || !catalog.obtainable(item)) return false;
  try {
    await UserCollection.create({ userId, itemId, source: source || item.source, guildId, seasonKey, obtainedAt: new Date() });
  } catch (err) {
    if (err.code === 11000) {
      await checkSets(userId, guildId, channelId); // 재처리 시에도 세트 보상 누락 보완
      return false;
    }
    throw err;
  }
  await checkSets(userId, guildId, channelId);
  return true;
}

/** 완성한 세트 보상 (1회) */
async function checkSets(userId, guildId, channelId) {
  const owned = new Set((await UserCollection.find({ userId }, { itemId: 1 }).lean()).map((x) => x.itemId));
  await profile.get(userId);
  for (const [setId, set] of Object.entries(catalog.SETS)) {
    if (!set.reward) continue;
    const items = catalog.setItems(setId);
    if (!items.length || !items.every((i) => owned.has(i.id))) continue;
    const res = await Profile.updateOne({ userId, collectionSets: { $ne: setId } }, { $push: { collectionSets: setId }, $addToSet: { titles: set.reward.title }, $inc: { rewardPoints: set.reward.points } });
    if (res.modifiedCount === 1) {
      notifier.announce(guildId, channelId, { content: `📚 <@${userId}> 수집 세트 **${set.name}** 완성! 칭호 「${set.reward.title}」 · ⭐ +${set.reward.points}P`, allowedMentions: { parse: [] } }, 'important');
      await profile.checkTrigger(userId, guildId, 'collection', {}, channelId);
    }
  }
}

async function list(userId) {
  const rows = await UserCollection.find({ userId }).sort({ obtainedAt: -1 }).lean();
  const owned = new Map(rows.map((r) => [r.itemId, r]));
  return { rows, owned, total: catalog.ITEMS.length };
}

/** 전시할 수집품 지정 (보유한 것만, 최대 3개) */
async function setShowcase(userId, itemIds) {
  const ids = [...new Set(itemIds)].slice(0, SHOWCASE_MAX);
  const owned = await UserCollection.countDocuments({ userId, itemId: { $in: ids } });
  if (owned !== ids.length) return { ok: false, reason: '보유하지 않은 수집품이 있어요.' };
  await profile.get(userId);
  await Profile.updateOne({ userId }, { $set: { showcase: ids } });
  return { ok: true, ids };
}

async function onSettled(ev) {
  for (const id of catalog.fromEvent(ev)) await grant(ev.userId, id, { source: `${ev.game}:${ev.roundId}`, guildId: ev.guildId, channelId: ev.recovered ? null : ev.channelId });
}

outbox.register('round.settled', 'collection', onSettled);

module.exports = { grant, checkSets, list, setShowcase, SHOWCASE_MAX };
