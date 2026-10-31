/** /분석 — 최근 100판 개인 기록 분석 (과거 기록일 뿐, 미래 승률 예측이 아님) */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const stats = require('../services/stats');
const registry = require('../games/registry');
const analytics = require('../content/analytics');
const { COLOR, num, chips, netText } = require('../utils/format');

module.exports = {
  data: new SlashCommandBuilder().setName('분석').setDescription('최근 100판 내 플레이 분석'),
  async execute(i) {
    await i.deferReply({ ephemeral: true });
    const logs = await stats.recentForAnalysis(i.user.id, i.guildId, 100);
    const r = analytics.personal(logs);
    if (!r.rounds) return i.editReply('분석할 기록이 아직 없어요.');
    const share = Object.entries(r.byGame)
      .sort((a, b) => b[1].rounds - a[1].rounds)
      .map(([g, v]) => `${registry.label(g)} ${((v.rounds / r.rounds) * 100).toFixed(0)}% · ${num(v.rounds)}판 · RTP ${((v.payout / Math.max(1, v.staked)) * 100).toFixed(1)}%`);
    const embed = new EmbedBuilder()
      .setColor(r.net >= 0 ? COLOR.win : COLOR.lose)
      .setTitle(`📊 최근 ${r.rounds}판 분석`)
      .setDescription(
        [
          `순손익 **${netText(r.net)}** · 내 실제 RTP **${(r.rtp * 100).toFixed(1)}%** · 평균 베팅 ${chips(r.avgBet)}`,
          `📉 최대 손실 구간 ${chips(r.maxDrawdown)} · 📈 최고 수익 구간 ${chips(r.bestRun)}`,
          '',
          '**누적 손익 흐름**',
          `\`${analytics.sparkline(r.curve)}\``,
          '',
          '**게임별 비중**',
          ...share,
        ].join('\n'),
      )
      .setFooter({ text: '과거 기록을 보여줄 뿐이에요. 독립적인 확률 게임에서 지난 결과는 다음 판 승률을 바꾸지 않습니다.' });
    await i.editReply({ embeds: [embed] });
  },
};
