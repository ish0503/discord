/**
 * 클랜 서비스 (이용자 길드).
 *
 * 권한: owner(클랜장) > officer(부클랜장) > member. 승인·추방·설정은 부클랜장 이상, 직책·위임·해산은 클랜장.
 * 경제: 생성 비용만 wallet.debit 으로 회수(원장 기록). 클랜 공동 지갑·클랜 간 칩 이동은 없다.
 * 경험치(Outbox 핸들러 'clan'): 플레이 횟수·승리 기반, 서버×유저 하루 상한, 3단계 각각 멱등
 *   ① ClanPlayer: 하루 상한 계산 + 처리 표식 + 지급 내역(grants)  (CAS)
 *   ② Clan: processed 표식이 없을 때만 경험치 증가
 *   ③ ClanMember: processed 표식이 없을 때만 기여도 증가
 *   → 중간에 멈춰도 재시도 때 ①의 지급 내역으로 ②·③을 이어서 한 번만 반영
 * 악용 방지: 탈퇴·추방·해산 후 재가입 대기, 기여 경험치는 클랜에 남음, 하루 상한은 클랜을 옮겨도 유지.
 */
const crypto = require('node:crypto');
const Clan = require('../db/Clan');
const ClanMember = require('../db/ClanMember');
const ClanApplication = require('../db/ClanApplication');
const ClanPlayer = require('../db/ClanPlayer');
const ClanLog = require('../db/ClanLog');
const config = require('../config');
const wallet = require('./wallet');
const profile = require('./profile');
const outbox = require('./outbox');
const notifier = require('./notifier');
const rules = require('../content/clan');
const time = require('../content/time');
const { casUpdate } = require('../utils/cas');

const C = config.CLAN;
const fail = (reason) => ({ ok: false, reason });
const log = (guildId, clanId, type, actorId, targetId = null, detail = null) => ClanLog.create({ guildId, clanId, type, actorId, targetId, detail, at: new Date() }).catch((e) => console.error('[clanLog]', e.message));

