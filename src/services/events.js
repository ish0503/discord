/** 기간 한정 이벤트 (보상 포인트 배수만 적용 — 게임 확률·배당에는 영향 없음) */
const Event = require('../db/Event');

const cache = new Map();

async function active(guildId) {
  const hit = cache.get(guildId);
  if (hit && Date.now() - hit.at < 60_000) return hit.list;
  const now = new Date();
  const list = guildId ? await Event.find({ guildId, startsAt: { $lte: now }, endsAt: { $gt: now } }).lean() : [];
  cache.set(guildId, { list, at: Date.now() });
  return list;
}

async function pointsMultiplier(guildId) {
  const list = await active(guildId);
  return list.reduce((m, e) => Math.max(m, e.type === 'points_boost' ? e.multiplier : 1), 1);
}

async function create({ guildId, name, multiplier, hours, createdBy }) {
  const startsAt = new Date();
  const doc = await Event.create({ guildId, name, type: 'points_boost', multiplier, startsAt, endsAt: new Date(startsAt.getTime() + hours * 3600_000), createdBy });
  cache.delete(guildId);
  return doc;
}

async function endAll(guildId) {
  const now = new Date();
  const res = await Event.updateMany({ guildId, endsAt: { $gt: now } }, { $set: { endsAt: now } });
  cache.delete(guildId);
  return res.modifiedCount;
}

module.exports = { active, pointsMultiplier, create, endAll };
