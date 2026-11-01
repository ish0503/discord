/**
 * 클랜(이용자 길드) 규칙 (순수 로직).
 * 코드에서 guildId 는 "디스코드 서버"를 뜻하므로, 이용자 모임은 클랜(Clan)이라고 부른다.
 *
 * 경제 분리: 클랜 경험치는 플레이 "횟수·승리"로만 쌓이고 칩 지급과 무관하다. 공동 지갑·클랜 간 칩 이동은 없다.
 * 악용 방지: 멤버별 하루 기여 상한(서버×유저 기준 — 클랜을 옮겨도 초기화되지 않음), 탈퇴 후 재가입 대기,
 *           기여 경험치는 클랜에 남음(탈퇴해도 회수·이전 불가), 시즌 보상은 일정 기간 이상 소속된 멤버만.
 */
const config = require('../config');

const C = config.CLAN;
const ROLES = { owner: { label: '👑 클랜장', rank: 3 }, officer: { label: '⚔️ 부클랜장', rank: 2 }, member: { label: '🛡️ 멤버', rank: 1 } };
const EMBLEMS = ['🐉', '🦁', '🦅', '🐺', '🦊', '🐯', '🔥', '⚡', '🌙', '⭐', '🛡️', '⚔️', '👑', '💎', '🍀', '🌊', '🎲', '🃏'];

/** 권한: 무엇을 할 수 있나 */
const CAN = {
  approve: (role) => ROLES[role]?.rank >= 2,
  kick: (actor, target) => ROLES[actor]?.rank >= 2 && ROLES[actor].rank > (ROLES[target]?.rank ?? 0),
  settings: (role) => ROLES[role]?.rank >= 2,
  promote: (role) => role === 'owner',
  transfer: (role) => role === 'owner',
  disband: (role) => role === 'owner',
};

const NAME_RE = /^[\p{Script=Hangul}A-Za-z0-9 ]{2,16}$/u;
const TAG_RE = /^[\p{Script=Hangul}A-Z0-9]{2,5}$/u;

function validateName(name) {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!NAME_RE.test(n)) return { ok: false, reason: '클랜 이름은 한글·영문·숫자·공백 2~16자예요.' };
  return { ok: true, value: n, key: n.toLowerCase().replace(/\s/g, '') };
}

function validateTag(tag) {
  const t = String(tag ?? '').trim().toUpperCase();
  if (!TAG_RE.test(t)) return { ok: false, reason: '태그는 한글·대문자 영문·숫자 2~5자예요.' };
  return { ok: true, value: t };
}

function validateText(text, max) {
  const t = String(text ?? '').trim();
  if (t.length > max) return { ok: false, reason: `${max}자 이하로 적어 주세요.` };
  if (/@everyone|@here|<@[!&]?\d+>/.test(t)) return { ok: false, reason: '멘션은 넣을 수 없어요.' };
  return { ok: true, value: t };
}

/** 누적 경험치 → 레벨 (레벨 n에 필요한 누적 = BASE × n^1.5) */
function levelFor(exp) {
  let lv = 1;
  while (lv < C.MAX_LEVEL && exp >= Math.floor(C.LEVEL_BASE_EXP * lv ** 1.5)) lv += 1;
  return lv;
}
const expForLevel = (lv) => (lv <= 1 ? 0 : Math.floor(C.LEVEL_BASE_EXP * (lv - 1) ** 1.5));
const maxMembers = (lv) => Math.min(C.MAX_MEMBERS_CAP, C.BASE_MEMBERS + C.MEMBERS_PER_LEVEL * (lv - 1));

/** 정산 한 판의 경험치 (칩 금액과 무관) */
function expFor(ev) {
  if (ev.status !== 'settled') return 0;
  return C.EXP_PER_ROUND + (ev.net > 0 ? C.EXP_WIN_BONUS : 0) + (ev.game === 'tournament' ? C.EXP_TOURNAMENT_BONUS : 0);
}

/** 클랜 업적 (클랜 단위, 클랜 정보·배지에 표시) */
const CLAN_ACHIEVEMENTS = [
  { id: 'lv3', name: '성장하는 클랜', check: (c) => c.level >= 3 },
  { id: 'lv5', name: '이름난 클랜', check: (c) => c.level >= 5 },
  { id: 'lv10', name: '전설의 클랜', check: (c) => c.level >= 10 },
  { id: 'members10', name: '대가족', check: (c) => c.memberCount >= 10 },
  { id: 'weekly1', name: '주간 1위', check: (c, ctx) => ctx?.weeklyRank === 1 },
  { id: 'boss', name: '보스 사냥단', check: (c, ctx) => ctx?.bossDefeated === true },
];

function newClanAchievements(clan, ctx = {}) {
  const have = new Set(clan.achievements || []);
  return CLAN_ACHIEVEMENTS.filter((a) => !have.has(a.id) && a.check(clan, ctx));
}

module.exports = { ROLES, EMBLEMS, CAN, validateName, validateTag, validateText, levelFor, expForLevel, maxMembers, expFor, CLAN_ACHIEVEMENTS, newClanAchievements };
