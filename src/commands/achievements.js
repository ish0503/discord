/** /업적 — 전체 업적 목록 (숨겨진 업적은 달성 전 ???) */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const profile = require('../services/profile');
const { ACHIEVEMENTS, RARITY } = require('../content/achievements');
const { COLOR } = require('../utils/format');

module.exports = {
  data: new SlashCommandBuilder().setName('업적').setDescription('업적 목록과 달성 현황'),
  async execute(i) {
    const p = await profile.get(i.user.id);
    const have = new Map((p.achievements || []).map((a) => [a.id, a.at]));
    const lines = ACHIEVEMENTS.map((a) => {
      const got = have.has(a.id);
      if (a.hidden && !got) return `🔒 ${RARITY[a.rarity]} **???** — 숨겨진 업적`;
      return `${got ? '✅' : '⬜'} ${RARITY[a.rarity]} **${a.name}** — ${a.desc} · 칭호 「${a.title}」 · ${a.points}P`;
    });
    const embed = new EmbedBuilder()
      .setColor(COLOR.gold)
      .setTitle(`🏆 업적 ${have.size}/${ACHIEVEMENTS.length}`)
      .setDescription(lines.join('\n').slice(0, 4096))
      .setFooter({ text: '⚪ 일반 · 🔵 희귀 · 🟣 에픽 · 보상은 칭호와 보상 포인트 (칩 아님)' });
    await i.reply({ embeds: [embed] });
  },
};
