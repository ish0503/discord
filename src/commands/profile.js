/**
 * /프로필 — 장착한 색상·테두리·카드 테마·주사위 스킨이 그대로 보이는 "프로필 이미지 카드"를 만들어 보낸다.
 * 캔버스를 쓸 수 없는 환경이면 기존 텍스트 임베드로 대체.
 */
const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const wallet = require('../services/wallet');
const profile = require('../services/profile');
const stats = require('../services/stats');
const events = require('../services/events');
const profileCard = require('../services/profileCard');
const progression = require('../services/progression');
const registry = require('../games/registry');
const achievements = require('../content/achievements');
const cosmetics = require('../content/cosmetics');
const User = require('../db/User');
const { COLOR, chips, num, netText } = require('../utils/format');

async function balanceRank(guildId, money) {
  try {
    return (await User.countDocuments({ guildId: wallet.economyKey(guildId), money: { $gt: money } })) + 1;
  } catch {
    return null;
  }
}

function textEmbed({ user, p, acc, summary, eq, extra }) {
  const title = eq.title ? `「${eq.title}」 ` : '';
  const total = p.totals || {};
  const gameLines = summary.length
    ? summary.map((g) => `${registry.label(g._id)} ${num(g.rounds)}판 · 승률 ${((g.wins / g.rounds) * 100).toFixed(0)}% · RTP ${((g.payout / Math.max(1, g.staked)) * 100).toFixed(1)}% · ${netText(g.net)}`).join('\n')
    : '_아직 기록 없음_';
  return new EmbedBuilder()
    .setColor(cosmetics.color(eq.color, COLOR.gold))
    .setTitle(cosmetics.framed(`${title}${user.displayName ?? user.username}`, eq.frame))
    .setThumbnail(user.displayAvatarURL?.() ?? null)
    .setDescription(
      [
        `💼 잔고 **${chips(acc.money)}** · ⭐ 보상 포인트 **${num(p.rewardPoints)}P**`,
        `🎮 총 ${num(total.games ?? 0)}판 · 승 ${num(total.wins ?? 0)} · 누적 베팅 ${chips(total.wagered ?? 0)}`,
        `🔥 현재 ${p.winStreak}연승 · 최대 ${p.maxWinStreak}연승 · 💥 한 판 최대 순이익 ${chips(acc.stats?.biggestWin ?? 0)}`,
        `🏆 업적 **${p.achievements?.length ?? 0}/${achievements.ACHIEVEMENTS.length}** · 🏷️ 칭호 ${p.titles.length}개`,
        ...extra,
        '',
        '**게임별 전적 (이 서버)**',
        gameLines,
      ].join('\n'),
    );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('프로필')
    .setDescription('프로필 카드 이미지 — 칭호·색상·테두리·카드 테마·전적')
    .addUserOption((o) => o.setName('유저').setDescription('다른 사람 프로필 보기')),

  async execute(i) {
    const user = i.options.getUser('유저') ?? i.user;
    await i.deferReply();
    const [p, acc, summary, active, extras] = await Promise.all([
      profile.get(user.id),
      wallet.getAccount(user.id, i.guildId),
      stats.userSummary(user.id, i.guildId),
      events.active(i.guildId),
      progression.summary(i.guildId, user.id).catch(() => null),
    ]);
    const eq = { ...cosmetics.DEFAULTS, ...p.equipped };
    const member = user.id === i.user.id ? i.member : null;
    const name = member?.displayName ?? user.globalName ?? user.displayName ?? user.username;
    const best = achievements.showcase(p.achievements, 3);
    const extra = [
      best.length ? `🏅 대표 업적: ${best.map((a) => `${achievements.RARITY[a.rarity]} **${achievements.display(a)}**`).join(' · ')}` : '',
      ...(extras?.lines ?? []),
      active.length ? `🎉 진행 중 이벤트: ${active.map((e) => `${e.name} (포인트 ×${e.multiplier})`).join(', ')}` : '',
    ].filter(Boolean);

    if (profileCard.available()) {
      try {
        const png = await profileCard.render({
          name,
          avatarURL: user.displayAvatarURL?.({ extension: 'png', size: 256 }) ?? null,
          equipped: eq,
          money: acc.money,
          rewardPoints: p.rewardPoints,
          totals: p.totals,
          winStreak: p.winStreak,
          maxWinStreak: p.maxWinStreak,
          biggestWin: acc.stats?.biggestWin ?? 0,
          achievementCount: p.achievements?.length ?? 0,
          achievements: p.achievements || [],
          games: summary,
          badges: extras?.badges ?? [],
          clanTag: extras?.clanTag ?? null,
          rank: await balanceRank(i.guildId, acc.money),
        });
        const file = new AttachmentBuilder(png, { name: 'profile.png' });
        const embed = new EmbedBuilder()
          .setColor(cosmetics.color(eq.color, COLOR.gold))
          .setImage('attachment://profile.png')
          .setFooter({ text: '/상점 에서 색상·테두리·카드 테마 구매 · /인벤토리 에서 장착 → 이 카드에 바로 반영' });
        if (extra.length) embed.setDescription(extra.join('\n'));
        return i.editReply({ embeds: [embed], files: [file] });
      } catch (err) {
        console.warn('[profile] 이미지 생성 실패 → 텍스트로 대체:', err.message);
      }
    }
    return i.editReply({ embeds: [textEmbed({ user, p, acc, summary, eq, extra })] });
  },
};
