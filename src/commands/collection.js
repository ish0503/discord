/** /수집 — 수집 도감(희귀도·세트·기간 한정)과 개인 전시 공간. 수집품은 장식·기록 용도 */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const collection = require('../services/collection');
const catalog = require('../content/collection');
const profile = require('../services/profile');
const { COLOR, ephemeral } = require('../utils/format');

const ITEM_CHOICES = catalog.ITEMS.slice(0, 25).map((x) => ({ name: `${x.name}`.slice(0, 100), value: x.id }));
const when = (d) => `<t:${Math.floor(new Date(d).getTime() / 1000)}:d>`;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('수집')
    .setDescription('수집 도감 — 보스 카드·기념품·시즌 한정 아이템 모으기와 전시')
    .addSubcommand((s) => s.setName('목록').setDescription('세트별 수집 현황').addUserOption((o) => o.setName('유저').setDescription('다른 사람 도감')))
    .addSubcommand((s) => s.setName('상세').setDescription('수집품 정보·획득 조건').addStringOption((o) => o.setName('아이템').setDescription('수집품').setRequired(true).addChoices(...ITEM_CHOICES)))
    .addSubcommand((s) =>
      s
        .setName('전시')
        .setDescription('프로필 전시 공간에 놓을 수집품 (최대 3개, 비우면 전시 해제)')
        .addStringOption((o) => o.setName('첫째').setDescription('수집품').addChoices(...ITEM_CHOICES))
        .addStringOption((o) => o.setName('둘째').setDescription('수집품').addChoices(...ITEM_CHOICES))
        .addStringOption((o) => o.setName('셋째').setDescription('수집품').addChoices(...ITEM_CHOICES)),
    ),

  async execute(i) {
    const sub = i.options.getSubcommand();
    if (sub === '상세') {
      const it = catalog.byId[i.options.getString('아이템', true)];
      const mine = (await collection.list(i.user.id)).owned.get(it.id);
      const embed = new EmbedBuilder()
        .setColor(COLOR.info)
        .setTitle(`${it.emoji} ${it.name}`)
        .setDescription(
          [
            `${catalog.RARITY[it.rarity]} · 세트 「${catalog.SETS[it.set]?.name ?? it.set}」`,
            `획득 조건: ${it.source}`,
            it.limited ? `⏳ **${it.limited.label}** — ${it.limited.from} ~ ${it.limited.until} 에만 획득 가능 (${catalog.obtainable(it) ? '지금 획득 가능' : '지금은 획득 불가'})` : '',
            '',
            mine ? `✅ 보유 · ${when(mine.obtainedAt)} 획득 · 경로 \`${mine.source}\`` : '▫️ 아직 없어요',
          ]
            .filter((x) => x !== '')
            .join('\n'),
        )
        .setFooter({ text: '수집품은 장식·기록 용도예요 — 게임 확률·배당에는 영향이 없어요' });
      return i.reply({ embeds: [embed], ephemeral: true });
    }
    if (sub === '전시') {
      const ids = ['첫째', '둘째', '셋째'].map((k) => i.options.getString(k)).filter(Boolean);
      const r = await collection.setShowcase(i.user.id, ids);
      return i.reply(ephemeral(r.ok ? (r.ids.length ? `🗃️ 전시 공간: ${r.ids.map((id) => `${catalog.byId[id].emoji} ${catalog.byId[id].name}`).join(' · ')} — /프로필 에 보여요` : '전시를 비웠어요.') : `❌ ${r.reason}`));
    }
    const user = i.options.getUser('유저') ?? i.user;
    const [c, p] = await Promise.all([collection.list(user.id), profile.get(user.id)]);
    const embed = new EmbedBuilder()
      .setColor(COLOR.gold)
      .setTitle(`📚 ${user.globalName ?? user.username} 님의 수집 도감 · ${c.owned.size}/${c.total}`)
      .setDescription(
        [
          p.showcase?.length ? `🗃️ **전시 공간** ${p.showcase.map((id) => `${catalog.byId[id]?.emoji ?? ''} ${catalog.byId[id]?.name ?? id}`).join(' · ')}\n` : '',
          ...Object.entries(catalog.SETS).map(([setId, set]) => {
            const items = catalog.setItems(setId);
            const have = items.filter((x) => c.owned.has(x.id)).length;
            const done = p.collectionSets?.includes(setId);
            return `**${set.name}** ${have}/${items.length}${done ? ' ✅ 세트 완성' : set.reward ? ` · 완성 보상 「${set.reward.title}」` : ''}\n${items.map((x) => (c.owned.has(x.id) ? x.emoji : '❔')).join(' ')}`;
          }),
        ]
          .filter((x) => x !== '')
          .join('\n')
          .slice(0, 4096),
      )
      .setFooter({ text: '/수집 상세 로 획득 조건 확인 · /수집 전시 로 프로필 전시 · 기간 한정 아이템은 기간이 지나면 얻을 수 없어요' });
    return i.reply({ embeds: [embed] });
  },
};
