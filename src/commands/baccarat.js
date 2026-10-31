const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const sessions = require('../services/sessions');
const wallet = require('../services/wallet');
const { getShoe } = require('../services/shoes');
const bac = require('../engine/baccarat');
const { COLOR, chips, num, netText, netColor, handText, sleep, ephemeral, expired, busyText } = require('../utils/format');

const BC = config.BACCARAT;
const PREFIX = 'bc';
const cid = (uid, action) => `${PREFIX}:${uid}:${action}:`;
const DOT = { player: '🔵', banker: '🔴', tie: '🟢' };
const NAME = { player: '플레이어', banker: '뱅커', tie: '타이' };

/** 흐름 보드: 이번 슈의 최근 결과 + 집계 (해석은 유저 몫) */
function board(shoe) {
  const h = shoe.history;
  if (!h.length) return `📋 **흐름 보드** (슈 #${shoe.shoeNumber})\n_아직 기록 없음 — 새 슈입니다_`;
  const recent = h.slice(-BC.HISTORY_SIZE).map((w) => DOT[w]).join(' - ');
  let streak = 1;
  for (let k = h.length - 2; k >= 0 && h[k] === h.at(-1); k--) streak++;
  const cnt = { player: 0, banker: 0, tie: 0 };
  h.forEach((w) => cnt[w]++);
  return [
    `📋 **흐름 보드** (슈 #${shoe.shoeNumber} · ${h.length}판째)`,
    `최근 ${Math.min(BC.HISTORY_SIZE, h.length)}판: ${recent}  ← 최신`,
    `현재 줄: ${DOT[h.at(-1)]} ${streak}연속 · 누적 🔵${cnt.player} 🔴${cnt.banker} 🟢${cnt.tie} · 남은 카드 ${shoe.remaining}장`,
  ].join('\n');
}

function rows(s, { disabled = false } = {}) {
  const off = disabled || s.balance < s.bet;
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(cid(s.userId, 'player')).setLabel(`플레이어 ×${BC.PAYOUT.player}`).setEmoji('🔵').setStyle(ButtonStyle.Primary).setDisabled(off),
      new ButtonBuilder().setCustomId(cid(s.userId, 'banker')).setLabel(`뱅커 ×${BC.PAYOUT.banker}`).setEmoji('🔴').setStyle(ButtonStyle.Danger).setDisabled(off),
      new ButtonBuilder().setCustomId(cid(s.userId, 'tie')).setLabel(`타이 ×${BC.PAYOUT.tie}`).setEmoji('🟢').setStyle(ButtonStyle.Success).setDisabled(off),
      new ButtonBuilder().setCustomId(cid(s.userId, 'stop')).setLabel('그만').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    ),
  ];
}

function payload(s, { table = '', line = '어느 쪽에 거시겠습니까?', color = COLOR.table, disabled = false } = {}) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`🎴 바카라 · 베팅 ${chips(s.bet)}`)
    .setDescription([board(s.shoe), '', table, line, '', `💼 잔고 ${chips(s.balance)}`].filter((x, k, a) => x !== '' || a[k - 1] !== '').join('\n'))
    .setFooter({ text: `${BC.DECKS}덱 슈 · 타이 시 플레이어/뱅커 베팅은 푸시 · 뱅커 승 5% 커미션` });
  return { embeds: [embed], components: rows(s, { disabled }) };
}

function tableText(player, banker) {
  const pt = player.length ? bac.total(player) : '-';
  const bt = banker.length ? bac.total(banker) : '-';
  return `🔵 **플레이어** ${handText(player) || '…'}  \`${pt}\`\n🔴 **뱅커** ${handText(banker) || '…'}  \`${bt}\``;
}

async function deal(i, s, side) {
  if (s.balance < s.bet) return i.followUp(ephemeral(`잔고가 부족해요. (현재 ${chips(s.balance)})`));

  const reshuffled = s.shoe.prepareRound();
  const round = bac.playRound(() => s.shoe.draw()); // 결과 선 연산

  // 카드 한 장씩 공개 연출
  const shownP = [];
  const shownB = [];
  const intro = `${reshuffled ? '🔄 새 슈로 교체! ' : ''}${DOT[side]} **${NAME[side]}**에 베팅`;
  for (const { side: who, card } of round.order) {
    (who === 'player' ? shownP : shownB).push(card);
    await i.editReply(payload(s, { table: tableText(shownP, shownB), line: intro, disabled: true }));
    await sleep(BC.DEAL_MS);
  }

  s.shoe.history.push(round.winner);
  const { net, push } = bac.settle(side, round.winner, s.bet, BC.PAYOUT);
  const doc = await wallet.settle(s.userId, s.guildId, net, {
    inc: { baccaratRounds: 1, ...(net > 0 ? { baccaratWins: 1 } : {}) },
    wagered: s.bet,
  });
  s.balance = doc?.money ?? s.balance + net;

  const headline = `${DOT[round.winner]} **${NAME[round.winner]} 승**${round.natural ? ' (내추럴)' : ''}`;
  const verdict = push ? '🤝 타이 — 베팅 반환' : net > 0 ? '🎉 적중!' : '😵 실패';
  await i.editReply(
    payload(s, {
      table: tableText(round.player, round.banker),
      line: `${headline}\n${verdict} 순손익 **${netText(net)}**`,
      color: netColor(net),
    }),
  );
}

module.exports = {
  prefix: PREFIX,
  data: new SlashCommandBuilder()
    .setName('바카라')
    .setDescription('8덱 슈 바카라 — 흐름 보드를 직접 판독하고 베팅하세요')
    .addIntegerOption((o) =>
      o.setName('금액').setDescription('1회 베팅 금액').setRequired(true).setMinValue(config.MIN_BET).setMaxValue(config.MAX_BET),
    ),

  async execute(i) {
    const bet = i.options.getInteger('금액', true);
    const s = sessions.start(i.user.id, 'baccarat', { guildId: i.guildId, bet }, {
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
    s.shoe = getShoe('baccarat', i.channelId);
    if (s.balance < bet) {
      sessions.end(s);
      return i.editReply(`잔고가 부족해요. (현재 ${chips(s.balance)})`);
    }
    await i.editReply(payload(s));
  },

  async handleButton(i, { action }) {
    const s = sessions.get(i.user.id);
    if (!s || s.game !== 'baccarat') return expired(i);
    await i.deferUpdate();
    s.ui = i;
    await sessions.run(s, async () => {
      if (action === 'stop') {
        sessions.end(s);
        return i.editReply(payload(s, { line: `👋 종료 — 최종 잔고 ${chips(s.balance)}`, disabled: true }));
      }
      if (['player', 'banker', 'tie'].includes(action)) return deal(i, s, action);
    });
  },
};
