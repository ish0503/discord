/** /인벤토리 — 칭호·꾸미기 장착 */
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const profile = require('../services/profile');
const cosmetics = require('../content/cosmetics');
const { COLOR, ephemeral } = require('../utils/format');

const PREFIX = 'iv';

async function render(userId) {
  const p = await profile.get(userId);
  const eq = { ...cosmetics.DEFAULTS, ...p.equipped };
  const options = [];
  // 칭호
  options.push({ label: '칭호 해제', value: 'title|', description: eq.title ? `현재: ${eq.title}` : '장착 안 함' });
  for (const t of p.titles) options.push({ label: `${eq.title === t ? '✅ ' : ''}칭호 「${t}」`.slice(0, 100), value: `title|${t}`.slice(0, 100) });
  // 꾸미기 (기본값 + 보유 아이템)
  for (const type of Object.keys(cosmetics.CATALOG)) {
    const owned = [cosmetics.DEFAULTS[type], ...cosmetics.SHOP.filter((it) => it.type === type && p.inventory.includes(it.id)).map((it) => it.value)];
    for (const v of owned) options.push({ label: `${eq[type] === v ? '✅ ' : ''}${cosmetics.TYPE_LABEL[type]} · ${cosmetics.CATALOG[type][v].name}`.slice(0, 100), value: `${type}|${v}` });
  }
  const show = (type) => cosmetics.CATALOG[type][eq[type]]?.name ?? eq[type];
  const embed = new EmbedBuilder()
    .setColor(cosmetics.color(eq.color, COLOR.info))
    .setTitle('🎒 인벤토리')
    .setDescription(
      [
        `🏷️ 칭호: **${eq.title ?? '없음'}**`,
        `🃏 카드: **${show('cardTheme')}** — 예시 ${cosmetics.card({ rank: 'A', suit: '♠' }, eq.cardTheme)} ${cosmetics.card({ rank: 'K', suit: '♥' }, eq.cardTheme)}`,
        `🎰 슬롯: **${show('slotTheme')}** — ${['🍒', '💎', '7️⃣'].map((e) => cosmetics.slotSymbol(e, eq.slotTheme)).join(' ')}`,
        `🎲 주사위: **${show('diceSkin')}** — ${cosmetics.diceFace(1, eq.diceSkin)} ${cosmetics.diceFace(6, eq.diceSkin)}`,
        `🎨 색상: **${show('color')}** · 🖼️ 테두리: **${show('frame')}** — ${cosmetics.framed('미리보기', eq.frame)}`,
        '',
        `보유 칭호 ${p.titles.length}개 · 보유 아이템 ${p.inventory.length}개`,
      ].join('\n'),
    );
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`${PREFIX}:${userId}:equip:`).setPlaceholder('장착할 항목 선택').addOptions([...new Map(options.map((o) => [o.value, o])).values()].slice(0, 25)))],
  };
}

module.exports = {
  prefix: PREFIX,
  data: new SlashCommandBuilder().setName('인벤토리').setDescription('칭호·꾸미기 아이템 장착'),
  async execute(i) {
    await i.deferReply({ ephemeral: true });
    await i.editReply(await render(i.user.id));
  },
  async handleSelect(i, { action }) {
    if (action !== 'equip') return undefined;
    const [type, value] = i.values[0].split('|');
    await i.deferUpdate();
    const r = await profile.equip(i.user.id, type, type === 'title' ? value || null : value);
    if (!r.ok) await i.followUp(ephemeral(`❌ ${r.reason}`));
    return i.editReply(await render(i.user.id));
  },
};
