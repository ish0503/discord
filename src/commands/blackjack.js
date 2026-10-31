/**
 * /블랙잭 — 채널 공유 슈 블랙잭 테이블 (스플릿·더블·보험).
 * 로비·베팅·참가/이탈은 RoundTableManager, 딜링·차례·판정은 BlackjackRound 담당.
 */
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const wallet = require('../services/wallet');
const settlement = require('../services/settlement');
const gameState = require('../services/gameState');
const { getShoe } = require('../services/shoes');
const { RoundTableManager } = require('../services/roundTable');
const { BlackjackRound } = require('../engine/blackjackTable');
const bj = require('../engine/blackjack');
const { unixIn, runExclusive, runSoon } = require('../utils/table');
const { COLOR, chips, num, signed, netText, handText, sleep, ephemeral } = require('../utils/format');

const BJ = config.BLACKJACK;
const STATUS = { playing: '', stand: '✋', bust: '💥 버스트', blackjack: '🂡 블랙잭' };
const BET_TEXT = BJ.BET_OPTIONS.map(num).join(' / ');

function meter(shoe) {
  return [
    '```ini',
    `[ Running Count: ${signed(shoe.runningCount)} ]  [ True Count: ${signed(shoe.trueCount, 1)} ]`,
    `[ 남은 카드: ${shoe.remaining} / ${shoe.total} ]  [ 남은 덱: ${shoe.decksRemaining.toFixed(2)} ]`,
    '```',
  ].join('\n');
}

const themeOf = (t, id) => t.players.find((p) => p.id === id)?.cos?.cardTheme ?? 'classic';

