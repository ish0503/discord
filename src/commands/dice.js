const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const sessions = require('../services/sessions');
const wallet = require('../services/wallet');
const dice = require('../engine/dice');
const { randomInt } = require('../utils/rng');
const { COLOR, chips, num, netText, netColor, sleep, ephemeral, expired, busyText } = require('../utils/format');

const DC = config.DICE;
const PREFIX = 'dc';
const FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const cid = (uid, action) => `${PREFIX}:${uid}:${action}:`;

const assistActive = (streak) => DC.ASSIST.ENABLED && streak >= DC.ASSIST.STREAK;
/** 보정 중 실제 승률 = p + (1 − p) · c · p */
const assistedProb = (p) => p + (1 - p) * DC.ASSIST.REROLL_CHANCE * p;

function oddsText(streak) {
  const on = assistActive(streak) && DC.ASSIST.SHOW_TO_USER;
  const lines = dice.CHOICES.map((c) => {
    const p = dice.PROBABILITY[c];
    const adj = on ? ` → 보정 ${(assistedProb(p) * 100).toFixed(1)}%` : '';
    return `${dice.CHOICE_LABEL[c]} ${(p * 100).toFixed(1)}%${adj} · ×${DC.PAYOUT[c]}`;
  });
  if (on) lines.push(`🍀 연패 보정 활성 (${streak}연패): 지면 ${DC.ASSIST.REROLL_CHANCE * 100}% 확률로 1회 재굴림`);
  return lines.join('\n');
}

function rows(s, { disabled = false } = {}) {
  const off = disabled || s.balance < s.bet;
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(cid(s.userId, 'lo')).setLabel('Lo (2~6)').setEmoji('🔽').setStyle(ButtonStyle.Primary).setDisabled(off),
      new ButtonBuilder().setCustomId(cid(s.userId, 'seven')).setLabel('7').setEmoji('🎯').setStyle(ButtonStyle.Danger).setDisabled(off),
      new ButtonBuilder().setCustomId(cid(s.userId, 'hi')).setLabel('Hi (8~12)').setEmoji('🔼').setStyle(ButtonStyle.Primary).setDisabled(off),
      new ButtonBuilder().setCustomId(cid(s.userId, 'stop')).setLabel('그만').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    ),
  ];
}

function payload(s, { faces = ['🎲', '🎲'], line = '방향을 고르세요!', color = COLOR.info, disabled = false } = {}) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`🎲 주사위 Hi-Lo-7 · 베팅 ${chips(s.bet)}`)
    .setDescription(`**[ ${faces.join('  ')} ]**\n${line}\n\n\`\`\`\n${oddsText(s.streak)}\n\`\`\`💼 잔고 ${chips(s.balance)}`);
  return { embeds: [embed], components: rows(s, { disabled }) };
}

async function roll(i, s, choice) {
  const r = await wallet.reserve(s.userId, s.guildId, 'dice', s.bet);
  if (!r) return i.followUp(ephemeral('잔고가 부족해요. `/잔고`로 확인해 보세요.'));
  s.balance = r.balance;

  const res = dice.play(choice, { lossStreak: s.streak, assist: DC.ASSIST });

  // 굴리는 연출 (결과는 이미 결정됨)
  for (let f = 0; f < DC.ROLL_FRAMES; f++) {
    const fake = [FACES[randomInt(0, 6)], FACES[randomInt(0, 6)]];
    await i.editReply(payload(s, { faces: fake, line: `${dice.CHOICE_LABEL[choice]} 선택 — 굴리는 중...`, disabled: true }));
    await sleep(DC.FRAME_MS);
  }

  const payout = res.win ? Math.floor(s.bet * DC.PAYOUT[choice]) : 0;
  const net = payout - s.bet;
  const streak = res.win ? 0 : s.streak + 1;
  const st = await wallet.settleRound(s.userId, r.roundId, payout, {
    game: 'dice',
    guildId: s.guildId,
    inc: { diceRolls: 1, ...(res.win ? { diceWins: 1 } : {}) },
    set: { diceLossStreak: streak }, // 연패 기록도 DB에 → 재시작해도 유지
    wagered: s.bet,
    detail: { choice, dice: res.dice, assisted: res.assisted, streakBefore: s.streak },
  });
  if (st.ok) {
    s.balance = st.balance;
    s.streak = streak;
  }

  const faces = res.dice.map((d) => FACES[d - 1]);
  const assistNote = res.assisted && DC.ASSIST.SHOW_TO_USER ? '\n🍀 연패 보정으로 재굴림된 결과입니다.' : '';
  const line = `합계 **${res.sum}** → ${dice.CHOICE_LABEL[res.result]}\n${res.win ? '🎉 적중!' : '😵 실패'} 순손익 **${netText(net)}**${assistNote}`;
  await i.editReply(payload(s, { faces, line, color: res.win ? COLOR.win : COLOR.lose }));
}

module.exports = {
  prefix: PREFIX,
  data: new SlashCommandBuilder()
    .setName('주사위')
    .setDescription('두 주사위 합이 7보다 높을지(Hi)·낮을지(Lo)·정확히 7일지 맞히세요')
    .addIntegerOption((o) =>
      o.setName('금액').setDescription('1회 베팅 금액').setRequired(true).setMinValue(config.MIN_BET).setMaxValue(config.MAX_BET),
    ),

  async execute(i) {
    const bet = i.options.getInteger('금액', true);
    const s = sessions.start(i.user.id, 'dice', { guildId: i.guildId, bet }, {
      onTimeout: async (x) => {
        sessions.end(x);
        await x.ui.editReply(payload(x, { line: '⏱️ 테이블을 떠났습니다.', disabled: true })).catch(() => {});
      },
    });
    if (!s) return i.reply(ephemeral(busyText));
    s.ui = i;
    await i.deferReply();
    const account = await wallet.getAccount(i.user.id, i.guildId);
    s.balance = account.money;
    s.streak = account.diceLossStreak ?? 0;
    if (s.balance < bet) {
      sessions.end(s);
      return i.editReply(`잔고가 부족해요. (현재 ${chips(s.balance)})`);
    }
    await i.editReply(payload(s));
  },

  async handleButton(i, { action }) {
    const s = sessions.get(i.user.id);
    if (!s || s.game !== 'dice') return expired(i);
    await i.deferUpdate();
    s.ui = i;
    await sessions.run(s, async () => {
      if (action === 'stop') {
        sessions.end(s);
        return i.editReply(payload(s, { line: `👋 종료 — 최종 잔고 ${chips(s.balance)}`, disabled: true }));
      }
      if (dice.CHOICES.includes(action)) return roll(i, s, action);
    });
  },
};
