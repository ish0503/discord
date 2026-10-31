/** /랭킹 — 잔고 · 시즌 · 누적 순수익 · 최대 당첨 · 승률 (게임별) */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const stats = require('../services/stats');
const seasons = require('../services/seasons');
const registry = require('../games/registry');
const config = require('../config');
const { COLOR, num, chips, netText } = require('../utils/format');

const TYPES = {
  season: '🏁 시즌 순수익',
  balance: '💼 잔고',
  profit: '📈 누적 순수익',
  biggest: '💥 한 판 최대 순이익',
  winrate: '🎯 승률 (20판 이상)',
};
const MEDAL = ['🥇', '🥈', '🥉'];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('랭킹')
    .setDescription('서버 랭킹')
    .addStringOption((o) => o.setName('종류').setDescription('랭킹 종류 (기본 시즌)').addChoices(...Object.entries(TYPES).map(([value, name]) => ({ name, value }))))
    .addStringOption((o) => o.setName('게임').setDescription('게임별 (순수익·승률·시즌)').addChoices(...registry.ids().map((id) => ({ name: registry.GAMES[id].label, value: id })))),

  async execute(i) {
    const type = i.options.getString('종류') ?? 'season';
    const game = i.options.getString('게임');
    await i.deferReply();
    const season = await seasons.current(i.guildId);
    const rows = await stats.leaderboard(i.guildId, type, { seasonStart: season.startedAt, game, limit: 10 });
    const fmt = (r) => (type === 'balance' ? chips(r.value) : type === 'winrate' ? `${(r.value * 100).toFixed(1)}% (${num(r.games)}판)` : type === 'biggest' ? chips(r.value) : `${netText(r.value)}${r.games ? ` · ${num(r.games)}판` : ''}`);
    const lines = rows.map((r, k) => `${MEDAL[k] ?? `\`${k + 1}.\``} <@${r.userId}> — ${fmt(r)}`);
    const seasonEnd = new Date(new Date(season.startedAt).getTime() + config.SEASON.DAYS * 86400_000);
    const embed = new EmbedBuilder()
      .setColor(COLOR.gold)
      .setTitle(`${TYPES[type]}${game ? ` · ${registry.label(game)}` : ''}`)
      .setDescription(lines.join('\n') || '_아직 기록이 없어요._')
      .setFooter({ text: type === 'season' ? `시즌 ${season.number} · 종료 예정 ${seasonEnd.toLocaleDateString('ko-KR')} · 상위 ${config.SEASON.TOP_TITLES}명 칭호 지급` : '잔고 랭킹은 신규 유저에게 불리할 수 있어 시즌 랭킹을 기본으로 보여줘요' });
    await i.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};