function handLine(t, r, h, k) {
  const v = bj.handValue(h.cards);
  const value = `${v.total}${v.soft && v.total < 21 ? ' soft' : ''}`;
  const siblings = r.hands.filter((x) => x.owner === h.owner);
  const label = siblings.length > 1 ? ` (${siblings.indexOf(h) + 1}/${siblings.length})` : '';
  const tags = [h.doubled ? '2️⃣ 더블' : '', h.splitAces ? '✂️A' : h.fromSplit ? '✂️' : '', STATUS[h.status]].filter(Boolean).join(' · ');
  const ins = r.player(h.owner)?.insurance && siblings[0] === h ? ` · 🛡️ 보험 ${num(r.player(h.owner).insurance)}` : '';
  return `${k === r.actor ? '▶' : '　'} **${h.name}**${label} ${chips(h.bet)} — ${handText(h.cards, [], themeOf(t, h.owner))} \`${value}\`${tags ? ` ${tags}` : ''}${ins}`;
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
    return `🃏 블랙잭 테이블 · 슈 #${getShoe('blackjack', t.channelId).shoeNumber}`;
  },

  lobbyInfo(t) {
    return `${BJ.DECKS}덱 공유 슈 · 블랙잭 3:2 · 보험 2:1 · 스플릿 최대 ${BJ.MAX_HANDS_PER_PLAYER}손 · S17 · 베팅 ${BET_TEXT}\n${meter(getShoe('blackjack', t.channelId))}`;
  },

  parseBet(extra) {
    const amount = Number(extra);
    return BJ.BET_OPTIONS.includes(amount) ? { amount } : null;
  },

  betLabel: (b) => chips(b.amount),

  betRows(t) {
    return [
      new ActionRowBuilder().addComponents(
        BJ.BET_OPTIONS.map((amt) => new ButtonBuilder().setCustomId(mgr.cid(t, 'bet', amt)).setLabel(num(amt)).setEmoji('🪙').setStyle(ButtonStyle.Secondary)),
      ),
    ];
  },

  playRows(t) {
    const r = t.round;
    if (!r) return [];
    if (r.phase === 'insurance') {
      return [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(mgr.cid(t, 'ins', 'yes')).setLabel('보험 들기 (베팅의 1/2)').setEmoji('🛡️').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(mgr.cid(t, 'ins', 'no')).setLabel('안 들기').setStyle(ButtonStyle.Secondary),
        ),
      ];
    }
    if (r.actor === null) return [];
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(mgr.cid(t, 'hit')).setLabel('히트').setEmoji('➕').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(mgr.cid(t, 'stand')).setLabel('스탠드').setEmoji('✋').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(mgr.cid(t, 'double')).setLabel('더블').setEmoji('2️⃣').setStyle(ButtonStyle.Success).setDisabled(!r.canDouble(r.actor)),
        new ButtonBuilder().setCustomId(mgr.cid(t, 'split')).setLabel('스플릿').setEmoji('✂️').setStyle(ButtonStyle.Success).setDisabled(!r.canSplit(r.actor)),
      ),
    ];
  },

  describe(t, prompt) {
    const shoe = getShoe('blackjack', t.channelId);
    const parts = [];
    if (t.state === 'playing' && t.round) {
      const r = t.round;
      parts.push(dealerLine(r), '', ...r.hands.map((h, k) => handLine(t, r, h, k)));
      if (r.phase === 'insurance') {
        parts.push('', '🛡️ **보험 단계** — 딜러 업카드가 A입니다. 딜러가 블랙잭이면 보험금의 2배를 받습니다.');
        parts.push(r.players.map((p) => `${p.insuranceDecided ? (p.insurance ? '🛡️' : '✖️') : '⏳'} ${p.name}`).join(' · '));
      }
      const waiting = t.players.filter((p) => !r.players.some((x) => x.id === p.id));
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
      { blackjackPays: BJ.BLACKJACK_PAYS, hitSoft17: BJ.DEALER_HITS_SOFT_17, maxHands: BJ.MAX_HANDS_PER_PLAYER, doubleAfterSplit: BJ.DOUBLE_AFTER_SPLIT },
    );
    t.round.deal();
    await drive(t);
  },

  async onAction(i, t, action, extra) {
    const r = t.round;
    if (action === 'ins') return insurance(i, t, r, extra === 'yes');
    if (!['hit', 'stand', 'double', 'split'].includes(action)) return undefined;
    if (t.state !== 'playing' || !r || r.phase !== 'play') return i.reply(ephemeral('지금은 행동할 수 없어요.'));
    const idx = r.actor;
    const h = idx !== null ? r.hands[idx] : null;
    if (!h || h.owner !== i.user.id) return i.reply(ephemeral(h ? `지금은 **${h.name}** 님 차례예요.` : '딜러 차례예요.'));
    if (t.busy) return i.deferUpdate();
    await i.deferUpdate();
    t.ui = i;

    await runExclusive(t, async () => {
      if (t.round !== r || r.actor !== idx) return;
      if ((action === 'double' && !r.canDouble(idx)) || (action === 'split' && !r.canSplit(idx))) return;
      const extraStake = r.extraStake(idx, action);
      if (extraStake) {
        const roundId = r.player(h.owner).roundId;
        if ((await wallet.addStake(h.owner, t.guildId, roundId, extraStake)) === null) {
          await i.followUp(ephemeral(`${action === 'split' ? '스플릿' : '더블'}할 잔고가 부족해요.`));
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

async function insurance(i, t, r, take) {
  if (!r || r.phase !== 'insurance') return i.reply(ephemeral('지금은 보험 시간이 아니에요.'));
  const p = r.player(i.user.id);
  if (!p) return i.reply(ephemeral('이번 판 참가자가 아니에요.'));
  if (p.insuranceDecided || p.insurancePending) return i.reply(ephemeral('이미 결정했어요.'));
  p.insurancePending = true; // 연타로 보험금이 두 번 빠지는 것 방지
  await i.deferUpdate();
  t.ui = i;
  runSoon(t, async () => {
    if (t.round !== r || r.phase !== 'insurance' || p.insuranceDecided) return;
    let buy = take;
    // 보험금 차감도 락 안에서 → 피크 타이머와 경합 불가
    if (buy && (await wallet.addStake(p.id, t.guildId, p.roundId, Math.floor(p.baseBet / 2))) === null) {
      await i.followUp(ephemeral('보험금을 낼 잔고가 부족해 보험 없이 진행합니다.'));
      buy = false;
    }
    if (r.decideInsurance(p.id, buy)) {
      clearTimeout(t.timers.insurance);
      await afterPeek(t, r);
    } else t.live.push(mgr.render(t, insurancePrompt()));
  });
  return undefined;
}

const insurancePrompt = () => `⏳ <t:${unixIn(BJ.INSURANCE_MS)}:R> 피크 · 결정하지 않으면 보험 없음`;

async function afterPeek(t, r) {
  t.roundNote = r.dealerBlackjack ? '💀 **딜러 블랙잭!**' : '🔍 딜러 피크: 블랙잭 아님 — 보험금은 소멸됩니다';
  await drive(t);
}

async function drive(t) {
  const r = t.round;
  if (r.phase === 'insurance') {
    t.live.push(mgr.render(t, insurancePrompt()));
    clearTimeout(t.timers.insurance);
    t.timers.insurance = setTimeout(() => {
      runSoon(t, async () => {
        if (t.round !== r || r.phase !== 'insurance') return;
        r.closeInsurance();
        await afterPeek(t, r);
      });
    }, BJ.INSURANCE_MS);
    return;
  }
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
    runSoon(t, async () => {
      if (t.round !== r || r.actor !== idx) return;
      r.act(idx, 'stand');
      t.roundNote = `⏱️ ${r.hands[idx].name} 님 시간 초과 — 자동 스탠드`;
      await drive(t);
    });
  }, BJ.TURN_MS);
}

async function settle(t, r) {
  const res = r.results();
  gameState.transition(t.id, 'SETTLING');
  for (const p of res.players) {
    const rp = r.player(p.id);
    await settlement.commit({ userId: p.id, guildId: t.guildId, roundId: rp.roundId, payout: p.payout, game: 'blackjack' });
  }
  const lines = await Promise.all(
    res.players.map(async (p) => {
      const rp = r.player(p.id);
      const mine = r.hands.map((h, k) => (h.owner === p.id ? { h, x: res.hands[k] } : null)).filter(Boolean);
      const st = await settlement.finalize({
        userId: p.id,
        guildId: t.guildId,
        roundId: rp.roundId,
        payout: p.payout,
        game: 'blackjack',
        gameId: t.id,
        channelId: t.channelId,
        inc: { blackjackHands: 1, ...(p.net > 0 ? { blackjackWins: 1 } : {}) },
        wagered: p.staked,
        detail: {
          hands: mine.map(({ h }) => h.cards),
          outcomes: mine.map(({ x }) => x.outcome),
          dealer: r.dealer,
          insurance: p.insurance,
          insurancePaid: p.insurancePayout,
        },
      });
      const handsTxt = mine.map(({ h, x }) => `${handText(h.cards, [], themeOf(t, p.id))} ${x.label}`).join(' / ');
      const ins = p.insurance ? ` · 🛡️${p.insurancePayout ? ` +${num(p.insurancePayout - p.insurance)}` : ` -${num(p.insurance)}`}` : '';
      return `**${rp.name}** ${handsTxt}${ins} → **${netText(p.net)}**${settlement.tail(st, chips)}`;
    }),
  );
  t.round = null;
  await mgr.afterRound(t, [dealerLine(r), ...lines].join('\n'));
}

module.exports = {
  prefix: mgr.prefix,
  game: 'blackjack',
  data: new SlashCommandBuilder()
    .setName('블랙잭')
    .setDescription('공유 6덱 슈 블랙잭 테이블 (스플릿·더블·보험) — True Count를 판독하세요')
    .addIntegerOption((o) =>
      o.setName('최대인원').setDescription(`테이블 최대 인원, 나 포함 (1~${BJ.MAX_PLAYERS}, 기본 1 = 바로 혼자 시작)`).setMinValue(1).setMaxValue(BJ.MAX_PLAYERS),
    ),
  async execute(i) {
    return mgr.open(i, i.options.getInteger('최대인원') ?? 1);
  },
  handleButton: (i, ctx) => mgr.handleButton(i, ctx),
  _mgr: mgr,
};
