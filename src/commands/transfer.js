/**
 * /송금 — 다른 유저에게 칩 보내기.
 *  - 확인 버튼을 눌러야 실제로 보내짐 (오타 방지) · 결과는 채널에 공개
 *  - 수수료(기본 5%)는 소각, 하루 한도(보낸 금액 + 수수료 기준)
 *  - 봇·자기 자신에게는 보낼 수 없음
 */
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const wallet = require('../services/wallet');
const time = require('../content/time');
const { COLOR, chips, num, ephemeral } = require('../utils/format');

const TF = config.TRANSFER;
const PREFIX = 'tf';
const feeOf = (amount) => Math.ceil(amount * TF.FEE_RATE);
const pending = new Map(); // 확인 대기 중인 송금 (메모 보관)

async function check(fromId, toId, guildId, amount) {
  const fee = feeOf(amount);
  const [acc, sent] = await Promise.all([wallet.getAccount(fromId, guildId), wallet.transferredToday(fromId, guildId, time.dayKey, time.dayKey())]);
  const left = TF.DAILY_LIMIT - sent;
  if (amount + fee > left) return { reason: `오늘 남은 송금 한도는 ${chips(Math.max(0, left))} (수수료 포함)예요. (하루 ${chips(TF.DAILY_LIMIT)}, KST 자정 초기화)` };
  if (acc.money < amount + fee) return { reason: `잔고가 부족해요. 필요 ${chips(amount + fee)} (수수료 ${num(fee)} 포함) · 현재 ${chips(acc.money)}` };
  return { fee, left, balance: acc.money };
}

module.exports = {
  prefix: PREFIX,
  data: new SlashCommandBuilder()
    .setName('송금')
    .setDescription(`다른 유저에게 칩 보내기 (수수료 ${TF.FEE_RATE * 100}%, 하루 한도 ${TF.DAILY_LIMIT.toLocaleString('en-US')})`)
    .addUserOption((o) => o.setName('유저').setDescription('받는 사람').setRequired(true))
    .addIntegerOption((o) => o.setName('금액').setDescription('보낼 금액 (수수료 별도)').setRequired(true).setMinValue(TF.MIN).setMaxValue(TF.DAILY_LIMIT))
    .addStringOption((o) => o.setName('메모').setDescription('함께 보낼 메모').setMaxLength(80)),

  async execute(i) {
    const to = i.options.getUser('유저', true);
    const amount = i.options.getInteger('금액', true);
    const memo = (i.options.getString('메모') ?? '').trim();
    if (to.id === i.user.id) return i.reply(ephemeral('자기 자신에게는 보낼 수 없어요.'));
    if (to.bot) return i.reply(ephemeral('봇에게는 보낼 수 없어요.'));
    const c = await check(i.user.id, to.id, i.guildId, amount);
    if (c.reason) return i.reply(ephemeral(`❌ ${c.reason}`));
    const key = `${i.id}`;
    pending.set(key, { toId: to.id, amount, memo, at: Date.now() });
    setTimeout(() => pending.delete(key), 5 * 60_000).unref?.();
    const embed = new EmbedBuilder()
      .setColor(COLOR.info)
      .setTitle('💸 송금 확인')
      .setDescription(
        [
          `받는 사람: <@${to.id}>`,
          `보낼 금액: **${chips(amount)}** · 수수료 ${chips(c.fee)} (소각)`,
          `차감 합계: **${chips(amount + c.fee)}** · 송금 후 잔고 ${chips(c.balance - amount - c.fee)}`,
          memo ? `📝 ${memo}` : '',
          '',
          '아래 버튼으로 확정해 주세요. (5분 뒤 만료)',
        ]
          .filter((x) => x !== '')
          .join('\n'),
      );
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}:${i.user.id}:ok:${key}`).setLabel('보내기').setEmoji('💸').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${PREFIX}:${i.user.id}:no:${key}`).setLabel('취소').setStyle(ButtonStyle.Secondary),
    );
    return i.reply({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
  },

  async handleButton(i, { action, arg }) {
    const p = pending.get(arg);
    if (!p) return i.update({ content: '⌛ 만료되었거나 이미 처리된 송금이에요.', embeds: [], components: [] });
    pending.delete(arg);
    if (action === 'no') return i.update({ content: '✖️ 송금을 취소했어요.', embeds: [], components: [] });
    await i.deferUpdate();
    const c = await check(i.user.id, p.toId, i.guildId, p.amount);
    if (c.reason) return i.editReply({ content: `❌ ${c.reason}`, embeds: [], components: [] });
    const r = await wallet.transfer({ fromId: i.user.id, toId: p.toId, guildId: i.guildId, amount: p.amount, fee: c.fee, memo: p.memo });
    if (!r.ok) return i.editReply({ content: r.reason === 'balance' ? '❌ 잔고가 부족해요.' : '⚠️ 송금 중 오류가 발생해 환불했어요.', embeds: [], components: [] });
    const embed = new EmbedBuilder()
      .setColor(COLOR.win)
      .setTitle('💸 송금 완료')
      .setDescription([`<@${i.user.id}> → <@${p.toId}> **${chips(p.amount)}**`, p.memo ? `📝 ${p.memo}` : '', `수수료 ${chips(r.fee)} · 오늘 남은 한도 ${chips(c.left - p.amount - r.fee)}`].filter(Boolean).join('\n'));
    return i.editReply({ content: '', embeds: [embed], components: [], allowedMentions: { users: [p.toId] } });
  },
};
