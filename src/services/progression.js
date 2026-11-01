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

// ── 랭크
register('rank', async (guildId, userId) => {
  const p = await require('./rank').profileOf(guildId, userId);
  const rank = require('../content/rank');
  const played = p.current.filter((d) => d.games > 0);
  if (!played.length) return null;
  const best = played.sort((a, b) => b.rating - a.rating)[0];
  const t = rank.TIERS[rank.tierIndex(best.tier)];
  const tierMap = { bronze: 'common', silver: 'rare', gold: 'rare', platinum: 'epic', diamond: 'legendary' };
  return { line: `🏅 랭크 ${played.map((d) => `${d.gameType === 'poker' ? '포커' : '토너먼트'} ${rank.TIERS[rank.tierIndex(d.tier)].emoji}${rank.TIERS[rank.tierIndex(d.tier)].name} ${d.rating}`).join(' · ')}`, badge: { text: `${t.name} 리그`, tier: tierMap[best.tier] } };
});
// ── 예측
register('predict', async (guildId, userId) => {
  const p = await require('./profile').get(userId);
  if (!p.predict?.total) return null;
  return { line: `🔮 예측 ${p.predict.score}점 · 적중 ${p.predict.correct}/${p.predict.total}` };
});
// ── 수집품 전시
register('collection', async (guildId, userId) => {
  const p = await require('./profile').get(userId);
  const cat = require('../content/collection');
  const shown = (p.showcase || []).map((id) => cat.byId[id]).filter(Boolean);
  if (!shown.length) return null;
  return { line: `🗃️ 전시 ${shown.map((x) => `${x.emoji} ${x.name}`).join(' · ')}` };
});

module.exports = { register, summary };
