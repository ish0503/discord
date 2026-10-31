/**
 * /블랙잭 — 채널 공유 슈를 여러 명이 함께 쓰는 블랙잭 테이블.
 * 로비·베팅·참가/이탈은 RoundTableManager가, 딜링·차례·판정은 BlackjackRound가 담당.
 */
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const wallet = require('../services/wallet');
const { getShoe } = require('../services/shoes');
const { RoundTableManager } = require('../services/roundTable');
const { BlackjackRound } = require('../engine/blackjackTable');
const bj = require('../engine/blackjack');
const { unixIn, runExclusive } = require('../utils/table');
const { COLOR, chips, num, signed, netText, handText, sleep, ephemeral } = require('../utils/format');

const BJ = config.BLACKJACK;
const STATUS = { playing: '', stand: '✋', bust: '💥 버스트', blackjack: '🂡 블랙잭' };

/** 원시 데이터만 보여주는 계기판 — 유리/불리 판정은 하지 않는다 */
function meter(shoe) {
  return [
    '```ini',
    `[ Running Count: ${signed(shoe.runningCount)} ]  [ True Count: ${signed(shoe.trueCount, 1)} ]`,
    `[ 남은 카드: ${shoe.remaining} / ${shoe.total} ]  [ 남은 덱: ${shoe.decksRemaining.toFixed(2)} ]`,
    '```',
  ].join('\n');
}

function handLine(h, isActor) {
  const v = bj.handValue(h.cards);
  const value = `${v.total}${v.soft && v.total < 21 ? ' soft' : ''}`;
  const tag = [h.doubled ? '2️⃣ 더블' : '', STATUS[h.status]].filter(Boolean).join(' · ');
  return `${isActor ? '▶' : '　'} **${h.name}** ${chips(h.bet)} — ${handText(h.cards)} \`${value}\`${tag ? ` ${tag}` : ''}`;
}

function dealerLine(r) {
  const hidden = r.holeHidden ? [1] : [];
  const val = r.holeHidden ? `${bj.handValue([r.dealer[0]]).total}+?` : bj.handValue(r.dealer).total;
  return `🎩 **딜러** — ${handText(r.dealer, hidden)} \`${val}\``;
}

const mgr = new RoundTableManager({
  prefix: 'bj',
  game: 'blackjack',
  title: '블랙잭',
  color: COLOR.table,
  cfg: BJ,

  titleFor(t) {
    const shoe = getShoe('blackjack', t.channelId);
    return `🃏 블랙잭 테이블 · 슈 #${shoe.shoeNumber}`;
  },

  lobbyInfo(t) {
    return `${BJ.DECKS}덱 공유 슈 · 블랙잭 3:2 · 딜러 소프트17 ${BJ.DEALER_HITS_SOFT_17 ? '히트' : '스탠드'} · 베팅 ${BET_TEXT}\n${meter(getShoe('blackjack', t.channelId))}`;
  },

  parseBet(extra) {
    const amount = Number(extra);
    return BJ.BET_OPTIONS.includes(amount) ? { amount } : null;
  },

  betLabel(b) {
    return chips(b.amount);
  },

  betRows(t) {
    return [
      new ActionRowBuilder().addComponents(
        BJ.BET_OPTIONS.map((amt) =>
          new ButtonBuilder().setCustomId(mgr.cid(t, 'bet', amt)).setLabel(num(amt)).setEmoji('🪙').setStyle(ButtonStyle.Secondary),
        ),
      ),
    ];
  },

  playRows(t) {
    const r = t.round;
    if (!r || r.actor === null) return [];
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(mgr.cid(t, 'hit')).setLabel('히트').setEmoji('➕').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(mgr.cid(t, 'stand')).setLabel('스탠드').setEmoji('✋').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(mgr.cid(t, 'double'))
          .setLabel('더블')
          .setEmoji('2️⃣')
          .setStyle(ButtonStyle.Success)
          .setDisabled(!r.canDouble(r.actor)),
      ),
    ];
  },

  describe(t, prompt) {
    const shoe = getShoe('blackjack', t.channelId);
    const parts = [];
    if (t.state === 'playing' && t.round) {
      const r = t.round;
      parts.push(dealerLine(r), '', ...r.hands.map((h, k) => handLine(h, k === r.actor)));
      const waiting = t.players.filter((p) => !r.hands.some((h) => h.id === p.id));
      if (waiting.length) parts.push(`　💤 다음 판 대기: ${waiting.map((p) => p.name).join(', ')}`);
      if (t.roundNote) parts.push('', t.roundNote);
    } else {
      if (t.lastSummary) parts.push('**지난 판**', t.lastSummary, '');
      parts.push('**이번 판 베팅**', mgr.seatsBetText(t));
      if (t.note) parts.push('', t.note);
    }
    parts.push('', `📟 **계기판** (슈 #${shoe.shoeNumber})`, meter(shoe), prompt);
    return parts.join('\n');
  },

  async playRound(t, entries) {
    const shoe = getShoe('blackjack', t.channelId);
    const reshuffled = shoe.prepareRound();
    t.roundNote = reshuffled ? '🔄 **슈 재셔플!** 카운트가 초기화되었습니다.' : '';
    t.round = new BlackjackRound(
      shoe,
      entries.map((e) => ({ id: e.id, name: e.name, bet: e.amount, roundId: e.roundId })),
      { blackjackPays: BJ.BLACKJACK_PAYS, hitSoft17: BJ.DEALER_HITS_SOFT_17 },
    );
    t.round.deal();
    await drive(t);
  },

  async onAction(i, t, action) {
    if (!['hit', 'stand', 'double'].includes(action)) return undefined;
    const r = t.round;
    if (t.state !== 'playing' || !r) return i.reply(ephemeral('지금은 행동할 수 없어요.'));
    const idx = r.actor;
    const h = idx !== null ? r.hands[idx] : null;
    if (!h || h.id !== i.user.id) {
      return i.reply(ephemeral(h ? `지금은 **${h.name}** 님 차례예요.` : '딜러 차례예요.'));
    }
    if (t.busy) return i.deferUpdate();
    await i.deferUpdate();
    t.ui = i;

    await runExclusive(t, async () => {
      if (t.round !== r || r.actor !== idx) return;
      if (action === 'double') {
        if (!r.canDouble(idx)) return;
        const balance = await wallet.addStake(h.id, h.roundId, h.bet); // 같은 금액 추가 베팅 (원자적 잔고 검사)
        if (balance === null) {
          await i.followUp(ephemeral('더블할 잔고가 부족해요.'));
          return;
        }
      }
      clearTimeout(t.timers.turn);
      r.act(idx, action);
      await drive(t);
    });
    return undefined;
  },
});

