/** /전적 — 최근 게임 기록 페이지네이션 (게임 필터) */
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const stats = require('../services/stats');
const registry = require('../games/registry');
const { COLOR, num, netText, ephemeral } = require('../utils/format');

const PREFIX = 'hs';
const SIZE = 10;

async function render(userId, guildId, page, game) {
  const h = await stats.history(userId, guildId, { page, size: SIZE, game: game || null });
  const lines = h.items.map((l) => {
    const t = `<t:${Math.floor(new Date(l.createdAt).getTime() / 1000)}:R>`;
    const tag = l.status === 'refunded' ? '↩️ 환불' : l.net > 0 ? '🟢' : l.net < 0 ? '🔴' : '⚪';
    return `${tag} ${registry.label(l.game)} 베팅 ${num(l.staked)} → ${num(l.payout)} **${netText(l.net)}**${l.recovered ? ' 🔧복구' : ''} · ${t}\n　\`${l.roundId.slice(0, 8)}\``;
  });
  const embed = new EmbedBuilder()
    .setColor(COLOR.info)
    .setTitle(`📜 전적${game ? ` · ${registry.label(game)}` : ''} (${page + 1}/${h.pages})`)
    .setDescription(lines.join('\n') || '_기록이 없어요._')
    .setFooter({ text: `총 ${num(h.total)}건 · 판 ID 앞 8자리로 /리플레이 가능` });
  const g = game || '-';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:${userId}:page:${page - 1}.${g}`).setLabel('이전').setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`${PREFIX}:${userId}:page:${page + 1}.${g}`).setLabel('다음').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page + 1 >= h.pages),
  );
  return { embeds: [embed], components: [row] };
}

module.exports = {
  prefix: PREFIX,
  data: new SlashCommandBuilder()
    .setName('전적')
    .setDescription('최근 게임 기록')
    .addStringOption((o) => o.setName('게임').setDescription('특정 게임만').addChoices(...registry.ids().map((id) => ({ name: registry.GAMES[id].label, value: id })))),
  async execute(i) {
    await i.deferReply({ ephemeral: false });
    await i.editReply(await render(i.user.id, i.guildId, 0, i.options.getString('게임')));
  },
  async handleButton(i, { action, arg }) {
    if (action !== 'page') return i.reply(ephemeral('알 수 없는 버튼'));
    const [p, g] = arg.split('.');
    await i.deferUpdate();
    return i.editReply(await render(i.user.id, i.guildId, Math.max(0, Number(p)), g === '-' ? null : g));
  },
};
