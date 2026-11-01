/** /스토리 — 스토리 챌린지 (지도 · 시작 · 진행). 칩을 걸거나 잃지 않고, 평소 게임 결과로 진행돼요. */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const storyService = require('../services/story');
const story = require('../content/story');
const { COLOR, ephemeral } = require('../utils/format');

function stageLines(ch, s) {
  return ch.stages.map((st, k) => {
    const done = s.completedStages?.includes(`${ch.id}:${st.id}`);
    const cur = s.chapterId === ch.id && s.stage === k;
    return `${done ? '✅' : cur ? '▶️' : '▫️'} ${st.text}${cur ? ` — **${s.progress}/${st.goal}**` : ''}`;
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('스토리')
    .setDescription('스토리 챌린지 — 챕터별 목표를 달성해 한정 칭호·테두리 얻기')
    .addSubcommand((c) => c.setName('지도').setDescription('전체 챕터와 완료 현황'))
    .addSubcommand((c) => c.setName('시작').setDescription('다음 챕터 시작'))
    .addSubcommand((c) => c.setName('진행').setDescription('지금 챕터의 목표와 진행도')),

  async execute(i) {
    const sub = i.options.getSubcommand();
    if (sub === '시작') {
      const r = await storyService.start(i.guildId, i.user.id);
      if (!r.ok) return i.reply(ephemeral(r.reason === 'all-done' ? '🏁 모든 챕터를 완료했어요! 새 이야기를 기다려 주세요.' : '🔒 지금 열려 있는 챕터가 없어요.'));
      const ch = r.chapter;
      const embed = new EmbedBuilder()
        .setColor(COLOR.gold)
        .setTitle(`📖 ${ch.name}${r.already ? ' (진행 중)' : ' 시작!'}`)
        .setDescription([ch.intro, '', '**목표**', ...stageLines(ch, r.state), '', `🎁 보상: 칭호 「${ch.reward.title}」 · ⭐ ${ch.reward.points}P${ch.reward.item ? ' · 한정 테두리' : ''}`].join('\n'))
        .setFooter({ text: '평소처럼 게임을 하면 목표가 채워져요 · 실패해도 칩을 잃지 않아요' });
      return i.reply({ embeds: [embed] });
    }
    const s = await storyService.get(i.guildId, i.user.id);
    if (sub === '진행') {
      if (!s.chapterId) return i.reply(ephemeral('진행 중인 챕터가 없어요. `/스토리 시작` 으로 다음 챕터를 여세요.'));
      const ch = story.byId[s.chapterId];
      const embed = new EmbedBuilder()
        .setColor(COLOR.info)
        .setTitle(`📖 ${ch.name}`)
        .setDescription([ch.intro, '', ...stageLines(ch, s)].join('\n'));
      return i.reply({ embeds: [embed], ephemeral: true });
    }
    // 지도
    const embed = new EmbedBuilder()
      .setColor(COLOR.info)
      .setTitle(`🗺️ 스토리 지도 · ${s.completedChapters.length}/${story.CHAPTERS.length} 챕터`)
      .setDescription(
        story.CHAPTERS.map((ch, k) => {
          const done = s.completedChapters.includes(ch.id);
          const cur = s.chapterId === ch.id;
          const locked = !done && !cur && story.CHAPTERS.slice(0, k).some((c) => !s.completedChapters.includes(c.id));
          const period = ch.availableUntil ? ` · ⏳ ~${ch.availableUntil.slice(0, 10)} 한정` : '';
          return `${done ? '✅' : cur ? '▶️' : locked ? '🔒' : '📘'} **${ch.name}**${period}\n　└ 🎁 「${ch.reward.title}」${ch.reward.item ? ' + 한정 테두리' : ''}`;
        }).join('\n'),
      )
      .setFooter({ text: '보상은 유저당 챕터별 한 번 (다른 서버에서 다시 받을 수 없어요)' });
    return i.reply({ embeds: [embed] });
  },
};
