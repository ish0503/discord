/** /프로필 — 전역 프로필(칭호·업적·포인트·꾸미기) + 이 서버 지갑·게임별 전적 */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const wallet = require('../services/wallet');
const profile = require('../services/profile');
const stats = require('../services/stats');
const events = require('../services/events');
const registry = require('../games/registry');
const achievements = require('../content/achievements');
const cosmetics = require('../content/cosmetics');
const { COLOR, chips, num, netText } = require('../utils/format');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('프로필')
    .setDescription('프로필·칭호·업적·게임별 전적')
    .addUserOption((o) => o.setName('유저').setDescription('다른 사람 프로필 보기')),

  async execute(i) {
    const user = i.options.getUser('유저') ?? i.user;
    await i.deferReply();
    const [p, acc, summary, active] = await Promise.all([profile.get(user.id), wallet.getAccount(user.id, i.guildId), stats.userSummary(user.id, i.guildId), events.active(i.guildId)]);
    const eq = { ...cosmetics.DEFAULTS, ...p.equipped };
    const title = eq.title ? `「${eq.title}」 ` : '';
    const total = p.totals || {};
    const achCount = p.achievements?.length ?? 0;
    const recent = (p.achievements || []).slice(-3).reverse().map((a) => achievements.byId[a.id]).filter(Boolean);
    const gameLines = summary.length
      ? summary.map((g) => `${registry.label(g._id)} ${num(g.rounds)}판 · 승률 ${((g.wins / g.rounds) * 100).toFixed(0)}% · RTP ${((g.payout / Math.max(1, g.staked)) * 100).toFixed(1)}% · ${netText(g.net)}`).join('\n')
      : '_아직 기록 없음_';

    const embed = new EmbedBuilder()
      .setColor(cosmetics.color(eq.color, COLOR.gold))
      .setTitle(cosmetics.framed(`${title}${user.displayName ?? user.username}`, eq.frame))
      .setThumbnail(user.displayAvatarURL?.() ?? null)
      .setDescription(
        [
          `💼 잔고 **${chips(acc.money)}** · ⭐ 보상 포인트 **${num(p.rewardPoints)}P**`,
          `🎮 총 ${num(total.games ?? 0)}판 · 승 ${num(total.wins ?? 0)} · 누적 베팅 ${chips(total.wagered ?? 0)}`,
          `🔥 현재 ${p.winStreak}연승 · 최대 ${p.maxWinStreak}연승 · 💥 한 판 최대 순이익 ${chips(acc.stats?.biggestWin ?? 0)}`,
          `🏆 업적 **${achCount}/${achievements.ACHIEVEMENTS.length}** · 🏷️ 칭호 ${p.titles.length}개`,
          recent.length ? `최근 업적: ${recent.map((a) => `${achievements.RARITY[a.rarity]} ${a.name}`).join(' · ')}` : '',
          active.length ? `🎉 진행 중 이벤트: ${active.map((e) => `${e.name} (포인트 ×${e.multiplier})`).join(', ')}` : '',
          '',
          '**게임별 전적 (이 서버)**',
          gameLines,
        ]
          .filter((x) => x !== '')
          .join('\n'),
      )
      .setFooter({ text: '/업적 으로 전체 업적 · /인벤토리 로 칭호·꾸미기 장착' });
    await i.editReply({ embeds: [embed] });
  },
};
