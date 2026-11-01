/**
 * 월드 보스 협동 이벤트 (서버 단위).
 *
 * - 시작: 관리자만 (/관리자 보스시작). 서버당 동시에 1마리 (부분 고유 인덱스).
 * - 공격: 무료(칩 없음), 하루 DAILY_ATTEMPTS회. 횟수 검사·증가는 조건부 업데이트로 원자적 (동시 클릭에도 초과 불가).
 *         피해량은 기존 주사위 엔진(rollPair)의 굴림.
 * - 지원 피해(Outbox 핸들러 'boss'): 평소 게임 한 판마다 소량, 하루 상한, 이벤트 표식으로 멱등.
 * - 체력: 원자적 $inc. 0 이하가 되면 status active→defeated 조건부 전환 (한 번만).
 * - 보상(처치·실패 모두): 참여 보스 카드(수집품), 업적, 최고 기여자 명예의 전당.
 *         칩은 처치 성공 시에만, 1인 상한, 다중 계정 방지 자격(계정 나이·이 서버 실제 플레이 판 수·최소 기여도),
 *         wallet.grantOnce(refId)로 중복 지급 불가. 보상 지급 중 멈추면 주기 작업이 이어서 처리.
 */
const crypto = require('node:crypto');
const WorldBoss = require('../db/WorldBoss');
const BossContribution = require('../db/BossContribution');
const GameLog = require('../db/GameLog');
const config = require('../config');
const wallet = require('./wallet');
const profile = require('./profile');
const outbox = require('./outbox');
const notifier = require('./notifier');
const bosses = require('../content/bosses');
const dice = require('../engine/dice');
const time = require('../content/time');

const B = config.BOSS;
const fail = (reason) => ({ ok: false, reason });

/** 디스코드 ID(snowflake) → 계정 생성 시각 */
function accountCreatedAt(userId) {
  try {
    return Number((BigInt(userId) >> 22n) + 1420070400000n);
  } catch {
    return Date.now();
  }
}

const active = (guildId) => WorldBoss.findOne({ guildId, status: 'active' }).lean();

async function start({ guildId, defId, hours = B.DEFAULT_HOURS, actorId, channelId }) {
  const def = bosses.byId[defId] ?? bosses.BOSSES[Math.floor(Math.random() * bosses.BOSSES.length)];
  if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 7) return fail('진행 시간은 1~168시간이에요.');
  if (await active(guildId)) return fail('이미 진행 중인 보스가 있어요.');
  const since = new Date(Date.now() - 7 * 86400_000);
  const players = (await GameLog.distinct('userId', { guildId, createdAt: { $gte: since } }).catch(() => [])).length;
  const maxHp = bosses.maxHpFor(def, players);
  const now = new Date();
  try {
    const doc = await WorldBoss.create({ bossId: crypto.randomUUID(), guildId, defId: def.id, seasonKey: String(new Date().getFullYear()), hp: maxHp, maxHp, phase: 1, status: 'active', startsAt: now, endsAt: new Date(now.getTime() + hours * 3600_000), createdBy: actorId, channelId });
    return { ok: true, boss: doc.toObject?.() ?? doc, def };
  } catch (err) {
    if (err.code === 11000) return fail('이미 진행 중인 보스가 있어요.');
    throw err;
  }
}

