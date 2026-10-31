/**
 * /업적 — 등급별(신화·전설·영웅·희귀·일반)로 묶은 업적 목록과 달성 현황.
 * 영웅 이상은 이름에 특수기호 장식, 숨겨진 업적은 달성 전 ???.
 */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const profile = require('../services/profile');
const { ACHIEVEMENTS, TIERS, TIER_ORDER, display, tierCounts } = require('../content/achievements');
const { COLOR, num } = require('../utils/format');

const bar = (have, total, len = 12) => {
  const n = total ? Math.round((have / total) * len) : 0;
  return `${'▰'.repeat(n)}${'▱'.repeat(len - n)}`;
};

function line(a, got, detailed) {
  if (a.hidden && !got) return `🔒 **???** · 숨겨진 업적${detailed ? ` · ${num(a.points)}P` : ''}`;
  const name = got ? `**${display(a)}**` : display(a);
  if (detailed) return `${got ? '✅' : '▫️'} ${name}\n　└ ${a.desc} · 칭호 「${a.title}」 · ${num(a.points)}P`;
  return `${got ? '✅' : '▫️'} ${name}${got ? '' : ` · ${a.desc}`}`;
}

/** 필드 값 1024자 제한 안에서 줄 단위로 자름 */
function fit(lines, max = 1024) {
  const out = [];
  let len = 0;
  for (const l of lines) {
    if (len + l.length + 1 > max - 12) {
      out.push(`…외 ${lines.length - out.length}개`);
      break;
    }
    out.push(l);
    len += l.length + 1;
  }
  return out.join('\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('업적')
    .setDescription('등급별 업적 목록과 달성 현황')
    .addStringOption((o) =>
      o
        .setName('등급')
        .setDescription('한 등급만 자세히 보기')
        .addChoices(...TIER_ORDER.map((t) => ({ name: `${TIERS[t].emoji} ${TIERS[t].label}`, value: t }))),
    )
    .addUserOption((o) => o.setName('유저').setDescription('다른 사람의 업적 보기')),

  async execute(i) {
    const user = i.options.getUser('유저') ?? i.user;
    const only = i.options.getString('등급');
    const p = await profile.get(user.id);
    const have = new Set((p.achievements || []).map((a) => a.id));
    const counts = tierCounts(p.achievements);
    const total = ACHIEVEMENTS.length;

    const embed = new EmbedBuilder()
      .setColor(only ? parseInt(TIERS[only].color[0].slice(1), 16) : COLOR.gold)
      .setTitle(`🏆 ${user.id === i.user.id ? '내' : `${user.globalName ?? user.username}님의`} 업적 · ${have.size}/${total}`)
      .setFooter({ text: '⚪ 일반 · 🔵 희귀 · 🟣 영웅 ✧ · 🟡 전설 『✦』 · 🔴 신화 ⟪♛⟫ · 보상은 칭호와 보상 포인트 (칩 아님)' });

    if (only) {
      const list = ACHIEVEMENTS.filter((a) => a.rarity === only);
      const c = counts[only];
      embed.setDescription(
        [`${TIERS[only].emoji} **${TIERS[only].label} 등급** ${bar(c.have, c.total)} ${c.have}/${c.total}`, '', ...list.map((a) => line(a, have.has(a.id), true))].join('\n').slice(0, 4096),
      );
    } else {
      embed.setDescription(
        [
          `${bar(have.size, total, 16)} **${Math.round((have.size / total) * 100)}%**`,
          TIER_ORDER.map((t) => `${TIERS[t].emoji} ${TIERS[t].label} ${counts[t].have}/${counts[t].total}`).join(' · '),
          '`/업적 등급:` 으로 한 등급의 조건·칭호·포인트를 자세히 볼 수 있어요.',
        ].join('\n'),
      );
      for (const t of TIER_ORDER) {
        const list = ACHIEVEMENTS.filter((a) => a.rarity === t);
        const done = list.filter((a) => have.has(a.id));
        const rest = list.filter((a) => !have.has(a.id));
        embed.addFields({
          name: `${TIERS[t].emoji} ${TIERS[t].label} — ${counts[t].have}/${counts[t].total}`,
          value: fit([...done, ...rest].map((a) => line(a, have.has(a.id), false))) || '-',
        });
      }
    }
    await i.reply({ embeds: [embed] });
  },
};
