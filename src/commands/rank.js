/** /랭크 — 랭크 리그 (포커·토너먼트 실력 점수, 칩과 무관) */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const rankService = require('../services/rank');
const rank = require('../content/rank');
const { COLOR, num } = require('../utils/format');

const GAME_CHOICES = [
  { name: '포커페이스', value: 'poker' },
  { name: '토너먼트', value: 'tournament' },
];
const tierText = (id) => {
  const t = rank.TIERS[rank.tierIndex(id)] ?? rank.TIERS[0];
  return `${t.emoji} ${t.name}`;
};
const gameName = (g) => (g === 'poker' ? '포커' : '토너먼트');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('랭크')
    .setDescription('랭크 리그 — 포커·토너먼트 실력 점수와 등급 (칩 보유량과 무관)')
    .addSubcommand((s) => s.setName('프로필').setDescription('랭크 점수·등급·전적').addUserOption((o) => o.setName('유저').setDescription('대상 (기본: 나)')))
    .addSubcommand((s) =>
      s
        .setName('순위')
        .setDescription('랭크 순위표')
        .addStringOption((o) => o.setName('게임').setDescription('게임').addChoices(...GAME_CHOICES))
        .addStringOption((o) => o.setName('기간').setDescription('기간').addChoices({ name: '이번 시즌 (점수)', value: 'season' }, { name: '이번 주 (상승폭)', value: 'weekly' })),
    )
    .addSubcommand((s) => s.setName('이력').setDescription('지난 시즌 최고 등급 기록').addUserOption((o) => o.setName('유저').setDescription('대상 (기본: 나)'))),

  async execute(i) {
    const sub = i.options.getSubcommand();
    if (sub === '순위') {
      const game = i.options.getString('게임') ?? 'poker';
      const kind = i.options.getString('기간') ?? 'season';
      const list = await rankService.leaderboard(i.guildId, game, kind);
      const embed = new EmbedBuilder()
        .setColor(COLOR.gold)
        .setTitle(`🏅 ${gameName(game)} 랭크 · ${kind === 'weekly' ? '이번 주 상승폭' : '이번 시즌'}`)
        .setDescription(list.map((x, k) => `${['🥇', '🥈', '🥉'][k] ?? `\`${k + 1}\``} <@${x.d.userId}> ${tierText(x.d.tier)} **${kind === 'weekly' ? `${x.v > 0 ? '+' : ''}${x.v}` : num(x.v)}** · ${x.d.wins}승 ${x.d.losses}패`).join('\n') || '_아직 랭크 경기가 없어요_')
        .setFooter({ text: '같은 상대와 반복한 판·비공개 방 판은 점수에 덜/안 반영돼요 · 강등은 하한보다 50점 더 떨어질 때' });
      return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }
    const user = i.options.getUser('유저') ?? i.user;
    const p = await rankService.profileOf(i.guildId, user.id);
    if (sub === '이력') {
      const embed = new EmbedBuilder()
        .setColor(COLOR.info)
        .setTitle(`📜 ${user.globalName ?? user.username} 님의 랭크 이력`)
        .setDescription(p.past.map((d) => `시즌 ${d.seasonKey} · ${gameName(d.gameType)} · 최고 ${tierText(d.peakTier)} (${num(d.peakRating)}) · 최종 ${num(d.rating)} · ${d.wins}승 ${d.losses}패`).join('\n') || '_지난 시즌 기록이 없어요_');
      return i.reply({ embeds: [embed] });
    }
    const lines = rank.RANKED_GAMES.map((g) => {
      const d = p.current.find((x) => x.gameType === g);
      if (!d) return `**${gameName(g)}** — 아직 경기 없음 (시작 ${rank.START}점 · ${tierText('bronze')})`;
      const recent = (d.recent || []).slice(-5).map((r) => (r.delta > 0 ? `+${r.delta}` : `${r.delta}`)).join(' ');
      const next = rank.TIERS[rank.tierIndex(d.tier) + 1];
      return `**${gameName(g)}** ${tierText(d.tier)} **${num(d.rating)}점**${next ? ` (다음 ${next.emoji} ${next.name} ${next.min}점)` : ''}\n　${d.wins}승 ${d.losses}패 · ${d.games}경기 · 최고 ${num(d.peakRating)} · 최근 ${recent || '-'}`;
    });
    const embed = new EmbedBuilder()
      .setColor(COLOR.info)
      .setTitle(`🏅 ${user.globalName ?? user.username} 님의 랭크 · 시즌 ${p.seasonKey}`)
      .setDescription([...lines, '', `등급: ${rank.TIERS.map((t) => `${t.emoji}${t.name}${Number.isFinite(t.min) ? ` ${t.min}+` : ''}`).join(' · ')}`].join('\n'))
      .setFooter({ text: '실력 게임(포커·토너먼트)만, 게임별로 따로 계산 · 상대 점수와 경기 수를 반영한 Elo' });
    return i.reply({ embeds: [embed] });
  },
};
