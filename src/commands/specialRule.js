/** /특별규칙 — 매일 바뀌는 특별 규칙 (오늘·내일 규칙, 내 진행, 최근 기록) */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const dailyRule = require('../services/dailyRule');
const { COLOR, num } = require('../utils/format');

const bar = (p, g, len = 10) => {
  const n = Math.round((Math.min(p, g) / g) * len);
  return `${'▰'.repeat(n)}${'▱'.repeat(len - n)}`;
};

/** 다음 자정(서비스 시간대) 유닉스 초 — KST 기준 */
function nextMidnightUnix(now = Date.now()) {
  const kst = new Date(now + 9 * 3600_000);
  kst.setUTCHours(24, 0, 0, 0);
  return Math.floor((kst.getTime() - 9 * 3600_000) / 1000);
}

module.exports = {
  data: new SlashCommandBuilder().setName('특별규칙').setDescription('오늘의 특별 규칙 — 매일 바뀌는 도전 과제와 내 진행도'),
  async execute(i) {
    const v = await dailyRule.view(i.user.id);
    const st = v.state || {};
    const end = nextMidnightUnix();
    const embed = new EmbedBuilder()
      .setColor(st.completed ? COLOR.win : COLOR.gold)
      .setTitle(`🎯 오늘의 특별 규칙 · ${v.today.name}`)
      .setDescription(
        [
          v.today.desc,
          '',
          `진행 ${bar(st.progress ?? 0, v.today.goal)} **${num(st.progress ?? 0)}/${num(v.today.goal)}**${st.completed ? ' · ✅ 완수!' : ''}`,
          `보상 ⭐ **${num(v.today.points)}P** (달성 즉시 지급 · 이벤트 배수 적용) · ⏰ <t:${end}:R> 종료`,
          '',
          `📅 **내일 규칙 미리보기:** ${v.tomorrow.name} — ${v.tomorrow.desc}`,
          '',
          '**최근 기록**',
          v.history.length ? v.history.slice(-7).reverse().map((h) => `${h.completed ? '✅' : '▫️'} ${h.key} ${require('../content/dailyRules').byId[h.ruleId]?.name ?? h.ruleId} (${h.progress})`).join('\n') : '_아직 기록이 없어요_',
        ].join('\n'),
      )
      .setFooter({ text: `누적 완수 ${v.completions}회 · 특별 규칙은 도전 목표만 바꿔요 — 게임 확률·배당은 그대로입니다` });
    return i.reply({ embeds: [embed] });
  },
};
