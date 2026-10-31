const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const sessions = require('../services/sessions');
const wallet = require('../services/wallet');
const { getShoe } = require('../services/shoes');
const bj = require('../engine/blackjack');
const { COLOR, chips, num, signed, netText, netColor, handText, sleep, ephemeral, expired, busyText } = require('../utils/format');

const BJ = config.BLACKJACK;
const PREFIX = 'bj';
const cid = (uid, action, arg = '') => `${PREFIX}:${uid}:${action}:${arg}`;

/** 원시 데이터만 보여주는 계기판 — 유리/불리 판정은 하지 않는다 */
function meter(shoe) {
  return [
    '```ini',
    `[ Running Count: ${signed(shoe.runningCount)} ]  [ True Count: ${signed(shoe.trueCount, 1)} ]`,
    `[ 남은 카드: ${shoe.remaining} / ${shoe.total} ]  [ 남은 덱: ${shoe.decksRemaining.toFixed(2)} ]`,
    '```',
  ].join('\n');
}

function betRow(uid, balance) {
  return new ActionRowBuilder().addComponents(
    BJ.BET_OPTIONS.map((amt) =>
      new ButtonBuilder()
        .setCustomId(cid(uid, 'bet', amt))
        .setLabel(`${num(amt)} 베팅`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(balance < amt),
    ),
  );
}

function actionRow(s) {
  const canDouble = s.player.length === 2 && s.balance >= s.bet * 2;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid(s.userId, 'hit')).setLabel('히트').setEmoji('➕').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(cid(s.userId, 'stand')).setLabel('스탠드').setEmoji('✋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid(s.userId, 'double'))
      .setLabel('더블')
      .setEmoji('2️⃣')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!canDouble),
  );
}

function lobbyPayload(uid, shoe, balance, note = '') {
  const embed = new EmbedBuilder()
    .setColor(COLOR.table)
    .setTitle(`🃏 블랙잭 테이블 · 슈 #${shoe.shoeNumber}`)
    .setDescription(
      `${note}${BJ.DECKS}덱 슈 · 블랙잭 3:2 · 딜러 소프트17 ${BJ.DEALER_HITS_SOFT_17 ? '히트' : '스탠드'} · ` +
        `남은 카드 ${BJ.RESHUFFLE_AT}장 이하 시 재셔플\n\n📟 **계기판**\n${meter(shoe)}\n` +
        `💼 잔고: **${chips(balance)}**\n베팅 금액을 골라 딜을 시작하세요.`,
    );
  return { embeds: [embed], components: [betRow(uid, balance)] };
}

