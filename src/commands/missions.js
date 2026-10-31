/** /미션 — 일일·주간 미션 진행도와 보상(보상 포인트) 수령 */
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const profile = require('../services/profile');
const events = require('../services/events');
const { COLOR, num, ephemeral } = require('../utils/format');

const PREFIX = 'ms';
const bar = (cur, goal) => {
  const r = Math.min(1, cur / goal);
  return `${'▰'.repeat(Math.round(r * 10))}${'▱'.repeat(10 - Math.round(r * 10))}`;
};

async function render(userId, guildId) {
  const p = await profile.rollMissions(await profile.get(userId));
  const { daily, weekly } = profile.currentMissions();
  const mult = await events.pointsMultiplier(guildId);
  const buttons = [];
  const lines = (kind, list) =>
    list.map((m) => {
      const cur = p.missions?.[kind]?.[m.id] ?? 0;
      const claimed = (p.missions?.[`${kind}Claimed`] || []).includes(m.id);
      const done = cur >= m.goal;
      if (done && !claimed) buttons.push(new ButtonBuilder().setCustomId(`${PREFIX}:${userId}:claim:${kind}.${m.id}`).setLabel(`${m.text.slice(0, 20)} 보상`).setEmoji('🎁').setStyle(ButtonStyle.Success));
      return `${claimed ? '✅' : done ? '🎁' : '⬜'} ${m.text} — ${bar(cur, m.goal)} ${num(Math.min(cur, m.goal))}/${num(m.goal)} · **${num(Math.floor(m.points * mult))}P**`;
    });
  const embed = new EmbedBuilder()
    .setColor(COLOR.info)
    .setTitle('🗓️ 미션')
    .setDescription(['**오늘의 미션**', ...lines('daily', daily), '', '**이번 주 미션**', ...lines('weekly', weekly), '', `⭐ 보유 포인트 **${num(p.rewardPoints)}P**${mult > 1 ? ` · 🎉 이벤트 포인트 ×${mult}` : ''}`].join('\n'))
    .setFooter({ text: '보상은 보상 포인트(상점 꾸미기 아이템용)로 지급되어 칩 경제에 영향을 주지 않아요 · 일일 자정 / 주간 월요일 초기화 (KST)' });
  return { embeds: [embed], components: buttons.length ? [new ActionRowBuilder().addComponents(buttons.slice(0, 5))] : [] };
}

module.exports = {
  prefix: PREFIX,
  data: new SlashCommandBuilder().setName('미션').setDescription('일일·주간 미션 확인 및 보상 받기'),
  async execute(i) {
    await i.deferReply();
    await i.editReply(await render(i.user.id, i.guildId));
  },
  async handleButton(i, { action, arg }) {
    if (action !== 'claim') return undefined;
    const [kind, id] = arg.split('.');
    await i.deferUpdate();
    const r = await profile.claimMission(i.user.id, i.guildId, kind, id);
    if (!r.ok) await i.followUp(ephemeral(r.reason));
    else await i.followUp(ephemeral(`🎁 **${r.mission.text}** 보상 +${num(r.reward)}P${r.multiplier > 1 ? ` (이벤트 ×${r.multiplier})` : ''}`));
    return i.editReply(await render(i.user.id, i.guildId));
  },
};
