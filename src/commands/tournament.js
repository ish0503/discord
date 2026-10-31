/**
 * /토너먼트 — 노리밋 홀덤 프리즈아웃 토너먼트.
 *  - 참가비(칩)를 내고 토너먼트 칩으로 시작, 마지막 1명이 남거나 최대 핸드 도달 시 종료
 *  - HANDS_PER_LEVEL 핸드마다 블라인드 BLIND_GROWTH배 상승, 스택 0이면 탈락
 *  - 상금 풀 = 사람 참가비 합 × (1 − RAKE). 봇은 참가비를 내지 않고 상금도 받지 않음
 *    → 상금은 "사람 참가자들 사이의 순위"로 분배 (사전 공개)
 *  - 두 번 연속 시간 초과한 사람은 자리비움(자동 체크/다이) → [복귀] 버튼으로 돌아옴
 *
 * 진행 무대 (스레드):
 *  - 시작되면 모집 메시지에서 전용 스레드를 만들어 그 안에서 진행 → 원래 채널은 다른 게임을 계속 할 수 있음
 *  - 원래 채널의 모집 메시지는 "🏆 토너먼트 진행 중" 현황판(레벨·생존자·칩 순위·스레드 링크)으로 바뀜
 *  - 핸드마다 스레드에 새 테이블 메시지를 올리고, 끝난 핸드는 그 메시지가 공개 결과 기록으로 남음
 *  - 스레드를 만들 수 없으면(권한 없음·이미 스레드 안) 같은 채널에 새 메시지로 진행
 */
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const wallet = require('../services/wallet');
const settlement = require('../services/settlement');
const gameState = require('../services/gameState');
const sessions = require('../services/sessions');
const lobby = require('../services/lobby');
const Tournament = require('../db/Tournament');
const { PokerRoom, makeBots, route } = require('../services/pokerRoom');
const { randomInt, shuffle } = require('../utils/rng');
const { LiveMessage } = require('../utils/liveMessage');
const { COLOR, chips, num, netText, sleep, ephemeral } = require('../utils/format');

const TN = config.TOURNAMENT;
const PREFIX = 'tn';
const MEDAL = ['🥇', '🥈', '🥉'];

function splitFor(humans) {
  return [...TN.PAYOUTS].reverse().find((p) => humans >= p.minHumans)?.split ?? [1];
}

/** 상금 계산 (순수): 사람 참가자 순위 순서 → 금액 */
function prizes(pool, humanOrder) {
  const split = splitFor(humanOrder.length);
  const out = split.map((ratio, k) => ({ userId: humanOrder[k], amount: Math.floor(pool * ratio), place: k + 1 })).filter((p) => p.userId);
  const rest = pool - out.reduce((s, p) => s + p.amount, 0);
  if (out.length) out[0].amount += rest; // 나머지 칩은 1위에게
  return out;
}

function levelBlinds(level) {
  const bb = Math.round((TN.START_BB * TN.BLIND_GROWTH ** level) / 2) * 2;
  return { bb, sb: bb / 2 };
}

async function open(i, { fee, bots, maxHumans, stack }) {
  if (bots + maxHumans > TN.MAX_SEATS) return i.reply(ephemeral(`봇 + 최대 인원은 ${TN.MAX_SEATS}명 이하여야 해요.`));
  if (bots + maxHumans < 2) return i.reply(ephemeral('최소 2좌석이 필요해요.'));
  const { sb, bb } = levelBlinds(0);
  return lobby.open(i, {
    prefix: PREFIX,
    game: 'tournament',
    title: '🏆 토너먼트 참가자 모집',
    info: () => [
      `참가비 **${chips(fee)}** · 시작 칩 **${num(stack)}** · 블라인드 ${sb}/${bb}부터 ${TN.HANDS_PER_LEVEL}핸드마다 ×${TN.BLIND_GROWTH}`,
      `💰 상금 = 사람 참가비 합${TN.RAKE ? ` × ${(1 - TN.RAKE) * 100}%` : ''} · 분배(사람 순위 기준): 1~2명 100% / 3~4명 65·35 / 5명+ 50·30·20`,
      `🤖 봇은 참가비를 내지 않고 상금도 받지 않아요 · 최대 ${TN.MAX_HANDS}핸드 후 칩 순위로 종료`,
    ],
    maxHumans,
    bots,
    minSeats: 2,
    lobbyMs: TN.LOBBY_MS,
    entryCheck: async (uid, gid) => {
      const acc = await wallet.getAccount(uid, gid);
      return acc.money < fee ? `참가비 ${chips(fee)} 이상의 잔고가 필요해요. (현재 ${chips(acc.money)})` : null;
    },
    onStart: (l) => start(l, { fee, bots, maxHumans, stack }),
  });
}