async function player(guildId, userId) {
  try {
    return await ClanPlayer.findOneAndUpdate({ guildId, userId }, { $setOnInsert: { guildId, userId } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  } catch (err) {
    if (err.code === 11000) return ClanPlayer.findOne({ guildId, userId }).lean();
    throw err;
  }
}

const membership = (guildId, userId) => ClanMember.findOne({ guildId, userId }).lean();
const clanById = (clanId) => Clan.findOne({ clanId, status: 'active' }).lean();
async function clanByName(guildId, name) {
  const v = rules.validateName(name);
  return v.ok ? Clan.findOne({ guildId, nameKey: v.key, status: 'active' }).lean() : null;
}

function cooldownLeft(p, now = Date.now()) {
  if (!p?.lastLeftAt) return 0;
  return Math.max(0, new Date(p.lastLeftAt).getTime() + C.REJOIN_COOLDOWN_MS - now);
}

// ───────────────────────── 생성 · 가입 ─────────────────────────

async function create({ guildId, userId, name, tag, description = '', emblem = '🛡️', channelId = null }) {
  const n = rules.validateName(name);
  if (!n.ok) return fail(n.reason);
  const t = rules.validateTag(tag);
  if (!t.ok) return fail(t.reason);
  const d = rules.validateText(description, 100);
  if (!d.ok) return fail(d.reason);
  if (!rules.EMBLEMS.includes(emblem)) return fail('엠블럼은 목록에서 골라 주세요.');
  const left = cooldownLeft(await player(guildId, userId));
  if (left) return fail(`최근 클랜을 떠나서 <t:${Math.floor((Date.now() + left) / 1000)}:R> 이후에 만들 수 있어요.`);
  const acc = await wallet.getAccount(userId, guildId);
  if (acc.money < C.CREATE_COST) return fail(`클랜 생성 비용 ${C.CREATE_COST.toLocaleString('en-US')}칩이 필요해요.`);

  const clanId = crypto.randomUUID();
  // ① 소속 자리 선점 (서버당 한 클랜 — 고유 인덱스)
  try {
    await ClanMember.create({ guildId, clanId, userId, role: 'owner', joinedAt: new Date() });
  } catch (err) {
    if (err.code === 11000) return fail('이미 클랜에 소속되어 있어요.');
    throw err;
  }
  // ② 클랜 (이름 고유)
  try {
    await Clan.create({ clanId, guildId, name: n.value, nameKey: n.key, tag: t.value, description: d.value, emblem, ownerId: userId, channelId, memberCount: 1, status: 'active' });
  } catch (err) {
    await ClanMember.deleteOne({ guildId, userId, clanId });
    if (err.code === 11000) return fail('같은 이름의 클랜이 이미 있어요.');
    throw err;
  }
  // ③ 비용 (실패 시 되돌림)
  const paid = await wallet.debit({ userId, guildId, amount: C.CREATE_COST, type: 'clan_create', reason: `클랜 ${n.value}`, actorId: userId });
  if (!paid) {
    await Clan.deleteOne({ clanId });
    await ClanMember.deleteOne({ guildId, userId, clanId });
    return fail('잔고가 부족해요.');
  }
  await ClanApplication.updateMany({ guildId, userId, status: 'pending' }, { $set: { status: 'cancelled', decidedAt: new Date() } });
  await log(guildId, clanId, 'create', userId, null, { name: n.value, tag: t.value, cost: C.CREATE_COST });
  await profile.checkTrigger(userId, guildId, 'clan', { clanRole: 'owner' }, channelId);
  return { ok: true, clan: await clanById(clanId) };
}

async function apply({ guildId, userId, name }) {
  const clan = await clanByName(guildId, name);
  if (!clan) return fail('그런 이름의 클랜이 없어요.');
  if (await membership(guildId, userId)) return fail('이미 클랜에 소속되어 있어요.');
  const left = cooldownLeft(await player(guildId, userId));
  if (left) return fail(`최근 클랜을 떠나서 <t:${Math.floor((Date.now() + left) / 1000)}:R> 이후에 신청할 수 있어요.`);
  const pending = await ClanApplication.countDocuments({ guildId, userId, status: 'pending' });
  if (pending >= C.MAX_PENDING_APPLICATIONS) return fail(`동시에 ${C.MAX_PENDING_APPLICATIONS}곳까지만 신청할 수 있어요.`);
  try {
    await ClanApplication.create({ guildId, clanId: clan.clanId, userId, status: 'pending', createdAt: new Date() });
  } catch (err) {
    if (err.code === 11000) return fail('이미 신청한 클랜이에요.');
    throw err;
  }
  await log(guildId, clan.clanId, 'apply', userId);
  if (clan.channelId) notifier.announce(guildId, clan.channelId, { content: `📨 ${clan.emblem} **${clan.name}** 에 <@${userId}> 님이 가입을 신청했어요. (\`/클랜 신청목록\`)`, allowedMentions: { parse: [] } });
  return { ok: true, clan };
}

async function cancelApplication({ guildId, userId, name }) {
  const clan = await clanByName(guildId, name);
  if (!clan) return fail('그런 이름의 클랜이 없어요.');
  const res = await ClanApplication.updateOne({ clanId: clan.clanId, userId, status: 'pending' }, { $set: { status: 'cancelled', decidedAt: new Date() } });
  return res.modifiedCount ? { ok: true } : fail('대기 중인 신청이 없어요.');
}

/** 신청 승인/거절 (부클랜장 이상) */
async function decide({ guildId, actorId, targetId, approve }) {
  const me = await membership(guildId, actorId);
  if (!me || !rules.CAN.approve(me.role)) return fail('부클랜장 이상만 할 수 있어요.');
  const clan = await clanById(me.clanId);
  if (!clan) return fail('클랜을 찾을 수 없어요.');
  const app = await ClanApplication.findOne({ clanId: clan.clanId, userId: targetId, status: 'pending' }).lean();
  if (!app) return fail('그 유저의 대기 중인 신청이 없어요.');
  if (!approve) {
    await ClanApplication.updateOne({ _id: app._id, status: 'pending' }, { $set: { status: 'rejected', decidedBy: actorId, decidedAt: new Date() } });
    await log(guildId, clan.clanId, 'reject', actorId, targetId);
    return { ok: true, approved: false, clan };
  }
  // 정원: 조건부 증가로 동시에 승인해도 넘지 않음
  const cap = rules.maxMembers(clan.level);
  const seat = await Clan.updateOne({ clanId: clan.clanId, status: 'active', memberCount: { $lt: cap } }, { $inc: { memberCount: 1 } });
  if (!seat.modifiedCount) return fail(`정원(${cap}명)이 가득 찼어요. 클랜 레벨이 오르면 늘어나요.`);
  try {
    await ClanMember.create({ guildId, clanId: clan.clanId, userId: targetId, role: 'member', joinedAt: new Date() });
  } catch (err) {
    await Clan.updateOne({ clanId: clan.clanId }, { $inc: { memberCount: -1 } });
    if (err.code === 11000) {
      await ClanApplication.updateOne({ _id: app._id, status: 'pending' }, { $set: { status: 'cancelled', decidedAt: new Date() } });
      return fail('그 유저는 이미 다른 클랜에 소속되어 있어요.');
    }
    throw err;
  }
  await ClanApplication.updateOne({ _id: app._id, status: 'pending' }, { $set: { status: 'approved', decidedBy: actorId, decidedAt: new Date() } });
  await ClanApplication.updateMany({ guildId, userId: targetId, status: 'pending' }, { $set: { status: 'cancelled', decidedAt: new Date() } });
  await log(guildId, clan.clanId, 'join', actorId, targetId);
  await profile.checkTrigger(targetId, guildId, 'clan', { clanRole: 'member' }, null);
  await awardClanAchievements(await clanById(clan.clanId));
  return { ok: true, approved: true, clan };
}

// ───────────────────────── 탈퇴 · 추방 · 직책 · 해산 ─────────────────────────

async function removeMember(guildId, clan, userId, type, actorId) {
  const res = await ClanMember.deleteOne({ guildId, clanId: clan.clanId, userId });
  if (!res.deletedCount) return false;
  await Clan.updateOne({ clanId: clan.clanId }, { $inc: { memberCount: -1 } });
  await player(guildId, userId);
  await ClanPlayer.updateOne({ guildId, userId }, { $set: { lastLeftAt: new Date() } });
  await log(guildId, clan.clanId, type, actorId, userId);
  return true;
}

async function leave({ guildId, userId }) {
  const me = await membership(guildId, userId);
  if (!me) return fail('소속된 클랜이 없어요.');
  if (me.role === 'owner') return fail('클랜장은 먼저 `/클랜 위임` 으로 클랜장을 넘기거나 `/클랜 해산` 해야 해요.');
  const clan = await clanById(me.clanId);
  if (!clan || !(await removeMember(guildId, clan, userId, 'leave', userId))) return fail('탈퇴 처리에 실패했어요.');
  return { ok: true, clan };
}

async function kick({ guildId, actorId, targetId }) {
  if (actorId === targetId) return fail('자신은 추방할 수 없어요.');
  const [me, target] = await Promise.all([membership(guildId, actorId), membership(guildId, targetId)]);
  if (!me || !target || me.clanId !== target.clanId) return fail('같은 클랜 멤버가 아니에요.');
  if (!rules.CAN.kick(me.role, target.role)) return fail('자신보다 낮은 직책만 추방할 수 있어요.');
  const clan = await clanById(me.clanId);
  if (!(await removeMember(guildId, clan, targetId, 'kick', actorId))) return fail('추방 처리에 실패했어요.');
  return { ok: true, clan };
}

async function setRole({ guildId, actorId, targetId, role }) {
  if (!['officer', 'member'].includes(role)) return fail('직책은 부클랜장 또는 멤버만 지정할 수 있어요.');
  const [me, target] = await Promise.all([membership(guildId, actorId), membership(guildId, targetId)]);
  if (!me || !target || me.clanId !== target.clanId) return fail('같은 클랜 멤버가 아니에요.');
  if (!rules.CAN.promote(me.role)) return fail('클랜장만 직책을 바꿀 수 있어요.');
  if (target.role === 'owner') return fail('클랜장 직책은 `/클랜 위임` 으로만 바꿀 수 있어요.');
  await ClanMember.updateOne({ guildId, userId: targetId, clanId: me.clanId }, { $set: { role } });
  await log(guildId, me.clanId, 'role', actorId, targetId, { role });
  return { ok: true };
}

async function transfer({ guildId, actorId, targetId }) {
  const [me, target] = await Promise.all([membership(guildId, actorId), membership(guildId, targetId)]);
  if (!me || !target || me.clanId !== target.clanId) return fail('같은 클랜 멤버가 아니에요.');
  if (!rules.CAN.transfer(me.role)) return fail('클랜장만 위임할 수 있어요.');
  if (actorId === targetId) return fail('이미 클랜장이에요.');
  const res = await Clan.updateOne({ clanId: me.clanId, ownerId: actorId, status: 'active' }, { $set: { ownerId: targetId } });
  if (!res.modifiedCount) return fail('위임에 실패했어요.');
  await ClanMember.updateOne({ guildId, userId: targetId, clanId: me.clanId }, { $set: { role: 'owner' } });
  await ClanMember.updateOne({ guildId, userId: actorId, clanId: me.clanId }, { $set: { role: 'officer' } });
  await log(guildId, me.clanId, 'transfer', actorId, targetId);
  return { ok: true };
}

async function disband({ guildId, actorId, confirmName, adminId = null }) {
  const me = await membership(guildId, actorId);
  if (!me || !rules.CAN.disband(me.role)) return fail('클랜장만 해산할 수 있어요.');
  const clan = await clanById(me.clanId);
  if (!clan) return fail('클랜을 찾을 수 없어요.');
  if (rules.validateName(confirmName).key !== clan.nameKey) return fail(`확인을 위해 클랜 이름 「${clan.name}」을 정확히 입력해 주세요.`);
  const res = await Clan.updateOne({ clanId: clan.clanId, status: 'active' }, { $set: { status: 'disbanded', disbandedAt: new Date(), memberCount: 0 } });
  if (!res.modifiedCount) return fail('이미 해산된 클랜이에요.');
  const members = await ClanMember.find({ clanId: clan.clanId }).lean();
  for (const m of members) {
    await ClanMember.deleteOne({ guildId, clanId: clan.clanId, userId: m.userId });
    await player(guildId, m.userId);
    await ClanPlayer.updateOne({ guildId, userId: m.userId }, { $set: { lastLeftAt: new Date() } }); // 해산→재창설 반복 방지
  }
  await ClanApplication.updateMany({ clanId: clan.clanId, status: 'pending' }, { $set: { status: 'cancelled', decidedAt: new Date() } });
  await log(guildId, clan.clanId, adminId ? 'admin-disband' : 'disband', adminId ?? actorId, null, { members: members.length, exp: clan.exp, level: clan.level });
  return { ok: true, clan, members: members.length };
}

async function settings({ guildId, actorId, description, emblem, notice }) {
  const me = await membership(guildId, actorId);
  if (!me || !rules.CAN.settings(me.role)) return fail('부클랜장 이상만 설정할 수 있어요.');
  const set = {};
  if (description !== null && description !== undefined) {
    const v = rules.validateText(description, 100);
    if (!v.ok) return fail(v.reason);
    set.description = v.value;
  }
  if (notice !== null && notice !== undefined) {
    const v = rules.validateText(notice, 200);
    if (!v.ok) return fail(v.reason);
    set.notice = v.value;
  }
  if (emblem) {
    if (!rules.EMBLEMS.includes(emblem)) return fail('엠블럼은 목록에서 골라 주세요.');
    set.emblem = emblem;
  }
  if (!Object.keys(set).length) return fail('바꿀 항목을 하나 이상 입력해 주세요.');
  await Clan.updateOne({ clanId: me.clanId, status: 'active' }, { $set: set });
  await log(guildId, me.clanId, 'settings', actorId, null, set);
  const clan = await clanById(me.clanId);
  if (set.notice && clan.channelId) notifier.announce(guildId, clan.channelId, { content: `📢 ${clan.emblem} **${clan.name}** 클랜 공지\n${set.notice}`, allowedMentions: { parse: [] } });
  return { ok: true, clan };
}

// ───────────────────────── 조회 ─────────────────────────

async function info(guildId, { name = null, userId = null } = {}) {
  let clan = null;
  if (name) clan = await clanByName(guildId, name);
  else if (userId) {
    const m = await membership(guildId, userId);
    clan = m ? await clanById(m.clanId) : null;
  }
  if (!clan) return null;
  const members = await ClanMember.find({ clanId: clan.clanId }).sort({ contribution: -1 }).lean();
  const pending = await ClanApplication.find({ clanId: clan.clanId, status: 'pending' }).sort({ createdAt: 1 }).lean();
  const logs = await ClanLog.find({ clanId: clan.clanId }).sort({ at: -1 }).limit(8).lean();
  return { clan, members, pending, logs };
}

/** 주간(이번 주 기준) / 시즌 순위 */
async function ranking(guildId, kind = 'weekly') {
  const clans = await Clan.find({ guildId, status: 'active' }).lean();
  const wk = time.weekKey();
  const sk = await seasonKey(guildId);
  const score = (c) => (kind === 'weekly' ? (c.weekly?.key === wk ? c.weekly.exp : 0) : kind === 'season' ? (c.season?.key === sk ? c.season.exp : 0) : c.exp);
  return clans.map((c) => ({ clan: c, score: score(c) })).sort((a, b) => b.score - a.score || b.clan.exp - a.clan.exp);
}

// ───────────────────────── 경험치 (Outbox) ─────────────────────────

const seasonCache = new Map();
async function seasonKey(guildId) {
  const hit = seasonCache.get(guildId);
  if (hit && Date.now() - hit.at < 300_000) return hit.key;
  const s = await require('./seasons').current(guildId);
  const key = String(s?.number ?? 1);
  seasonCache.set(guildId, { key, at: Date.now() });
  return key;
}

/** 주·시즌 키가 바뀌었으면 지난 값을 남기고 초기화 */
async function rollPeriods(Model, filter, doc, wk, sk) {
  if (doc.weekly?.key !== wk) await Model.updateOne({ ...filter, 'weekly.key': doc.weekly?.key ?? null, 'weekly.exp': doc.weekly?.exp ?? 0 }, { $set: { lastWeekly: { key: doc.weekly?.key ?? null, exp: doc.weekly?.exp ?? 0 }, weekly: { key: wk, exp: 0 } } });
  if (sk && doc.season && doc.season.key !== sk) await Model.updateOne({ ...filter, 'season.key': doc.season.key ?? null }, { $set: { season: { key: sk, exp: 0 } } });
}

async function onSettled(ev, { eventId }) {
  const m = await membership(ev.guildId, ev.userId);
  if (!m) return;
  const exp = rules.expFor(ev);
  if (!exp) return;
  const day = time.dayKey(new Date(ev.at ?? Date.now()));
  const mark = `clan:${eventId}`;
  await player(ev.guildId, ev.userId);

  // ① 하루 상한 + 표식 + 지급 내역
  const r = await casUpdate(ClanPlayer, { guildId: ev.guildId, userId: ev.userId }, (p) => {
    if ((p.processed || []).includes(mark)) return null;
    const used = p.day === day ? p.expToday : 0;
    const give = Math.max(0, Math.min(exp, C.DAILY_EXP_CAP_PER_MEMBER - used));
    return {
      update: { $set: { day, expToday: used + give }, $push: { processed: { $each: [mark], $slice: -300 }, grants: { $each: [{ eventId, clanId: m.clanId, exp: give }], $slice: -100 } } },
      give,
    };
  });
  const grant = r.noop ? (r.doc.grants || []).find((g) => g.eventId === eventId) : { clanId: m.clanId, exp: r.give };
  if (!grant?.exp) return;

  // ② 클랜 경험치 (주간·시즌 포함)
  const wk = time.weekKey(new Date(ev.at ?? Date.now()));
  const sk = await seasonKey(ev.guildId);
  const clan = await Clan.findOne({ clanId: grant.clanId, status: 'active' }).lean();
  if (!clan) return;
  await rollPeriods(Clan, { clanId: clan.clanId }, clan, wk, sk);
  const after = await Clan.findOneAndUpdate(
    { clanId: clan.clanId, status: 'active', processed: { $ne: eventId } },
    { $inc: { exp: grant.exp, 'weekly.exp': grant.exp, 'season.exp': grant.exp }, $set: { 'season.key': sk }, $push: { processed: { $each: [eventId], $slice: -2000 } } },
    { new: true },
  ).lean();
  // ③ 멤버 기여도 (지금도 같은 클랜일 때만)
  const mem = await ClanMember.findOne({ guildId: ev.guildId, userId: ev.userId, clanId: grant.clanId }).lean();
  if (mem) {
    await rollPeriods(ClanMember, { guildId: ev.guildId, userId: ev.userId }, mem, wk, null);
    await ClanMember.updateOne({ guildId: ev.guildId, userId: ev.userId, clanId: grant.clanId, processed: { $ne: eventId } }, { $inc: { contribution: grant.exp, 'weekly.exp': grant.exp }, $push: { processed: { $each: [eventId], $slice: -300 } } });
  }
  if (after) await checkLevel(after);
}

/** 레벨업 (조건부로 한 번만 알림) */
async function checkLevel(clan) {
  const lv = rules.levelFor(clan.exp);
  if (lv <= clan.level) return;
  const res = await Clan.updateOne({ clanId: clan.clanId, level: clan.level }, { $set: { level: lv } });
  if (!res.modifiedCount) return;
  await log(clan.guildId, clan.clanId, 'levelup', null, null, { from: clan.level, to: lv });
  if (clan.channelId) notifier.announce(clan.guildId, clan.channelId, { content: `🎉 ${clan.emblem} **${clan.name}** 클랜 레벨 **${lv}** 달성! 정원 ${rules.maxMembers(lv)}명`, allowedMentions: { parse: [] } }, 'important');
  const updated = await clanById(clan.clanId);
  await awardClanAchievements(updated);
  if (lv >= 5) {
    const members = await ClanMember.find({ clanId: clan.clanId }, { userId: 1 }).lean();
    for (const m of members) await profile.checkTrigger(m.userId, clan.guildId, 'clan', { clanLevel: lv }, null);
  }
}

async function awardClanAchievements(clan, ctx = {}) {
  if (!clan) return [];
  const got = rules.newClanAchievements(clan, ctx);
  for (const a of got) {
    const res = await Clan.updateOne({ clanId: clan.clanId, achievements: { $ne: a.id } }, { $push: { achievements: a.id } });
    if (res.modifiedCount) await log(clan.guildId, clan.clanId, 'achievement', null, null, { id: a.id, name: a.name });
  }
  return got;
}

/**
 * 지난 주 1위 클랜에 주간 업적 (주기 작업). 이미 받은 주는 건너뜀.
 * 지난 주 점수 = weekly(아직 안 넘어간 클랜) 또는 lastWeekly(이번 주로 넘어간 클랜).
 */
async function awardWeekly(guildId, now = new Date()) {
  const prev = time.weekKey(new Date(now.getTime() - 7 * 86400_000));
  const clans = await Clan.find({ guildId, status: 'active' }).lean();
  const score = (c) => (c.weekly?.key === prev ? c.weekly.exp : c.lastWeekly?.key === prev ? c.lastWeekly.exp : 0);
  const top = clans.map((c) => ({ c, s: score(c) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s)[0];
  if (!top) return null;
  const res = await Clan.updateOne({ clanId: top.c.clanId, weeklyWins: { $ne: prev } }, { $push: { weeklyWins: prev } });
  if (!res.modifiedCount) return null;
  await awardClanAchievements(top.c, { weeklyRank: 1 });
  await log(guildId, top.c.clanId, 'weekly1', null, null, { week: prev, exp: top.s });
  return { clan: top.c, week: prev, exp: top.s };
}

/** 시즌 종료: 1위 클랜을 명예의 전당에, 일정 기간 이상 소속된 멤버에게 업적 */
async function closeSeason(guildId, seasonNumber) {
  const sk = String(seasonNumber);
  const clans = await Clan.find({ guildId, status: 'active', 'season.key': sk }).lean();
  const top = clans.sort((a, b) => (b.season?.exp ?? 0) - (a.season?.exp ?? 0))[0];
  if (!top || !top.season?.exp) return null;
  await require('./hallOfFame').append({ guildId, category: 'clan_season', userId: top.ownerId, value: top.season.exp, refId: `${guildId}:${sk}`, extra: { seasonNumber: Number(seasonNumber), gameId: top.clanId } });
  const members = await ClanMember.find({ clanId: top.clanId }).lean();
  const minJoin = Date.now() - C.SEASON_MIN_TENURE_MS;
  for (const m of members) if (new Date(m.joinedAt).getTime() <= minJoin) await profile.checkTrigger(m.userId, guildId, 'clanSeason', {}, null);
  await log(guildId, top.clanId, 'season1', null, null, { season: sk, exp: top.season.exp });
  seasonCache.delete(guildId);
  return top;
}

/** 프로필 배지용 */
async function badgeOf(guildId, userId) {
  const m = await membership(guildId, userId);
  if (!m) return null;
  const clan = await clanById(m.clanId);
  return clan ? { clan, role: m.role, contribution: m.contribution } : null;
}

outbox.register('round.settled', 'clan', onSettled);

/** 관리자 강제 해산 (감사 로그는 호출한 관리자 명령어가 남김) */
async function adminDisband(guildId, name, actorId) {
  const clan = await clanByName(guildId, name);
  if (!clan) return fail('그런 이름의 클랜이 없어요.');
  return disband({ guildId, actorId: clan.ownerId, confirmName: clan.name, adminId: actorId });
}

/** 클랜이 있는 서버 목록 (주기 작업용) */
const guildsWithClans = () => Clan.distinct('guildId', { status: 'active' });

module.exports = { adminDisband, guildsWithClans, awardClanAchievements, create, apply, cancelApplication, decide, leave, kick, setRole, transfer, disband, settings, info, ranking, onSettled, awardWeekly, closeSeason, badgeOf, membership, clanByName, cooldownLeft, player };
