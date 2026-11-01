/** 서버별 운영 설정 캐시 + 게임 가드(활성/점검/베팅 한도) + 관리자 권한 판정 */
const { PermissionFlagsBits } = require('discord.js');
const GuildConfig = require('../db/GuildConfig');
const config = require('../config');

const cache = new Map(); // guildId → { doc, at }
const TTL = 30_000;

async function get(guildId) {
  const hit = cache.get(guildId);
  if (hit && Date.now() - hit.at < TTL) return hit.doc;
  const doc = await GuildConfig.findOneAndUpdate({ guildId }, { $setOnInsert: { guildId } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  cache.set(guildId, { doc, at: Date.now() });
  return doc;
}

async function update(guildId, change) {
  const doc = await GuildConfig.findOneAndUpdate({ guildId }, change, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  cache.set(guildId, { doc, at: Date.now() });
  return doc;
}

function limitsFrom(doc, game) {
  const l = doc?.betLimits?.[game] ?? {};
  return { min: l.min ?? config.MIN_BET, max: l.max ?? config.MAX_BET };
}

/** 게임 시작 가능 여부. 불가면 사유 문자열, 가능하면 null */
async function gameBlockReason(guildId, game) {
  const doc = await get(guildId);
  if (doc.maintenance?.on) return `🛠️ 점검 중입니다. ${doc.maintenance.message || ''}`.trim();
  if (doc.disabledGames?.includes(game)) return '⛔ 이 서버에서는 현재 비활성화된 게임이에요.';
  return null;
}

async function betLimits(guildId, game) {
  return limitsFrom(await get(guildId), game);
}

/** 베팅액 검사. 문제 있으면 사유, 없으면 null */
async function betBlockReason(guildId, game, amount) {
  const { min, max } = await betLimits(guildId, game);
  if (amount < min) return `이 게임의 최소 베팅은 ${min.toLocaleString('en-US')}칩이에요.`;
  if (amount > max) return `이 게임의 최대 베팅은 ${max.toLocaleString('en-US')}칩이에요.`;
  return null;
}

/** 관리자: 봇 소유자 ∪ 서버 관리 권한 ∪ 지정 관리자 역할 */
async function isAdmin(interaction) {
  if (config.ADMIN.OWNER_IDS.includes(interaction.user.id)) return true;
  if (!interaction.inGuild()) return false;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const doc = await get(interaction.guildId);
  const roles = interaction.member?.roles;
  const roleIds = Array.isArray(roles) ? roles : roles?.cache ? [...roles.cache.keys()] : [];
  return Boolean(doc.adminRoleId && roleIds.includes(doc.adminRoleId));
}

/** 서버 알림 빈도 설정에 따라 보낼지 (importance: 'normal' | 'important') */
async function shouldNotify(guildId, importance = 'normal') {
  if (!guildId) return false;
  const level = (await get(guildId).catch(() => null))?.notifyLevel ?? 'all';
  if (level === 'off') return false;
  if (level === 'important') return importance === 'important';
  return true;
}

module.exports = { shouldNotify, get, update, gameBlockReason, betLimits, betBlockReason, isAdmin };