async function start(l, { fee, bots, maxHumans, stack }) {
  const humans = [];
  for (const h of l.humans) {
    const r = await wallet.reserve(h.id, l.guildId, 'tournament', fee, { gameId: l.id }).catch(() => null);
    if (r) humans.push({ ...h, roundId: r.roundId });
    else sessions.end(h.marker);
  }
  if (!humans.length || humans.length + bots < 2) {
    for (const h of humans) {
      await wallet.refund({ userId: h.id, guildId: l.guildId, roundId: h.roundId, reason: 'tournament-cancelled' });
      sessions.end(h.marker);
    }
    return l.live.final(lobby.render(l, '⚠️ 참가비 확보 실패로 토너먼트가 취소되었습니다.', { closed: true }));
  }
  const pool = Math.floor(fee * humans.length * (1 - TN.RAKE));
  const seats = shuffle([...humans.map((h) => ({ type: 'human', id: h.id, name: h.name, stack, privateEdit: h.privateEdit, cos: h.cos, roundId: h.roundId, marker: h.marker })), ...makeBots(bots, config.POKER.BOT_NAMES, stack)]);
  await Tournament.create({ tournamentId: l.id, guildId: l.guildId, economyKey: wallet.economyKey(l.guildId), channelId: l.channelId, fee, rake: TN.RAKE, prizePool: pool, startStack: stack, entrants: seats.map((s) => ({ id: s.id, name: s.name, type: s.type })) }).catch(console.error);
  gameState.create({ gameId: l.id, game: 'tournament', guildId: l.guildId, channelId: l.channelId, messageId: l.message?.id, players: humans.map((h) => h.id), state: 'PLAYING' });

  const T = { l, fee, pool, stack, bots, maxHumans, level: 0, finish: [], button: randomInt(0, seats.length), humans: humans.length, startedAt: Date.now() };
  T.stage = await openStage(l, { fee, seats, pool });
  const room = new PokerRoom({
    id: l.id,
    prefix: PREFIX,
    guildId: l.guildId,
    channelId: l.channelId,
    seats,
    live: l.live,
    turnMs: TN.TURN_MS,
    thinkMs: config.POKER.BOT_THINK_MS,
    simulations: 180,
    streetPauseMs: config.POKER.STREET_PAUSE_MS,
    revealFoldedBots: false,
    autoSitOut: true,
    title: (r) => {
      const { sb, bb } = levelBlinds(T.level);
      return `🏆 토너먼트 · 레벨 ${T.level + 1} (${sb}/${bb}) · 핸드 #${r.handNo} · 생존 ${r.seats.filter((s) => s.stack > 0).length}명`;
    },
    footer: () => `상금 풀 ${num(pool)} · 탈락 ${T.finish.length}명 · ${TN.HANDS_PER_LEVEL}핸드마다 블라인드 ×${TN.BLIND_GROWTH}`,
    onHandEnd: (r, h) => afterHand(r, h, T),
    // 스레드 모드에서는 테이블 메시지를 봇 토큰으로 직접 편집하므로 인터랙션 토큰이 필요 없음
    onInteraction: (i) => {
      if (!T.stage) l.ui = i;
    },
  });
  T.room = room;
  const { sb, bb } = levelBlinds(0);
  await newHandMessage(room, T);
  pushStatus(T);
  await room.playHand({ sb, bb, button: T.button });
}

// ───────────────────────── 진행 무대 (스레드 / 채널 현황판) ─────────────────────────

