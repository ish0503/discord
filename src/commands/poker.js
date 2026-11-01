/**
 * /포커페이스 — 노리밋 홀덤 현금 테이블 (봇 N + 사람 최대 M, 올인·사이드팟).
 * 금액 = 바이인 = 시작 스택. 시작 시 바이인을 에스크로로 묶고, 핸드가 끝나면 최종 스택을 돌려준다.
 */
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const wallet = require('../services/wallet');
const settlement = require('../services/settlement');
const gameState = require('../services/gameState');
const sessions = require('../services/sessions');
const lobby = require('../services/lobby');
const { PokerRoom, makeBots, route } = require('../services/pokerRoom');
const { randomInt, shuffle } = require('../utils/rng');
const { chips, num, ephemeral } = require('../utils/format');

const PK = config.POKER;
const PREFIX = 'pk';
const blindsFor = (buyin) => {
  const bb = Math.max(2, Math.round(buyin / PK.BB_PER_BUYIN));
  return { bb, sb: Math.max(1, Math.floor(bb / 2)) };
};

async function open(i, { buyin, bots, maxHumans }) {
  if (bots + maxHumans > PK.MAX_SEATS) return i.reply(ephemeral(`봇 + 최대 인원은 ${PK.MAX_SEATS}명 이하여야 해요.`));
  if (bots + maxHumans < 2) return i.reply(ephemeral('봇이 0명이면 최대 인원을 2명 이상으로 정해 주세요.'));
  const { sb, bb } = blindsFor(buyin);
  return lobby.open(i, {
    prefix: PREFIX,
    game: 'poker',
    title: '🎭 포커페이스 테이블 모집',
    info: () => [`바이인 **${chips(buyin)}** (= 시작 스택) · 블라인드 **${num(sb)}/${num(bb)}** · 노리밋 · 올인/사이드팟`, '한 핸드 승부 후 정산 · 끝나면 호스트가 같은 설정으로 다시 열 수 있어요'],
    maxHumans,
    bots,
    minSeats: 2,
    lobbyMs: PK.LOBBY_MS,
    entryCheck: async (uid, gid) => {
      const acc = await wallet.getAccount(uid, gid);
      return acc.money < buyin ? `바이인 ${chips(buyin)} 이상의 잔고가 필요해요. (현재 ${chips(acc.money)})` : null;
    },
    onStart: (l) => start(l, { buyin, bots, maxHumans, sb, bb }),
  });
}

async function start(l, { buyin, bots, maxHumans, sb, bb }) {
  // 바이인 확보 (실패한 사람은 제외)
  const humans = [];
  for (const h of l.humans) {
    const r = await wallet.reserve(h.id, l.guildId, 'poker', buyin, { gameId: l.id }).catch(() => null);
    if (r) humans.push({ ...h, roundId: r.roundId });
    else {
      sessions.end(h.marker);
      Promise.resolve().then(() => h.privateEdit?.({ content: '⚠️ 시작 시점 잔고가 부족해 제외되었습니다.' })).catch(() => {});
    }
  }
  if (humans.length + bots < 2 || !humans.length) {
    for (const h of humans) {
      await wallet.refund({ userId: h.id, guildId: l.guildId, roundId: h.roundId, reason: 'table-cancelled' }).catch(console.error);
      sessions.end(h.marker);
    }
    return l.live.final(lobby.render(l, '⚠️ 잔고 부족으로 인원이 모자라 취소되었습니다.', { closed: true }));
  }

  gameState.create({ gameId: l.id, game: 'poker', guildId: l.guildId, channelId: l.channelId, messageId: l.message?.id, players: humans.map((h) => h.id), state: 'PLAYING' });
  const seats = shuffle([...humans.map((h) => ({ type: 'human', id: h.id, name: h.name, stack: buyin, privateEdit: h.privateEdit, cos: h.cos, roundId: h.roundId, marker: h.marker })), ...makeBots(bots, PK.BOT_NAMES, buyin)]);
  const room = new PokerRoom({
    id: l.id,
    prefix: PREFIX,
    guildId: l.guildId,
    channelId: l.channelId,
    seats,
    live: l.live,
    turnMs: PK.TURN_MS,
    thinkMs: PK.BOT_THINK_MS,
    simulations: PK.SIMULATIONS,
    streetPauseMs: PK.STREET_PAUSE_MS,
    revealFoldedBots: PK.REVEAL_FOLDED_BOTS,
    autoSitOut: false,
    title: (r) => `🎭 포커페이스 · 블라인드 ${num(sb)}/${num(bb)} · ${r.hand?.streetName ?? ''}`,
    footer: () => `바이인 ${num(buyin)} · 노리밋 · 🔘 버튼 · 시간 초과 시 체크/다이`,
    onHandEnd: (r, h) => finish(r, h, { l, buyin, bots, maxHumans }),
    // 화면 편집은 로비 메시지 편집기(l.live)를 그대로 사용 → 공개 메시지에 응답한 최신 버튼 토큰만 l.ui에 반영
    onInteraction: (i) => (l.ui = i),
  });
  await room.playHand({ sb, bb, button: randomInt(0, seats.length) });
}

