/**
 * /바카라 — 채널 공유 8덱 슈를 여러 명이 함께 쓰는 바카라 테이블.
 * 한 번의 딜에 테이블 전원이 각자 고른 쪽(플레이어/뱅커/타이)으로 승부한다.
 */
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const settlement = require('../services/settlement');
const gameState = require('../services/gameState');
const { getShoe } = require('../services/shoes');
const { RoundTableManager } = require('../services/roundTable');
const bac = require('../engine/baccarat');
const { COLOR, num, chips, netText, handText, sleep } = require('../utils/format');

const BC = config.BACCARAT;
const SIDES = ['player', 'banker', 'tie'];
const DOT = { player: '🔵', banker: '🔴', tie: '🟢' };
const NAME = { player: '플레이어', banker: '뱅커', tie: '타이' };
const STYLE = { player: ButtonStyle.Primary, banker: ButtonStyle.Danger, tie: ButtonStyle.Success };

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

function tableText(player, banker) {
  const pt = player.length ? bac.total(player) : '-';
  const bt = banker.length ? bac.total(banker) : '-';
  return `🔵 **플레이어** ${handText(player) || '…'}  \`${pt}\`\n🔴 **뱅커** ${handText(banker) || '…'}  \`${bt}\``;
}

const LEGEND = `🔵 플레이어 ×${BC.PAYOUT.player} · 🔴 뱅커 ×${BC.PAYOUT.banker} · 🟢 타이 ×${BC.PAYOUT.tie} (타이 시 P/B 베팅은 반환)`;

const mgr = new RoundTableManager({
  prefix: 'bc',
  game: 'baccarat',
  title: '바카라',
  color: COLOR.table,
  cfg: BC,

  titleFor(t) {
    return `🎴 바카라 테이블 · 슈 #${getShoe('baccarat', t.channelId).shoeNumber}`;
  },

  lobbyInfo(t) {
    return `${BC.DECKS}덱 공유 슈 · ${LEGEND}\n\n${board(getShoe('baccarat', t.channelId))}`;
  },

  parseBet(extra) {
    const [side, amt] = extra.split('.');
    const amount = Number(amt);
    return SIDES.includes(side) && BC.BET_OPTIONS.includes(amount) ? { side, amount } : null;
  },

  betLabel(b) {
    return `${DOT[b.side]} ${NAME[b.side]} ${chips(b.amount)}`;
  },

  /** 쪽 × 금액 = 3줄 버튼, 한 번 클릭으로 베팅 */
  betRows(t) {
    return SIDES.map((side) =>
      new ActionRowBuilder().addComponents(
        BC.BET_OPTIONS.map((amt) =>
          new ButtonBuilder()
            .setCustomId(mgr.cid(t, 'bet', `${side}.${amt}`))
            .setLabel(num(amt))
            .setEmoji(DOT[side])
            .setStyle(STYLE[side]),
        ),
      ),
    );
  },

  playRows() {
    return []; // 딜 연출 중에는 버튼 없음
  },

  describe(t, prompt) {
    const shoe = getShoe('baccarat', t.channelId);
    const parts = [board(shoe), ''];
    if (t.state === 'playing' && t.view) {
      parts.push(tableText(t.view.player, t.view.banker), '', '**이번 판 베팅**');
      parts.push(...t.roundEntries.map((e) => `🧑 **${e.name}** — ${mgr.betLabel(e)}`));
    } else {
      if (t.lastSummary) parts.push('**지난 판**', t.lastSummary, '');
      parts.push('**이번 판 베팅**', mgr.seatsBetText(t));
      if (t.note) parts.push('', t.note);
    }
    parts.push('', LEGEND, prompt);
    return parts.join('\n');
  },

  async playRound(t, entries) {
    const shoe = getShoe('baccarat', t.channelId);
    const reshuffled = shoe.prepareRound();
    const round = bac.playRound(() => shoe.draw()); // 결과 선 연산
    const outcomes = entries.map((e) => ({ e, ...bac.settle(e.side, round.winner, e.amount, BC.PAYOUT) }));
    // 연출 전에 결과를 선기록 → 연출 도중 서버가 죽어도 이 결과대로 정산
    gameState.transition(t.id, 'SETTLING');
    for (const o of outcomes) await settlement.commit({ userId: o.e.id, guildId: t.guildId, roundId: o.e.roundId, payout: o.e.amount + o.net, game: 'baccarat' });

    // 카드 한 장씩 공개 연출
    t.view = { player: [], banker: [] };
    for (const { side, card } of round.order) {
      t.view[side].push(card);
      t.live.push(mgr.render(t, reshuffled ? '🔄 새 슈로 교체 후 딜링 중...' : '🎴 딜링 중...'));
      await sleep(BC.DEAL_MS);
    }
    shoe.history.push(round.winner);

    const lines = await Promise.all(
      outcomes.map(async ({ e, net, push }) => {
        const st = await settlement.finalize({
          userId: e.id,
          guildId: t.guildId,
          roundId: e.roundId,
          payout: e.amount + net,
          game: 'baccarat',
          gameId: t.id,
          channelId: t.channelId,
          inc: { baccaratRounds: 1, ...(net > 0 ? { baccaratWins: 1 } : {}) },
          wagered: e.amount,
          detail: { side: e.side, winner: round.winner, player: round.player, banker: round.banker, natural: round.natural },
        });
        const verdict = push ? '🤝' : net > 0 ? '🎉' : '😵';
        return `${verdict} **${e.name}** ${DOT[e.side]} **${netText(net)}**${settlement.tail(st, chips)}`;
      }),
    );

    const headline = `${DOT[round.winner]} **${NAME[round.winner]} 승**${round.natural ? ' (내추럴)' : ''}`;
    t.view = null;
    await mgr.afterRound(t, [tableText(round.player, round.banker), headline, ...lines].join('\n'));
  },

  onAction() {
    return undefined;
  },
});

module.exports = {
  prefix: mgr.prefix,
  game: 'baccarat',
  data: new SlashCommandBuilder()
    .setName('바카라')
    .setDescription('채널 공유 8덱 슈 바카라 테이블 — 흐름 보드를 직접 판독하세요')
    .addIntegerOption((o) =>
      o.setName('최대인원').setDescription(`테이블 최대 인원, 나 포함 (1~${BC.MAX_PLAYERS}, 기본 1 = 바로 혼자 시작)`).setMinValue(1).setMaxValue(BC.MAX_PLAYERS),
    ),
  async execute(i) {
    return mgr.open(i, i.options.getInteger('최대인원') ?? 1);
  },
  handleButton: (i, ctx) => mgr.handleButton(i, ctx),
  _mgr: mgr,
};
