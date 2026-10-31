/** /출석 — 하루 1회 칩 + 보상 포인트, 연속 출석 보너스 (날짜 기준: KST) */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('../config');
const wallet = require('../services/wallet');
const profile = require('../services/profile');
const events = require('../services/events');
const time = require('../content/time');
const { COLOR, chips, num } = require('../utils/format');

module.exports = {
  data: new SlashCommandBuilder().setName('출석').setDescription('하루 한 번 출석 보상 받기'),
  async execute(i) {
    await i.deferReply();
    const k = time.keys();
    const r = await wallet.claimDaily(i.user.id, i.guildId, k.day, k.yesterday);
    if (!r.ok) return i.editReply('✅ 오늘은 이미 출석했어요. 내일 다시 와 주세요! (자정 KST 초기화)');
    const mult = await events.pointsMultiplier(i.guildId);
    const points = Math.floor(config.DAILY.POINTS * mult);
    await profile.addPoints(i.user.id, points);
    await profile.checkTrigger(i.user.id, i.guildId, 'daily', { dailyStreak: r.streak }, i.channelId);
    const embed = new EmbedBuilder()
      .setColor(COLOR.win)
      .setTitle(`📅 출석 완료 · ${r.streak}일 연속`)
      .setDescription(`🪙 **+${num(r.amount)}칩** · ⭐ **+${num(points)}P**${mult > 1 ? ` (이벤트 ×${mult})` : ''}\n💼 잔고 ${chips(r.balance)}\n\n연속 출석 1일당 +${num(config.DAILY.STREAK_BONUS)}칩 (최대 +${num(config.DAILY.MAX_STREAK_BONUS)})`);
    return i.editReply({ embeds: [embed] });
  },
};
