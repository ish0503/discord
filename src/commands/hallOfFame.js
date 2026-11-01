/** /명예의전당 — 이 서버의 역대 기록 (덮어쓰지 않고 이력 보존) */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const hof = require('../services/hallOfFame');
const { COLOR, num } = require('../utils/format');

const who = (id) => (id === 'deleted' ? '(삭제된 사용자)' : `<@${id}>`);
const when = (d) => `<t:${Math.floor(new Date(d).getTime() / 1000)}:d>`;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('명예의전당')
    .setDescription('이 서버의 역대 최고 기록과 우승자')
    .addSubcommand((c) => c.setName('목록').setDescription('분류별 현재 기록과 최근 우승자'))
    .addSubcommand((c) =>
      c
        .setName('이력')
        .setDescription('한 분류의 기록 갱신 이력')
        .addStringOption((o) =>
          o
            .setName('분류')
            .setDescription('기록 분류')
            .setRequired(true)
            .addChoices(...Object.entries(hof.CATEGORIES).slice(0, 25).map(([value, c]) => ({ name: c.label.replace(/[^\p{L}\p{N}\s()÷·]/gu, '').trim().slice(0, 100) || value, value }))),
        ),
    )
    .addSubcommand((c) => c.setName('기록').setDescription('한 사람의 명예의 전당 기록').addUserOption((o) => o.setName('유저').setDescription('대상 (기본: 나)'))),

  async execute(i) {
    const sub = i.options.getSubcommand();
    if (sub === '이력') {
      const cat = i.options.getString('분류', true);
      const c = hof.CATEGORIES[cat];
      if (!c) return i.reply({ content: '알 수 없는 분류예요.', ephemeral: true });
      const list = await hof.history(i.guildId, cat, 15);
      const embed = new EmbedBuilder()
        .setColor(COLOR.gold)
        .setTitle(`🏛️ ${c.label} · 이력`)
        .setDescription(list.map((r) => `${r.current ? '👑' : '▫️'} ${when(r.achievedAt)} ${who(r.userId)} **${num(r.value)}${c.unit}**${r.seasonNumber ? ` · 시즌 ${r.seasonNumber}` : ''}`).join('\n') || '_아직 기록이 없어요_');
      return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }
    if (sub === '기록') {
      const user = i.options.getUser('유저') ?? i.user;
      const r = await hof.ofUser(i.guildId, user.id);
      const embed = new EmbedBuilder()
        .setColor(COLOR.gold)
        .setTitle(`🏛️ ${user.globalName ?? user.username} 님의 명예의 전당`)
        .setDescription(
          [
            `현재 보유 기록 **${r.current.length}개** · 남긴 기록 ${r.all.length}개`,
            '',
            ...r.all.slice(0, 15).map((x) => `${x.current ? '👑' : '▫️'} ${hof.CATEGORIES[x.category]?.label ?? x.category} **${num(x.value)}${hof.CATEGORIES[x.category]?.unit ?? ''}** · ${when(x.achievedAt)}`),
          ].join('\n'),
        );
      return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }
    const b = await hof.board(i.guildId);
    const bests = b.bests.sort((x, y) => (hof.CATEGORIES[x.category]?.game ? 1 : 0) - (hof.CATEGORIES[y.category]?.game ? 1 : 0));
    const embed = new EmbedBuilder()
      .setColor(COLOR.gold)
      .setTitle('🏛️ 명예의 전당')
      .setDescription(
        [
          '**👑 현재 최고 기록**',
          bests.map((x) => `${hof.CATEGORIES[x.category]?.label ?? x.category} — ${who(x.userId)} **${num(x.value)}${hof.CATEGORIES[x.category]?.unit ?? ''}** · ${when(x.updatedAt)}`).join('\n') || '_아직 기록이 없어요_',
          '',
          '**🏆 최근 우승 · 영예**',
          b.lists.map((x) => `${hof.CATEGORIES[x.category]?.label ?? x.category} — ${who(x.userId)}${x.seasonNumber ? ` (시즌 ${x.seasonNumber})` : ''} · ${when(x.achievedAt)}`).join('\n') || '_아직 없어요_',
        ].join('\n').slice(0, 4096),
      )
      .setFooter({ text: '검증된 정산 기록으로만 만들어지고, 갱신돼도 이전 기록은 이력으로 남아요 · /명예의전당 이력' });
    return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};
