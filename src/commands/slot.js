const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const sessions = require('../services/sessions');
const wallet = require('../services/wallet');
const slot = require('../engine/slot');
const { COLOR, chips, num, netText, netColor, sleep, ephemeral, expired, busyText } = require('../utils/format');

const SL = config.SLOT;
const PREFIX = 'sl';
const cid = (uid, action) => `${PREFIX}:${uid}:${action}:`;
const BLANK = '🎰';

const paytableText = () =>
  Object.entries(SL.PAYTABLE.triple)
    .reverse()
    .map(([e, m]) => `${e}${e}${e} ×${m}`)
    .join(' · ') + ` · 🍒🍒 ×${SL.PAYTABLE.twoCherry}`;

function row(s, { disabled = false } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(cid(s.userId, 'spin'))
      .setLabel(`스핀 (${num(s.bet)})`)
      .setEmoji('🎰')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled || s.balance < s.bet),
    new ButtonBuilder().setCustomId(cid(s.userId, 'stop')).setLabel('그만').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
}

function payload(s, reels, { result = null, spinning = false, ended = false } = {}) {
  const embed = new EmbedBuilder()
    .setColor(result ? netColor(result.net) : COLOR.gold)
    .setTitle('🎰 슬롯머신')
    .setDescription(
      [
        `**[ ${reels.join(' | ')} ]**`,
        '',
        result ? `**${result.label}** — 순손익 **${netText(result.net)}**` : spinning ? '릴이 돌아갑니다...' : '버튼을 눌러 스핀!',
        `💼 잔고 ${chips(s.balance)} · 베팅 ${chips(s.bet)}`,
      ]
        .filter((x) => x !== '')
        .join('\n'),
    )
    .setFooter({ text: paytableText() });
  return { embeds: [embed], components: [row(s, { disabled: spinning || ended })] };
}

async function spin(i, s) {
  // 1) 베팅 즉시 칩을 에스크로로 이동 (잔고 부족이면 DB 조건에서 거절)
  const r = await wallet.reserve(s.userId, s.guildId, 'slot', s.bet);
  if (!r) return i.followUp(ephemeral('잔고가 부족해요. `/잔고`로 확인해 보세요.'));
  s.balance = r.balance;

  // 2) 결과 선 연산
  const reels = slot.spin(SL.SYMBOLS);
  const { multiplier, label } = slot.evaluate(reels, SL.PAYTABLE);
  const payout = Math.floor(s.bet * multiplier);

  // 3) 0.4초 간격으로 한 칸씩 공개
  const frame = [BLANK, BLANK, BLANK];
  await i.editReply(payload(s, frame, { spinning: true }));
  for (let k = 0; k < 3; k++) {
    await sleep(SL.REEL_DELAY_MS);
    frame[k] = reels[k];
    if (k < 2) await i.editReply(payload(s, frame, { spinning: true }));
  }

  // 4) 정산 (같은 roundId는 한 번만 반영)
  const st = await wallet.settleRound(s.userId, r.roundId, payout, {
    game: 'slot',
    guildId: s.guildId,
    inc: { slotSpins: 1 },
    max: { slotBestWin: payout },
    wagered: s.bet,
    detail: { reels, multiplier },
  });
  if (st.ok) s.balance = st.balance;
  const net = payout - s.bet;
  await i.editReply(payload(s, reels, { result: { net, label: multiplier >= 50 ? `🎉 JACKPOT! ${label}` : label } }));
}

module.exports = {
  prefix: PREFIX,
  data: new SlashCommandBuilder()
    .setName('슬롯')
    .setDescription('가중치 기반 3릴 슬롯머신')
    .addIntegerOption((o) =>
      o.setName('금액').setDescription('1회 스핀 금액').setRequired(true).setMinValue(config.MIN_BET).setMaxValue(config.MAX_BET),
    ),

  async execute(i) {
    const bet = i.options.getInteger('금액', true);
    const s = sessions.start(i.user.id, 'slot', { guildId: i.guildId, bet }, {
      onTimeout: async (x) => {
        sessions.end(x);
        await x.ui.editReply(payload(x, [BLANK, BLANK, BLANK], { ended: true })).catch(() => {});
      },
    });
    if (!s) return i.reply(ephemeral(busyText));
    s.ui = i;
    await i.deferReply();
    const account = await wallet.getAccount(i.user.id, i.guildId);
    s.balance = account.money;
    if (s.balance < bet) {
      sessions.end(s);
      return i.editReply(`잔고가 부족해요. (현재 ${chips(s.balance)})`);
    }
    await i.editReply(payload(s, [BLANK, BLANK, BLANK]));
  },

  async handleButton(i, { action }) {
    const s = sessions.get(i.user.id);
    if (!s || s.game !== 'slot') return expired(i);
    await i.deferUpdate();
    s.ui = i;
    await sessions.run(s, async () => {
      if (action === 'spin') return spin(i, s);
      if (action === 'stop') {
        sessions.end(s);
        return i.editReply(payload(s, ['👋', '👋', '👋'], { ended: true }));
      }
    });
  },
};