/** 모집 메시지에서 전용 스레드를 연다. 실패하면 같은 채널, 그것도 안 되면 null(모집 메시지 하나로 진행) */
async function openStage(l, { fee, seats, pool }) {
  const base = l.message;
  const inThread = base?.channel?.isThread?.() ?? false;
  let thread = null;
  if (base?.startThread && !inThread) {
    thread = await base
      .startThread({ name: `🏆 토너먼트 · 참가비 ${num(fee)} · ${seats.length}인`.slice(0, 100), autoArchiveDuration: 1440, reason: '카지노 토너먼트 진행' })
      .catch((err) => (console.warn('[tournament] 스레드 생성 실패 → 채널에서 진행:', err.message), null));
  }
  const target = thread ?? base?.channel ?? null;
  if (!target?.send) return null;
  const humans = seats.filter((s) => s.type === 'human');
  const intro = new EmbedBuilder()
    .setColor(COLOR.gold)
    .setTitle('🏆 토너먼트 시작!')
    .setDescription(
      [
        `참가자 ${humans.map((h) => `<@${h.id}>`).join(' ')}${seats.length > humans.length ? ` + 🤖 봇 ${seats.length - humans.length}명` : ''}`,
        `💰 상금 풀 **${chips(pool)}** · 시작 칩 ${num(seats[0]?.stack ?? 0)} · ${TN.HANDS_PER_LEVEL}핸드마다 블라인드 ×${TN.BLIND_GROWTH}`,
        '',
        '🃏 **내 패**는 테이블의 [내 패] 버튼으로 언제든 확인할 수 있어요 (나에게만 보임).',
        '📜 핸드가 끝날 때마다 결과가 이 스레드에 공개로 남습니다.',
        thread ? '💬 원래 채널에서는 다른 게임을 계속 즐길 수 있어요.' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  await target.send({ embeds: [intro], allowedMentions: { users: humans.map((h) => h.id) } }).catch((err) => console.warn('[tournament] 시작 안내 실패:', err.message));
  return { thread, target };
}

const liveFor = (msg) => new LiveMessage((p) => msg.edit(p));

/** 다음 핸드용 테이블 메시지를 무대 맨 아래에 새로 올린다 (지난 핸드 메시지는 결과 기록으로 남음) */
async function newHandMessage(room, T) {
  if (!T.stage) return;
  const msg = await T.stage.target
    .send({ embeds: [new EmbedBuilder().setColor(COLOR.table).setTitle(`🂠 핸드 #${room.handNo + 1} 딜링 중...`)] })
    .catch((err) => (console.warn('[tournament] 테이블 메시지 실패:', err.message), null));
  if (msg) {
    room.live = liveFor(msg);
    return;
  }
  // 무대에 글을 못 쓰면 모집 메시지 하나로 진행하는 기존 방식으로 전환
  T.stage = null;
  T.l.live.closed = false;
  room.live = T.l.live;
}

/** 원래 채널의 모집 메시지 = 진행 현황판 */
function statusPayload(T, { final = false, lines = [], rows = [] } = {}) {
  const room = T.room;
  const { sb, bb } = levelBlinds(T.level);
  const alive = room ? room.seats.filter((s) => s.stack > 0).sort((a, b) => b.stack - a.stack) : [];
  const where = T.stage?.thread ? `📍 진행 스레드: <#${T.stage.thread.id}>` : T.stage ? '📍 아래 메시지에서 진행 중' : '';
  const desc = final
    ? [where, ...lines]
    : [
        where,
        `⏱️ <t:${Math.floor(T.startedAt / 1000)}:R> 시작 · 레벨 **${T.level + 1}** (블라인드 ${num(sb)}/${num(bb)}) · 핸드 **#${room?.handNo ?? 0}**/${TN.MAX_HANDS}`,
        `💰 상금 풀 **${chips(T.pool)}** · 생존 **${alive.length}명** · 탈락 ${T.finish.length}명`,
        '',
        '**📊 칩 순위**',
        ...alive.slice(0, 8).map((s, k) => `${MEDAL[k] ?? `\`${k + 1}\``} ${s.type === 'bot' ? '🤖' : '🧑'} ${s.name} — ${num(s.stack)}`),
        ...(T.finish.length ? ['', `💀 탈락: ${[...T.finish].sort((a, b) => a.place - b.place).map((f) => `${f.name}(${f.place}위)`).join(', ')}`] : []),
      ];
  const embed = new EmbedBuilder()
    .setColor(final ? COLOR.gold : COLOR.lose)
    .setTitle(final ? '🏁 토너먼트 종료' : '🔴 LIVE · 🏆 토너먼트 진행 중')
    .setDescription(desc.filter((x) => x !== '').join('\n').slice(0, 4096))
    .setFooter({ text: final ? `총 ${room?.handNo ?? 0}핸드` : '관전은 스레드에서 · 이 채널에서는 다른 게임을 계속할 수 있어요' });
  return { embeds: [embed], components: rows };
}

function pushStatus(T) {
  if (T.stage) T.l.live.push(statusPayload(T));
}

function nextButton(room, from) {
  const n = room.seats.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    if (room.seats[i].stack > 0) return i;
  }
  return from;
}

async function afterHand(room, h, T) {
  // 스택 반영
  h.seats.forEach((s, k) => (room.handSeats[k].stack = h.results[k].finalStack));
  const alive = room.seats.filter((s) => s.stack > 0);
  // 이번 핸드 탈락자: 핸드 시작 스택이 클수록 높은 순위
  const busted = room.handSeats.map((s, k) => ({ s, start: room.startStacks[k] })).filter((x) => x.s.stack === 0 && !T.finish.some((f) => f.id === x.s.id));
  busted.sort((a, b) => a.start - b.start);
  let place = alive.length + busted.length;
  const bustLines = [];
  for (const b of busted) {
    T.finish.push({ id: b.s.id, name: b.s.name, type: b.s.type, place });
    bustLines.push(`💀 **${b.s.name}** 탈락 — ${place}위`);
    place -= 1;
  }

  const summary = room.potSummary();
  if (alive.length <= 1 || room.handNo >= TN.MAX_HANDS) {
    return finishTournament(room, T, alive.length <= 1 ? 'last-standing' : 'max-hands', [summary, ...bustLines]);
  }
  if (room.handNo % TN.HANDS_PER_LEVEL === 0) T.level += 1;
  const { sb, bb } = levelBlinds(T.level);
  const levelUp = room.handNo % TN.HANDS_PER_LEVEL === 0 ? [`⏫ 블라인드 상승 → **${sb}/${bb}**`] : [];
  if (T.stage) {
    // 끝난 핸드의 메시지는 공개 결과 기록으로 고정하고, 다음 핸드는 새 메시지에서
    await room.live.final(room.render(`✅ 핸드 #${room.handNo} 종료`, { final: true, extraLines: [summary, ...bustLines, ...levelUp] })).catch(console.error);
    pushStatus(T);
  } else {
    room.live.push(room.render(`⏳ 다음 핸드 준비 중...`, { final: true, extraLines: [summary, ...bustLines, ...levelUp] }));
  }
  await sleep(TN.HAND_PAUSE_MS);
  if (room.state !== 'playing') return undefined;
  T.button = nextButton(room, T.button);
  await newHandMessage(room, T);
  return room.playHand({ sb, bb, button: T.button });
}

async function finishTournament(room, T, reason, lines) {
  gameState.transition(room.id, 'SETTLING');
  // 생존자는 스택 순으로 상위 순위
  const alive = room.seats.filter((s) => s.stack > 0).sort((a, b) => b.stack - a.stack);
  alive.forEach((s, k) => T.finish.push({ id: s.id, name: s.name, type: s.type, place: k + 1 }));
  T.finish.sort((a, b) => a.place - b.place);
  const humanOrder = T.finish.filter((f) => f.type === 'human').map((f) => f.id);
  const paid = prizes(T.pool, humanOrder);
  const prizeOf = (id) => paid.find((p) => p.userId === id);

  for (const seat of room.seats.filter((s) => s.type === 'human')) {
    const pr = prizeOf(seat.id);
    const place = T.finish.find((f) => f.id === seat.id).place;
    const payout = pr?.amount ?? 0;
    await settlement.commit({ userId: seat.id, guildId: room.guildId, roundId: seat.roundId, payout, game: 'tournament' });
    await settlement.finalize({
      userId: seat.id,
      guildId: room.guildId,
      roundId: seat.roundId,
      payout,
      game: 'tournament',
      gameId: room.id,
      channelId: room.channelId,
      inc: { tournaments: 1, ...(place === 1 ? { tournamentWins: 1 } : {}) },
      wagered: T.fee,
      detail: { tournamentId: room.id, place, humanPlace: humanOrder.indexOf(seat.id) + 1, prize: payout, entrants: T.finish.length, reason },
    });
    sessions.end(seat.marker);
  }
  await Tournament.updateOne(
    { tournamentId: room.id },
    { $set: { state: 'finished', finish: T.finish, prizes: paid, hands: room.handNo, endedReason: reason } },
  ).catch(console.error);
  gameState.transition(room.id, 'COMPLETED');
  room.close();

  const standings = T.finish.map((f) => {
    const pr = prizeOf(f.id);
    return `${MEDAL[f.place - 1] ?? `\`${f.place}위\``} ${f.type === 'bot' ? '🤖' : '🧑'} **${f.name}**${pr ? ` — 💰 ${chips(pr.amount)} (${netText(pr.amount - T.fee)})` : f.type === 'human' ? ` — ${netText(-T.fee)}` : ''}`;
  });
  const again = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:${T.l.hostId}:again:${T.fee}.${T.bots}.${T.maxHumans}.${T.stack}`).setLabel('같은 설정으로 새 토너먼트 (호스트)').setEmoji('🔁').setStyle(ButtonStyle.Primary),
  );
  const head = reason === 'max-hands' ? `⏱️ 최대 ${TN.MAX_HANDS}핸드 도달 — 칩 순위로 종료` : '🏁 토너먼트 종료!';
  if (!T.stage) {
    await room.live.final(room.render(head, { final: true, extraRows: [again], extraLines: [...lines, '', '**🏆 최종 순위**', ...standings, `상금 풀 ${chips(T.pool)}`] })).catch(console.error);
    return;
  }
  // 1) 마지막 핸드 결과 고정  2) 스레드에 최종 순위 공개  3) 채널 현황판을 결과로  4) 스레드 보관
  await room.live.final(room.render(`✅ 핸드 #${room.handNo} 종료`, { final: true, extraLines: lines })).catch(console.error);
  const winner = T.finish[0];
  const result = new EmbedBuilder()
    .setColor(COLOR.gold)
    .setTitle(head)
    .setDescription([`👑 우승 **${winner?.name ?? '-'}**${winner?.type === 'human' ? ` (<@${winner.id}>)` : ''}`, '', '**🏆 최종 순위**', ...standings, '', `상금 풀 ${chips(T.pool)} · 총 ${room.handNo}핸드`].join('\n').slice(0, 4096));
  const humanIds = T.finish.filter((f) => f.type === 'human').map((f) => f.id);
  await T.stage.target.send({ embeds: [result], allowedMentions: { users: humanIds } }).catch(console.error);
  await T.l.live.final(statusPayload(T, { final: true, lines: [`👑 우승 **${winner?.name ?? '-'}**`, '', ...standings, '', `상금 풀 ${chips(T.pool)}`], rows: [again] })).catch(console.error);
  if (T.stage.thread?.setArchived) {
    const t = setTimeout(() => T.stage.thread.setArchived(true, '토너먼트 종료').catch(() => {}), TN.ARCHIVE_AFTER_MS);
    t.unref?.();
  }
}

module.exports = {
  prefix: PREFIX,
  game: 'tournament',
  prizes,
  levelBlinds,
  data: new SlashCommandBuilder()
    .setName('토너먼트')
    .setDescription('노리밋 홀덤 토너먼트 — 블라인드 상승, 탈락, 상금 분배')
    .addIntegerOption((o) => o.setName('참가비').setDescription('참가비 (칩)').setRequired(true).setMinValue(config.MIN_BET * 10).setMaxValue(config.MAX_BET))
    .addIntegerOption((o) => o.setName('봇').setDescription(`AI 봇 수 (0~${TN.MAX_BOTS}, 기본 3)`).setMinValue(0).setMaxValue(TN.MAX_BOTS))
    .addIntegerOption((o) => o.setName('최대인원').setDescription(`사람 최대 인원, 나 포함 (1~${TN.MAX_SEATS}, 기본 4)`).setMinValue(1).setMaxValue(TN.MAX_SEATS))
    .addIntegerOption((o) => o.setName('시작칩').setDescription(`토너먼트 시작 칩 (기본 ${TN.START_STACK})`).setMinValue(500).setMaxValue(10_000)),

  async execute(i) {
    return open(i, {
      fee: i.options.getInteger('참가비', true),
      bots: i.options.getInteger('봇') ?? 3,
      maxHumans: i.options.getInteger('최대인원') ?? 4,
      stack: i.options.getInteger('시작칩') ?? TN.START_STACK,
    });
  },

  async handleButton(i, { action, arg }) {
    if (action === 'again') {
      const [fee, bots, maxHumans, stack] = arg.split('.').map(Number);
      return open(i, { fee, bots, maxHumans, stack });
    }
    if (lobby.LOBBY_ACTIONS.includes(action)) return lobby.handleButton(i, action, arg);
    return route(i, action, arg);
  },
};
