/**
 * 프로필에 붙는 "신규 시스템 요약" 한곳에서 모으기 (특별 규칙·스토리·명예의 전당 …).
 * 이후 클랜·랭크·보스·수집품·라이벌도 여기에 한 줄씩 추가된다.
 * 각 항목은 실패해도 프로필 전체가 깨지지 않도록 개별로 감싼다.
 */
const providers = []; // async (guildId, userId) → { line?, badge? } | null

function register(name, fn) {
  if (!providers.some((p) => p.name === name)) providers.push({ name, fn });
}

async function summary(guildId, userId) {
  const parts = await Promise.all(providers.map((p) => p.fn(guildId, userId).catch(() => null)));
  const clan = parts.find((x) => x?.clanTag);
  return { lines: parts.filter((x) => x?.line).map((x) => x.line), badges: parts.filter((x) => x?.badge).map((x) => x.badge), clanTag: clan?.clanTag ?? null };
}

// ── 특별 규칙
register('rule', async (guildId, userId) => {
  const v = await require('./dailyRule').view(userId);
  const st = v.state || {};
  return { line: `🎯 오늘의 규칙 「${v.today.name}」 ${st.completed ? '✅ 완수' : `${st.progress ?? 0}/${v.today.goal}`} · 누적 ${v.completions}회` };
});
// ── 스토리
register('story', async (guildId, userId) => {
  const s = await require('./story').get(guildId, userId);
  const story = require('../content/story');
  if (!s.chapterId && !s.completedChapters.length) return null;
  const cur = s.chapterId ? story.byId[s.chapterId] : null;
  return { line: `📖 스토리 ${s.completedChapters.length}/${story.CHAPTERS.length}장${cur ? ` · 진행 중: ${cur.name}` : ''}`, badge: s.completedChapters.length >= story.CHAPTERS.length ? { text: '스토리 완주', tier: 'legendary' } : null };
});
// ── 명예의 전당
register('hof', async (guildId, userId) => {
  const r = await require('./hallOfFame').ofUser(guildId, userId);
  if (!r.all.length) return null;
  return { line: `🏛️ 명예의 전당 현재 기록 ${r.current.length}개 · 누적 ${r.all.length}개`, badge: r.current.length ? { text: `전당 기록 ${r.current.length}`, tier: 'epic' } : null };
});

// ── 클랜
register('clan', async (guildId, userId) => {
  const b = await require('./clan').badgeOf(guildId, userId);
  if (!b) return null;
  const roles = require('../content/clan').ROLES;
  return { line: `${b.clan.emblem} 클랜 **[${b.clan.tag}] ${b.clan.name}** Lv.${b.clan.level} · ${roles[b.role]?.label ?? b.role} · 기여 ${b.contribution.toLocaleString('en-US')}`, clanTag: b.clan.tag, clanName: b.clan.name };
});
// ── 월드 보스
register('boss', async (guildId, userId) => {
  const c = await require('./worldBoss').myContribution(guildId, userId);
  if (!c?.contribution) return null;
  return { line: `🐉 이번 월드 보스 기여 ${c.contribution.toLocaleString('en-US')}` };
});

module.exports = { register, summary };