async function finish(room, h, { l, buyin, bots, maxHumans }) {
  gameState.transition(room.id, 'SETTLING');
  const lines = [];
  const tableTotal = room.startStacks.reduce((a, b) => a + b, 0);
  const entries = [];
  for (let k = 0; k < h.seats.length; k++) {
    const seat = room.handSeats[k];
    if (seat.type !== 'human') continue;
    const r = h.results[k];
    entries.push({
      userId: seat.id,
      roundId: seat.roundId,
      payout: r.finalStack,
      staked: buyin,
      maxPayout: tableTotal, // 한 핸드에서 딸 수 있는 최대 = 테이블 전체 칩
      inc: { pokerHands: 1, ...(r.net > 0 ? { pokerWins: 1 } : {}) },
      wagered: h.seats[k].totalIn,
      detail: {
        hole: h.seats[k].hole,
        board: h.board,
        hand: h.endReason === 'showdown' && !h.seats[k].folded ? r.hand.name : null,
        handCategory: h.endReason === 'showdown' && !h.seats[k].folded ? r.hand.category : -1,
        wentAllIn: room.allIns.has(seat.id),
        endReason: h.endReason,
        seats: h.seats.length,
        buyin,
        opponents: room.handSeats.filter((x) => x.type === 'human' && x.id !== seat.id).map((x) => x.id),
      },
    });
  }
  // 불변식: 핸드 전후 테이블 전체 칩(사람+봇)이 같아야 함 (칩 보존)
  const st = await settlement.batch({
    settlementId: `poker:${room.id}:${room.handNo}`,
    game: 'poker',
    guildId: room.guildId,
    gameId: room.id,
    channelId: room.channelId,
    entries,
    maxTotal: tableTotal,
    check: () => {
      const after = h.results.reduce((a, r) => a + r.finalStack, 0);
      return after === tableTotal ? { ok: true } : { ok: false, reason: `칩 보존 위반: 시작 ${tableTotal} ≠ 종료 ${after}` };
    },
  });
  for (const e of entries) {
    const r = st.results.get(e.roundId);
    if (!r?.ok) lines.push(`⚠️ ${room.handSeats.find((x) => x.id === e.userId)?.name ?? e.userId} 정산 ${st.status === 'rejected' ? '보류 (검증 실패 — 관리자 확인)' : '지연 (자동 복구 예정)'}`);
  }
  for (const seat of room.handSeats) if (seat.type === 'human') sessions.end(seat.marker);
  gameState.transition(room.id, 'COMPLETED');
  room.close();
  const again = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:${l.hostId}:again:${buyin}.${bots}.${maxHumans}`).setLabel('같은 설정으로 새 테이블 (호스트)').setEmoji('🔁').setStyle(ButtonStyle.Primary),
  );
  await room.live.final(room.render(room.potSummary(), { final: true, extraRows: [again], extraLines: lines })).catch(console.error);
}

module.exports = {
  prefix: PREFIX,
  game: 'poker',
  data: new SlashCommandBuilder()
    .setName('포커페이스')
    .setDescription('봇·유저가 함께하는 노리밋 홀덤 (올인·사이드팟) — 블러핑을 판독하세요')
    .addIntegerOption((o) => o.setName('금액').setDescription('바이인 = 시작 스택').setRequired(true).setMinValue(config.MIN_BET * 10).setMaxValue(config.MAX_BET))
    .addIntegerOption((o) => o.setName('봇').setDescription(`AI 봇 수 (0~${PK.MAX_BOTS}, 기본 1)`).setMinValue(0).setMaxValue(PK.MAX_BOTS))
    .addIntegerOption((o) => o.setName('최대인원').setDescription(`사람 최대 인원, 나 포함 (1~${PK.MAX_HUMANS}, 기본 1)`).setMinValue(1).setMaxValue(PK.MAX_HUMANS)),

  async execute(i) {
    return open(i, { buyin: i.options.getInteger('금액', true), bots: i.options.getInteger('봇') ?? 1, maxHumans: i.options.getInteger('최대인원') ?? 1 });
  },

  async handleButton(i, { action, arg }) {
    if (action === 'again') {
      const [buyin, bots, maxHumans] = arg.split('.').map(Number);
      return open(i, { buyin, bots, maxHumans });
    }
    if (lobby.LOBBY_ACTIONS.includes(action)) return lobby.handleButton(i, action, arg);
    return route(i, action, arg);
  },
};