const BET_TEXT = BJ.BET_OPTIONS.map(num).join(' / ');

/** 플레이어 차례면 대기, 모두 끝났으면 딜러 플레이 → 정산 */
async function drive(t) {
  const r = t.round;
  if (r.actor !== null) {
    const h = r.hands[r.actor];
    t.live.push(mgr.render(t, `👉 **${h.name}** 님 차례 · <t:${unixIn(BJ.TURN_MS)}:R> 자동 스탠드`));
    armTurnTimer(t, r, r.actor);
    return;
  }

  if (r.holeHidden) {
    r.revealHole();
    t.live.push(mgr.render(t, '🔍 딜러 홀카드 공개'));
    await sleep(BJ.DEALER_STEP_MS);
  }
  while (r.dealerShouldDraw) {
    r.dealerDraw();
    t.live.push(mgr.render(t, '🂠 딜러 드로우...'));
    await sleep(BJ.DEALER_STEP_MS);
  }
  await settle(t, r);
}

function armTurnTimer(t, r, idx) {
  clearTimeout(t.timers.turn);
  t.timers.turn = setTimeout(() => {
    runExclusive(t, async () => {
      if (t.round !== r || r.actor !== idx) return;
      r.act(idx, 'stand');
      t.roundNote = `⏱️ ${r.hands[idx].name} 님 시간 초과 — 자동 스탠드`;
      await drive(t);
    });
  }, BJ.TURN_MS);
}

async function settle(t, r) {
  const results = r.results();
  const lines = await Promise.all(
    r.hands.map(async (h, k) => {
      const x = results[k];
      let st;
      try {
        st = await wallet.settleRound(h.id, h.roundId, x.payout, {
          game: 'blackjack',
          guildId: t.guildId,
          inc: { blackjackHands: 1, ...(x.net > 0 ? { blackjackWins: 1 } : {}) },
          wagered: h.bet,
          detail: { cards: h.cards, dealer: r.dealer, outcome: x.outcome, doubled: h.doubled },
        });
      } catch (err) {
        console.error('[blackjack settle]', err);
        st = { ok: false, error: true };
      }
      const tail = st.ok ? ` · 잔고 ${chips(st.balance)}` : st.error ? ' · ⚠️ 정산 오류 (자동 환불 예정)' : ' · ⚠️ 이미 처리된 판';
      return `${x.label} **${h.name}** ${handText(h.cards)} **${netText(x.net)}**${tail}`;
    }),
  );
  t.round = null;
  await mgr.afterRound(t, [dealerLine(r), ...lines].join('\n'));
}

module.exports = {
  prefix: mgr.prefix,
  data: new SlashCommandBuilder()
    .setName('블랙잭')
    .setDescription('채널 공유 6덱 슈 블랙잭 테이블 — True Count를 직접 판독하세요')
    .addIntegerOption((o) =>
      o.setName('최대인원').setDescription(`테이블 최대 인원, 나 포함 (1~${BJ.MAX_PLAYERS}, 기본 1 = 바로 혼자 시작)`).setMinValue(1).setMaxValue(BJ.MAX_PLAYERS),
    ),
  async execute(i) {
    return mgr.open(i, i.options.getInteger('최대인원') ?? 1);
  },
  handleButton: (i, ctx) => mgr.handleButton(i, ctx),
  _mgr: mgr, // 테스트용
};