async function contribDoc(boss, userId) {
  try {
    await BossContribution.updateOne({ bossId: boss.bossId, userId }, { $setOnInsert: { guildId: boss.guildId, bossId: boss.bossId, userId } }, { upsert: true });
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
}

/** 하루 단위 카운터 초기화 (조건부 — 경합해도 한 번) */
async function rollDay(boss, userId, day) {
  await BossContribution.updateOne({ bossId: boss.bossId, userId, day: { $ne: day } }, { $set: { day, attemptsToday: 0, passiveToday: 0 } });
}

/** 공격 1회 */
async function attack({ guildId, userId }) {
  const boss = await active(guildId);
  if (!boss) return fail('지금은 출현한 보스가 없어요.');
  if (Date.now() > new Date(boss.endsAt).getTime()) {
    await finish(boss.bossId, 'failed');
    return fail('보스가 이미 도망쳤어요.');
  }
  const day = time.dayKey();
  await contribDoc(boss, userId);
  await rollDay(boss, userId, day);
  // 하루 횟수: 조건부 증가 (동시 요청도 상한을 넘지 못함)
  const slot = await BossContribution.updateOne({ bossId: boss.bossId, userId, day, attemptsToday: { $lt: B.DAILY_ATTEMPTS } }, { $inc: { attemptsToday: 1, attempts: 1 } });
  if (!slot.modifiedCount) return fail(`오늘 공격 횟수(${B.DAILY_ATTEMPTS}회)를 다 썼어요. 평소 게임을 하면 지원 피해가 들어가요!`);
  const roll = dice.rollPair();
  const { dmg, crit } = bosses.attackDamage(roll, boss.phase);
  const clan = await require('./clan').membership(guildId, userId).catch(() => null);
  await BossContribution.updateOne({ bossId: boss.bossId, userId }, { $inc: { contribution: dmg }, $set: { clanId: clan?.clanId ?? null, updatedAt: new Date() } });
  const after = await hit(boss, dmg);
  const c = await BossContribution.findOne({ bossId: boss.bossId, userId }).lean();
  return { ok: true, boss: after ?? boss, def: bosses.byId[boss.defId], roll, dmg, crit, left: B.DAILY_ATTEMPTS - c.attemptsToday, contribution: c.contribution };
}

/** 체력 감소 + 페이즈·처치 판정 */
async function hit(boss, dmg) {
  const after = await WorldBoss.findOneAndUpdate({ bossId: boss.bossId, status: 'active' }, { $inc: { hp: -dmg } }, { new: true }).lean();
  if (!after) return null;
  const phase = bosses.phaseFor(Math.max(0, after.hp), after.maxHp);
  if (phase > after.phase) {
    const ph = await WorldBoss.updateOne({ bossId: boss.bossId, phase: { $lt: phase } }, { $set: { phase } });
    if (ph.modifiedCount && after.hp > 0) {
      const def = bosses.byId[after.defId];
      notifier.announce(after.guildId, after.channelId, { content: phase === 3 ? `🔥 ${def.emoji} **${def.name}** 광폭화! (3페이즈 · 받는 피해 -20%) 조금만 더!` : `⚠️ ${def.emoji} **${def.name}** 2페이즈 돌입!`, allowedMentions: { parse: [] } }, 'important');
    }
  }
  if (after.hp <= 0) await finish(boss.bossId, 'defeated');
  return after;
}

/** 평소 게임 → 지원 피해 (하루 상한, 이벤트당 1회) */
async function onSettled(ev, { eventId }) {
  if (ev.status !== 'settled') return;
  const boss = await active(ev.guildId);
  if (!boss || Date.now() > new Date(boss.endsAt).getTime()) return;
  const dmg = bosses.passiveDamage(ev);
  if (!dmg) return;
  const day = time.dayKey();
  const mark = `boss:${eventId}`;
  await contribDoc(boss, ev.userId);
  await rollDay(boss, ev.userId, day);
  const clan = await require('./clan').membership(ev.guildId, ev.userId).catch(() => null);
  const res = await BossContribution.updateOne(
    { bossId: boss.bossId, userId: ev.userId, day, passiveToday: { $lte: B.PASSIVE_DAILY_CAP - dmg }, processed: { $ne: mark } },
    { $inc: { passiveToday: dmg, contribution: dmg }, $set: { clanId: clan?.clanId ?? null, updatedAt: new Date() }, $push: { processed: { $each: [mark], $slice: -200 } } },
  );
  if (res.modifiedCount) await hit(boss, dmg);
}

/** 종료 전환 (active → defeated/failed, 한 번만) + 보상 */
async function finish(bossId, status) {
  const res = await WorldBoss.updateOne({ bossId, status: 'active' }, { $set: { status, endedAt: new Date(), rewardState: 'granting' } });
  const boss = await WorldBoss.findOne({ bossId }).lean();
  if (res.modifiedCount) {
    const def = bosses.byId[boss.defId];
    const top = await BossContribution.find({ bossId }).sort({ contribution: -1 }).limit(3).lean();
    notifier.announce(
      boss.guildId,
      boss.channelId,
      {
        content:
          status === 'defeated'
            ? `🏆 ${def.emoji} **${def.name}** 처치 성공! 참여자 전원에게 보스 카드, 처치 보상이 지급돼요.\n${top.map((t, k) => `${['🥇', '🥈', '🥉'][k]} <@${t.userId}> ${t.contribution.toLocaleString('en-US')}`).join('\n')}`
            : `💨 ${def.emoji} **${def.name}** 이(가) 도망쳤어요… 참여 보상(보스 카드)은 지급돼요.`,
        allowedMentions: { parse: [] },
      },
      'important',
    );
  }
  if (boss.rewardState !== 'done') await grantRewards(boss);
  return boss;
}

async function eligibleForChips(boss, c) {
  if (c.contribution < B.MIN_CONTRIBUTION) return false;
  if (Date.now() - accountCreatedAt(c.userId) < B.MIN_ACCOUNT_AGE_DAYS * 86400_000) return false;
  const games = await GameLog.countDocuments({ userId: c.userId, guildId: boss.guildId, status: 'settled' });
  return games >= B.MIN_GAMES_FOR_CHIPS;
}

/** 보상 지급 (멱등 — 다시 실행해도 중복 없음) */
async function grantRewards(boss) {
  const collection = require('./collection');
  const defeated = boss.status === 'defeated';
  const all = await BossContribution.find({ bossId: boss.bossId }).sort({ contribution: -1 }).lean();
  const topId = all[0]?.contribution > 0 ? all[0].userId : null;
  for (const c of all) {
    if (c.contribution < B.MIN_CONTRIBUTION) continue;
    await collection.grant(c.userId, `boss:${boss.defId}`, { source: `boss:${boss.bossId}`, guildId: boss.guildId }).catch(console.error);
    if (defeated) await collection.grant(c.userId, `bossgold:${boss.defId}`, { source: `boss:${boss.bossId}`, guildId: boss.guildId }).catch(console.error);
    if (defeated && (await eligibleForChips(boss, c))) {
      const amount = Math.min(B.CHIP_REWARD_CAP, B.CHIP_REWARD_BASE + Math.floor((c.contribution / Math.max(1, boss.maxHp)) * B.CHIP_REWARD_CAP * 2));
      await wallet.grantOnce({ userId: c.userId, guildId: boss.guildId, amount, type: 'boss_reward', reason: `월드 보스 ${boss.defId} 처치`, refId: `boss:${boss.bossId}` });
    }
    await profile.checkTrigger(c.userId, boss.guildId, 'boss', { bossDefeated: defeated, bossTop: c.userId === topId }, null);
    await BossContribution.updateOne({ bossId: boss.bossId, userId: c.userId }, { $set: { rewarded: true } });
  }
  if (topId) await require('./hallOfFame').append({ guildId: boss.guildId, category: 'boss_top', userId: topId, value: all[0].contribution, refId: boss.bossId, extra: { gameId: boss.bossId, game: boss.defId } });
  if (defeated) {
    const clan = require('./clan');
    for (const id of [...new Set(all.filter((c) => c.clanId).map((c) => c.clanId))]) {
      const doc = await require('../db/Clan').findOne({ clanId: id, status: 'active' }).lean();
      if (doc) await clan.awardClanAchievements?.(doc, { bossDefeated: true });
    }
  }
  await WorldBoss.updateOne({ bossId: boss.bossId }, { $set: { rewardState: 'done' } });
}

/** 주기 작업: 시간 초과 보스 종료, 보상 지급 중 멈춘 보스 이어서 처리 */
async function sweep() {
  const now = new Date();
  for (const b of await WorldBoss.find({ status: 'active', endsAt: { $lt: now } }).lean()) await finish(b.bossId, 'failed');
  for (const b of await WorldBoss.find({ status: { $in: ['defeated', 'failed'] }, rewardState: { $ne: 'done' } }).lean()) await grantRewards(b);
}

async function ranking(bossId) {
  const all = await BossContribution.find({ bossId }).sort({ contribution: -1 }).lean();
  const clans = new Map();
  for (const c of all) if (c.clanId) clans.set(c.clanId, (clans.get(c.clanId) ?? 0) + c.contribution);
  return { personal: all.slice(0, 10), clans: [...clans.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5), participants: all.length, total: all.reduce((s, c) => s + c.contribution, 0) };
}

/** 지난 보스 기록과 도감 (처치한 보스 종류) */
async function history(guildId) {
  const list = await WorldBoss.find({ guildId, status: { $in: ['defeated', 'failed'] } }).sort({ endedAt: -1 }).limit(10).lean();
  const all = await WorldBoss.find({ guildId, status: 'defeated' }).lean();
  return { list, defeatedDefs: [...new Set(all.map((b) => b.defId))] };
}

async function myContribution(guildId, userId) {
  const boss = await active(guildId);
  if (!boss) return null;
  return BossContribution.findOne({ bossId: boss.bossId, userId }).lean();
}

outbox.register('round.settled', 'boss', onSettled);

module.exports = { start, active, attack, hit, onSettled, finish, grantRewards, sweep, ranking, history, myContribution, accountCreatedAt };
