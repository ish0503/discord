const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const wallet = require('../services/wallet');
const { COLOR, chips, num, ephemeral } = require('../utils/format');

const PREFIX = 'bal';
const B = config.BAILOUT;

function payload(user, doc) {
  const st = doc.stats || {};
  const rate = (w, n) => (n ? `${((w / n) * 100).toFixed(1)}%` : '-');
  const embed = new EmbedBuilder()
    .setColor(COLOR.gold)
    .setTitle(`💼 ${user.displayName ?? user.username}님의 지갑`)
    .setDescription(
      `잔고 **${chips(doc.money)}**` +
        (doc.escrow?.length
          ? `\n🔒 진행 중인 게임에 묶인 칩 **${chips(doc.escrow.reduce((sum, e) => sum + e.amount, 0))}** (${doc.escrow.length}판 — 끝나면 정산, 장애 시 자동 환불)`
          : ''),
    )
    .addFields(
      { name: '🃏 블랙잭', value: `${num(st.blackjackWins ?? 0)}승 / ${num(st.blackjackHands ?? 0)}판 (${rate(st.blackjackWins, st.blackjackHands)})`, inline: true },
      { name: '🎰 슬롯', value: `${num(st.slotSpins ?? 0)}회 · 최고 ${num(st.slotBestWin ?? 0)}`, inline: true },
      { name: '📈 그래프', value: `${num(st.crashRounds ?? 0)}판 · 최고 ${(st.crashMaxMultiplier ?? 0).toFixed(2)}x`, inline: true },
      { name: '🎲 주사위', value: `${num(st.diceWins ?? 0)}승 / ${num(st.diceRolls ?? 0)}회`, inline: true },
      { name: '🎭 포커페이스', value: `${num(st.pokerWins ?? 0)}승 / ${num(st.pokerHands ?? 0)}판`, inline: true },
      { name: '🎴 바카라', value: `${num(st.baccaratWins ?? 0)}승 / ${num(st.baccaratRounds ?? 0)}판`, inline: true },
    )
    .setFooter({ text: `총 베팅액 ${num(st.totalWagered ?? 0)} · 최종 갱신 ${doc.updatedAt ? new Date(doc.updatedAt).toLocaleString('ko-KR') : '-'}` });

  const components = [];
  if (doc.money < B.THRESHOLD) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${PREFIX}:${user.id}:bailout:`)
          .setLabel(`긴급 지원금 ${num(B.AMOUNT)} 받기`)
          .setEmoji('🆘')
          .setStyle(ButtonStyle.Success),
      ),
    );
  }
  return { embeds: [embed], components };
}

module.exports = {
  prefix: PREFIX,
  data: new SlashCommandBuilder().setName('잔고').setDescription('내 가상 칩 잔고와 전적을 확인합니다'),

  async execute(i) {
    await i.deferReply();
    const doc = await wallet.getAccount(i.user.id, i.guildId);
    await i.editReply(payload(i.user, doc));
  },

  async handleButton(i, { action }) {
    if (action !== 'bailout') return;
    await i.deferUpdate();
    const doc = await wallet.claimBailout(i.user.id, i.guildId);
    if (!doc) {
      return i.followUp(ephemeral(`지원금은 잔고 ${num(B.THRESHOLD)} 미만일 때, 24시간에 한 번만 받을 수 있어요.`));
    }
    await i.editReply(payload(i.user, doc));
    await i.followUp(ephemeral(`🆘 ${chips(B.AMOUNT)} 지급 완료!`));
  },
};
