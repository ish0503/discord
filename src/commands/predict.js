/** /예측 — 토너먼트 우승자 예측 (관전자). 제출은 토너먼트 스레드의 예측 메뉴에서. */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('../config');
const prediction = require('../services/prediction');
const { COLOR, num } = require('../utils/format');

const STATUS = { open: '⏳ 진행 중', won: '✅ 적중', lost: '❌ 빗나감', refunded: '↩️ 환불' };

module.exports = {
  data: new SlashCommandBuilder()
    .setName('예측')
    .setDescription('토너먼트 우승자 예측 — 관전자끼리 겨루는 예측 점수')
    .addSubcommand((s) => s.setName('목록').setDescription('지금 예측을 받는 토너먼트'))
    .addSubcommand((s) => s.setName('결과').setDescription('내 최근 예측 결과'))
    .addSubcommand((s) => s.setName('순위').setDescription('예측 점수 순위')),

  async execute(i) {
    const sub = i.options.getSubcommand();
    if (sub === '목록') {
      const list = prediction.openList(i.guildId);
      const embed = new EmbedBuilder()
        .setColor(COLOR.info)
        .setTitle('🔮 예측 접수 중인 토너먼트')
        .setDescription(
          list.map((w) => `- 참가자 ${w.entrants.map((e) => e.name).join(', ')} · ⏰ <t:${Math.floor(w.lockAt / 1000)}:R> 마감`).join('\n') ||
            '_지금은 없어요. 토너먼트가 시작되면 스레드에 예측 메뉴가 올라와요 (첫 핸드 전까지)._',
        )
        .setFooter({ text: `걸 수 있는 칩: ${config.PREDICTION.STAKES.map((s) => (s ? num(s) : '점수만')).join(' · ')} · 관전자끼리 나눔(하우스 몫 0) · 적중자 없으면 환불` });
      return i.reply({ embeds: [embed], ephemeral: true });
    }
    if (sub === '결과') {
      const list = await prediction.history(i.guildId, i.user.id);
      const embed = new EmbedBuilder()
        .setColor(COLOR.info)
        .setTitle('🔮 내 예측 결과')
        .setDescription(list.map((p) => `${STATUS[p.status] ?? p.status} ${p.predictedName} 우승 예측${p.stake ? ` · ${num(p.stake)}칩 → ${num(p.payout)}` : ''}${p.score ? ` · +${p.score}점` : ''} · <t:${Math.floor(new Date(p.submittedAt).getTime() / 1000)}:R>`).join('\n') || '_아직 예측 기록이 없어요_');
      return i.reply({ embeds: [embed], ephemeral: true });
    }
    const top = await prediction.leaderboard(i.guildId);
    const embed = new EmbedBuilder()
      .setColor(COLOR.gold)
      .setTitle('🔮 예측 점수 순위')
      .setDescription(top.map((d, k) => `${['🥇', '🥈', '🥉'][k] ?? `\`${k + 1}\``} <@${d.userId}> **${num(d.predict.score)}점** · 적중 ${d.predict.correct}/${d.predict.total} · 최고 연속 ${d.predict.bestStreak}`).join('\n') || '_아직 없어요_');
    return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};