function tablePayload(s, { result = null, note = '' } = {}) {
  const hidden = s.holeHidden ? [1] : [];
  const dVal = s.holeHidden ? bj.handValue([s.dealer[0]]).total : bj.handValue(s.dealer).total;
  const pv = bj.handValue(s.player);
  const pText = `${pv.total}${pv.soft && pv.total < 21 ? ' (soft)' : ''}`;

  const embed = new EmbedBuilder()
    .setColor(result ? netColor(result.net) : COLOR.table)
    .setTitle(`🃏 블랙잭 · 베팅 ${chips(s.bet)}${s.doubled ? ' (더블)' : ''}`)
    .setDescription(
      [
        note,
        `**딜러** — ${handText(s.dealer, hidden)}  \`${dVal}${s.holeHidden ? '+?' : ''}\``,
        `**플레이어** — ${handText(s.player)}  \`${pText}\``,
        '',
        `📟 **계기판** (슈 #${s.shoe.shoeNumber})`,
        meter(s.shoe),
        result ? `**${result.label}**\n순손익 **${netText(result.net)}** · 잔고 **${chips(s.balanceAfter)}**` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

  const components = result ? [betRow(s.userId, s.balanceAfter)] : [actionRow(s)];
  return { embeds: [embed], components };
}

const edit = (s, payload) => s.ui.editReply(payload);

function revealHole(s) {
  if (!s.holeHidden) return;
  s.holeHidden = false;
  s.shoe.count(s.hole); // 홀카드는 공개되는 순간 카운트에 반영
}

async function finish(s, note = '') {
  revealHole(s);
  const result = bj.settle(s.player, s.dealer, s.bet, BJ.BLACKJACK_PAYS);
  const doc = await wallet.settle(s.userId, s.guildId, result.net, {
    inc: { blackjackHands: 1, ...(result.net > 0 ? { blackjackWins: 1 } : {}) },
    wagered: s.bet,
  });
  s.balanceAfter = doc?.money ?? s.balance + result.net;
  sessions.end(s);
  await edit(s, tablePayload(s, { result, note }));
}

async function dealerTurn(s, note = '') {
  revealHole(s);
  await edit(s, tablePayload(s, { note: note || '🔍 딜러 홀카드 공개' }));
  while (bj.dealerShouldHit(s.dealer, BJ.DEALER_HITS_SOFT_17)) {
    await sleep(BJ.DEALER_STEP_MS);
    s.dealer.push(s.shoe.draw());
    await edit(s, tablePayload(s, { note: '🂠 딜러 드로우...' }));
  }
  await sleep(BJ.DEALER_STEP_MS / 2);
  await finish(s, note);
}

async function startHand(i, s, amount) {
  const account = await wallet.getAccount(s.userId, s.guildId);
  if (account.money < amount) {
    sessions.end(s);
    return i.followUp(ephemeral(`잔고가 부족해요. (현재 ${chips(account.money)})`));
  }
  const shoe = getShoe('blackjack', i.channelId);
  const reshuffled = shoe.prepareRound();
  Object.assign(s, { shoe, bet: amount, balance: account.money, doubled: false, holeHidden: true });

  s.player = [shoe.draw()];
  s.dealer = [shoe.draw()];
  s.player.push(shoe.draw());
  s.hole = shoe.draw({ counted: false });
  s.dealer.push(s.hole);

  const note = reshuffled ? '🔄 **슈 재셔플!** 카운트가 초기화되었습니다.' : '';
  if (bj.isBlackjack(s.player) || bj.isBlackjack(s.dealer)) return finish(s, note);
  await edit(s, tablePayload(s, { note }));
}

module.exports = {
  prefix: PREFIX,
  data: new SlashCommandBuilder()
    .setName('블랙잭')
    .setDescription('6덱 슈 기반 카드 카운팅 블랙잭 — True Count를 직접 판독하세요'),

  async execute(i) {
    if (sessions.get(i.user.id)) return i.reply(ephemeral(busyText));
    await i.deferReply();
    const account = await wallet.getAccount(i.user.id, i.guildId);
    const shoe = getShoe('blackjack', i.channelId);
    await i.editReply(lobbyPayload(i.user.id, shoe, account.money));
  },

  async handleButton(i, { action, arg }) {
    const uid = i.user.id;

    if (action === 'bet') {
      const amount = Number(arg);
      const s = sessions.start(uid, 'blackjack', { guildId: i.guildId, ui: i }, { onTimeout: (x) => dealerTurn(x, '⏱️ 시간 초과 — 자동 스탠드') });
      if (!s) return i.reply(ephemeral(busyText));
      await i.deferUpdate();
      return sessions.run(s, () => startHand(i, s, amount));
    }

    const s = sessions.get(uid);
    if (!s || s.game !== 'blackjack') return expired(i);
    await i.deferUpdate();
    if (!s.player) return; // 딜링 중 연타
    s.ui = i; // 가장 최근 인터랙션 토큰으로 편집

    await sessions.run(s, async () => {
      if (action === 'hit') {
        s.player.push(s.shoe.draw());
        const { total } = bj.handValue(s.player);
        if (total > 21) return finish(s);
        if (total === 21) return dealerTurn(s);
        return edit(s, tablePayload(s));
      }
      if (action === 'stand') return dealerTurn(s);
      if (action === 'double') {
        if (s.player.length !== 2 || s.balance < s.bet * 2) return;
        s.bet *= 2;
        s.doubled = true;
        s.player.push(s.shoe.draw());
        if (bj.handValue(s.player).total > 21) return finish(s);
        return dealerTurn(s);
      }
    });
  },
};
