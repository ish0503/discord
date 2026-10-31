/** /상점 — 꾸미기 아이템 구매 (보상 포인트 또는 칩). 확률·배당에는 영향 없음 */
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const profile = require('../services/profile');
const wallet = require('../services/wallet');
const cosmetics = require('../content/cosmetics');
const { COLOR, num, chips, ephemeral } = require('../utils/format');

const PREFIX = 'sh';
const priceText = (it) => (it.price.points ? `⭐ ${num(it.price.points)}P` : `🪙 ${num(it.price.chips)}칩`);

async function render(userId, guildId) {
  const [p, acc] = await Promise.all([profile.get(userId), wallet.getAccount(userId, guildId)]);
  const groups = {};
  for (const it of cosmetics.SHOP) (groups[it.type] ||= []).push(it);
  const lines = Object.entries(groups).flatMap(([type, list]) => [
    `**${cosmetics.TYPE_LABEL[type]}**`,
    ...list.map((it) => `${p.inventory.includes(it.id) ? '✅' : '▫️'} ${cosmetics.itemName(it)} — ${priceText(it)}`),
  ]);
  const options = cosmetics.SHOP.filter((it) => !p.inventory.includes(it.id))
    .slice(0, 25)
    .map((it) => ({ label: cosmetics.itemName(it).slice(0, 100), description: priceText(it), value: it.id }));
  const embed = new EmbedBuilder()
    .setColor(COLOR.gold)
    .setTitle('🛍️ 카지노 상점')
    .setDescription([`⭐ 보유 포인트 **${num(p.rewardPoints)}P** · 💼 잔고 ${chips(acc.money)}`, '', ...lines].join('\n'))
    .setFooter({ text: '모든 아이템은 외형만 바꿔요 · 칩 구매 아이템은 칩을 경제에서 회수합니다 · /인벤토리 에서 장착' });
  const components = options.length
    ? [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`${PREFIX}:${userId}:buy:`).setPlaceholder('구매할 아이템 선택').addOptions(options))]
    : [];
  return { embeds: [embed], components };
}

module.exports = {
  prefix: PREFIX,
  data: new SlashCommandBuilder().setName('상점').setDescription('꾸미기 아이템 상점'),
  async execute(i) {
    await i.deferReply();
    await i.editReply(await render(i.user.id, i.guildId));
  },
  async handleSelect(i, { action }) {
    if (action !== 'buy') return undefined;
    await i.deferUpdate();
    const r = await profile.purchase(i.user.id, i.guildId, i.values[0]);
    await i.followUp(ephemeral(r.ok ? `🛍️ **${cosmetics.itemName(r.item)}** 구매 완료! /인벤토리 에서 장착하세요.` : `❌ ${r.reason}`));
    return i.editReply(await render(i.user.id, i.guildId));
  },
};
