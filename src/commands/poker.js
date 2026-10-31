/**
 * /포커페이스 — 봇 N명 + 사람 최대 M명이 함께하는 다자간 홀덤.
 *
 * 흐름: 슬래시 명령어(호스트) → 모집 로비(참가/나가기/시작/취소) → 게임 → 정산 → [같은 설정으로 새 테이블]
 * - 각 사람의 홀카드는 "참가" 때 받은 나만 보이는(ephemeral) 메시지에 자동으로 표시·갱신된다.
 * - 공용 버튼은 customId의 ownerId를 '*'로 두고, 차례·권한은 여기서 직접 검사한다.
 */
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const config = require('../config');
const sessions = require('../services/sessions');
const wallet = require('../services/wallet');
const poker = require('../engine/poker');
const { PokerTable } = require('../engine/pokerTable');
const { createDecks } = require('../engine/cards');
const { shuffle, randomInt } = require('../utils/rng');
const { LiveMessage } = require('../utils/liveMessage');
const { COLOR, chips, num, netText, handText, sleep, ephemeral, expired, busyText } = require('../utils/format');

const PK = config.POKER;
const PREFIX = 'pk';
const EXPOSURE = PokerTable.maxExposure(PK.MAX_BETS_PER_STREET, PK.RIVER_MULTIPLIER);
const pub = (action, tableId) => `${PREFIX}:*:${action}:${tableId}`;

/** 진행 중인 테이블: tableId → table */
const tables = new Map();

const KIND_LABEL = {
  value: '💪 밸류 (진짜 패)',
  semibluff: '🎯 세미블러핑 (드로우)',
  bluff: '🎭 블러핑 (뻥카)',
  slowplay: '🪤 슬로우플레이 (강한 패로 체크)',
};
const ACTION_TEXT = { fold: '🏳️ 다이', check: '✋ 체크', call: '📞 콜', bet: '💰 베팅', raise: '⬆️ 레이즈' };

const displayName = (i) => i.member?.displayName ?? i.user.globalName ?? i.user.username;
const seatCount = (t) => t.humans.length + t.bots;
const unixIn = (ms) => Math.floor((Date.now() + ms) / 1000);

async function runExclusive(t, fn) {
  if (t.busy) return false;
  t.busy = true;
  try {
    await fn();
    return true;
  } catch (err) {
    console.error('[poker table]', err);
    return false;
  } finally {
    t.busy = false;
  }
}

// ───────────────────────────── 화면 ─────────────────────────────

function lobbyPayload(t, note = '', { closed = false } = {}) {
  const full = t.humans.length >= t.maxHumans;
  const embed = new EmbedBuilder()
    .setColor(closed ? COLOR.push : COLOR.info)
    .setTitle('🎭 포커페이스 테이블 모집')
    .setDescription(
      [
        `앤티 **${chips(t.ante)}** · 참가 조건: 잔고 **${chips(t.ante * EXPOSURE)}** 이상 (최대 손실 앤티 × ${EXPOSURE})`,
        `🧑 사람 **${t.humans.length}/${t.maxHumans}** · 🤖 봇 **${t.bots}**`,
        '',
        t.humans.map((h, k) => `\`${k + 1}\` 🧑 ${h.name}${h.id === t.hostId ? ' 👑' : ''}`).join('\n'),
        t.bots ? `🤖 봇 ${t.bots}명 대기 중 (성향은 게임이 끝나면 공개)` : '',
        '',
        note || `⏳ <t:${t.lobbyEndsAt}:R> 자동 시작 (2좌석 이상일 때) · 👑 호스트는 바로 시작 가능`,
      ]
        .filter((x, k, a) => x !== '' || a[k - 1] !== '')
        .join('\n'),
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(pub('join', t.id)).setLabel('참가').setEmoji('🙋').setStyle(ButtonStyle.Success).setDisabled(closed || full),
    new ButtonBuilder().setCustomId(pub('leave', t.id)).setLabel('나가기').setEmoji('🚪').setStyle(ButtonStyle.Secondary).setDisabled(closed),
    new ButtonBuilder().setCustomId(pub('start', t.id)).setLabel('시작').setEmoji('▶️').setStyle(ButtonStyle.Primary).setDisabled(closed),
    new ButtonBuilder().setCustomId(pub('cancel', t.id)).setLabel('취소').setEmoji('✖️').setStyle(ButtonStyle.Danger).setDisabled(closed),
  );
  return { embeds: [embed], components: [row] };
}

function logLines(t, final) {
  return t.log
    .slice(final ? -14 : -8)
    .map((e) => {
      let line = e.street ? `\`${e.street}\` ${e.text}` : e.text;
      if (final && e.kind && KIND_LABEL[e.kind]) line += ` → ${KIND_LABEL[e.kind]} · 당시 승률 ${(e.equity * 100).toFixed(0)}%`;
      return line;
    })
    .join('\n');
}

function seatLines(t, final) {
  const e = t.engine;
  const showdown = t.endReason === 'showdown';
  return e.seats
    .map((s, i) => {
      const r = final ? e.results[i] : null;
      const turn = !final && e.actor === i ? '▶' : '　';
      const icon = s.type === 'bot' ? '🤖' : '🧑';
      const dealerBtn = i === e.button ? ' 🔘' : '';
      let line = `${turn}\`${i + 1}\` ${icon} **${s.name}**${dealerBtn} · 누적 ${num(s.totalIn)}`;
      if (s.folded) line += ' · 🏳️ 다이';
      else if (!final) line += ` · 이번 ${num(s.streetIn)}`;

      if (final) {
        const showCards = s.type === 'bot' ? !s.folded || PK.REVEAL_FOLDED_BOTS : !s.folded && showdown;
        if (showCards) line += ` ${handText(s.hole)}`;
        if (showdown && !s.folded) line += ` \`${r.hand.name}\``;
        line += ` → ${r.winner ? '🏆 ' : ''}**${netText(r.net)}**`;
        if (s.type === 'bot') line += `\n　　└ ${s.style.label}`;
      }
      return line;
    })
    .join('\n');
}

function tablePayload(t, prompt, { final = false } = {}) {
  const e = t.engine;
  const hiddenBoard = [0, 1, 2, 3, 4].filter((n) => n >= e.revealed);
  const desc = [
    `🂠 **보드** ${handText(e.board, hiddenBoard)}`,
    `💰 팟 **${num(e.pot)}** · ${e.street} 단위 ${num(e.unit)} · 레이즈 ${e.betsThisStreet}/${e.maxBets}`,
    '',
    '💺 **좌석**',
    seatLines(t, final),
    '',
    `📜 **로그**${final ? ' (봇 의도 공개)' : ''}`,
    logLines(t, final),
    '',
    prompt,
  ]
    .filter((x) => x !== undefined && x !== null)
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor(final ? COLOR.gold : COLOR.table)
    .setTitle(`🎭 포커페이스 · 앤티 ${chips(t.ante)} · ${final ? '종료' : e.street}`)
    .setDescription(desc.slice(0, 4096))
    .setFooter({ text: `플롭·턴 1단위, 리버 ${PK.RIVER_MULTIPLIER}단위 · 스트리트당 베팅 최대 ${PK.MAX_BETS_PER_STREET}회 · 🔘 = 버튼` });

  if (final) {
    const again = new ButtonBuilder()
      .setCustomId(`${PREFIX}:${t.hostId}:again:${t.ante}.${t.bots}.${t.maxHumans}`)
      .setLabel('같은 설정으로 새 테이블 (호스트)')
      .setEmoji('🔁')
      .setStyle(ButtonStyle.Primary);
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(again)] };
  }

  const idx = e.actor;
  const lg = idx !== null ? e.legal(idx) : { toCall: 0, canRaise: false, raiseCost: 0, isOpen: true };
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(pub('call', t.id))
      .setLabel(lg.toCall > 0 ? `콜 ${num(lg.toCall)}` : '체크')
      .setEmoji('📞')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(pub('raise', t.id))
      .setLabel(`${lg.isOpen ? '베팅' : '레이즈'} ${num(lg.raiseCost)}`)
      .setEmoji('⬆️')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!lg.canRaise),
    new ButtonBuilder().setCustomId(pub('fold', t.id)).setLabel('다이').setEmoji('🏳️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(pub('hand', t.id)).setLabel('내 패').setEmoji('🃏').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

/** 나만 보이는 메시지에 들어갈 내 패 정보 */
function privateText(t, idx) {
  const e = t.engine;
  const s = e.seats[idx];
  const cur = poker.evaluate([...s.hole, ...e.visibleBoard]);
  let txt = `🃏 **내 패** ${handText(s.hole)}\n🂠 보드 ${handText(e.visibleBoard)}\n현재 족보: **${cur.name}** (${e.street})`;
  if (s.folded) txt += '\n🏳️ 이번 판은 다이했습니다.';
  if (e.finished) {
    const r = e.results[idx];
    txt += `\n\n${r.winner ? '🏆 승리' : '결과'} · 순손익 **${netText(r.net)}**`;
  }
  return { content: txt };
}

function updatePrivates(t) {
  t.engine.seats.forEach((s, idx) => {
    if (s.type === 'human' && s.privateEdit) {
      s.privateEdit(privateText(t, idx)).catch(() => {}); // 토큰 만료 등은 무시 ([내 패] 버튼으로 대체 가능)
    }
  });
}

// ───────────────────────────── 진행 ─────────────────────────────

async function openTable(i, { ante, bots, maxHumans }) {
  if (bots + maxHumans > PK.MAX_SEATS) return i.reply(ephemeral(`봇 + 최대 인원은 ${PK.MAX_SEATS}명 이하여야 해요.`));
  if (bots + maxHumans < 2) return i.reply(ephemeral('봇이 0명이면 최대 인원을 2명 이상으로 정해 주세요.'));

  const marker = sessions.start(i.user.id, 'poker', {});
  if (!marker) return i.reply(ephemeral(busyText));
  await i.deferReply();

  const account = await wallet.getAccount(i.user.id, i.guildId);
  if (account.money < ante * EXPOSURE) {
    sessions.end(marker);
    return i.editReply(`테이블을 열려면 잔고가 ${chips(ante * EXPOSURE)} 이상 필요해요. (현재 ${chips(account.money)})`);
  }

  const t = {
    id: i.id,
    guildId: i.guildId,
    hostId: i.user.id,
    ante,
    bots,
    maxHumans,
    state: 'lobby',
    ui: i,
    busy: false,
    humans: [],
    log: [],
    lobbyEndsAt: unixIn(PK.LOBBY_MS),
  };
  marker.tableId = t.id;
  t.live = new LiveMessage((p) => t.ui.editReply(p));
  tables.set(t.id, t);

  const host = { id: i.user.id, name: displayName(i), marker, privateEdit: null };
  t.humans.push(host);

  const solo = maxHumans === 1;
  await i.editReply(lobbyPayload(t, solo ? '🃏 딜링 중...' : ''));

  // 호스트용 비공개 메시지 (게임 시작 시 내 패로 갱신)
  try {
    const msg = await i.followUp({ content: '🃏 게임이 시작되면 이 메시지에 내 패가 표시됩니다. (나에게만 보임)', flags: MessageFlags.Ephemeral });
    host.privateEdit = (p) => i.webhook.editMessage(msg, p);
  } catch (err) {
    console.warn('[poker] 호스트 비공개 메시지 실패:', err.message);
  }

  if (solo) return runExclusive(t, () => startGame(t));
  t.lobbyTimer = setTimeout(() => runExclusive(t, () => lobbyTimeout(t)), PK.LOBBY_MS);
}

async function lobbyTimeout(t) {
  if (t.state !== 'lobby') return;
  if (seatCount(t) < 2) return cancelTable(t, '⌛ 인원이 모이지 않아 테이블이 취소되었습니다.');
  return startGame(t);
}

async function cancelTable(t, reason) {
  t.state = 'done';
  clearTimeout(t.lobbyTimer);
  for (const h of t.humans) sessions.end(h.marker);
  tables.delete(t.id);
  await t.live.final(lobbyPayload(t, reason, { closed: true })).catch(() => {});
}

async function startGame(t) {
  if (t.state !== 'lobby') return;
  clearTimeout(t.lobbyTimer);
  t.state = 'playing';

  const styleKeys = Object.keys(poker.BOT_STYLES);
  const seats = [
    ...t.humans.map((h) => ({ type: 'human', id: h.id, name: h.name, privateEdit: h.privateEdit })),
    ...Array.from({ length: t.bots }, (_, k) => ({
      type: 'bot',
      id: `bot${k}`,
      name: `봇 ${PK.BOT_NAMES[k] ?? k + 1}`,
      style: poker.BOT_STYLES[styleKeys[randomInt(0, styleKeys.length)]],
    })),
  ];

  const e = new PokerTable({ ante: t.ante, maxBetsPerStreet: PK.MAX_BETS_PER_STREET, riverMultiplier: PK.RIVER_MULTIPLIER });
  shuffle(seats).forEach((s) => e.addSeat(s));
  e.start(shuffle(createDecks(1)), randomInt(0, seats.length));
  t.engine = e;
  t.log.push({ text: `🂠 앤티 ${num(t.ante)} × ${seats.length}명 · **플롭** 오픈` });

  updatePrivates(t);
  await drive(t);
}

/** 봇 차례는 연속으로 자동 진행, 사람 차례가 오면 화면을 그리고 대기 */
async function drive(t) {
  const e = t.engine;
  while (!e.finished) {
    const idx = e.actor;
    const seat = e.seats[idx];

    if (seat.type === 'human') {
      t.live.push(tablePayload(t, `👉 **${seat.name}** 님 차례 · <t:${unixIn(PK.TURN_MS)}:R> 자동 처리`));
      armTurnTimer(t, idx);
      return;
    }

    t.live.push(tablePayload(t, `🤖 **${seat.name}** 생각 중...`));
    await sleep(PK.BOT_THINK_MS);
    const lg = e.legal(idx);
    const opponents = e.activeIndexes.length - 1;
    const a = poker.analyze(seat.hole, e.visibleBoard, opponents, PK.SIMULATIONS);
    const d = poker.botDecide(a, { opponents, toCall: lg.toCall, pot: e.pot, canRaise: lg.canRaise, street: e.street }, seat.style);
    await apply(t, idx, d.act, { kind: d.kind, equity: a.equity });
  }
  await finishGame(t);
}

async function apply(t, idx, act, meta = {}) {
  const e = t.engine;
  const seat = e.seats[idx];
  const street = e.street;
  const ev = e.act(idx, act);
  if (ev.type === 'end') t.endReason = ev.reason;

  const amount = ev.amount ? ` ${num(ev.amount)}` : '';
  const revealKind = seat.type === 'bot' && (['bet', 'raise'].includes(ev.action) || meta.kind === 'slowplay');
  t.log.push({
    street,
    text: `${seat.type === 'bot' ? '🤖' : '🧑'} ${seat.name} ${ACTION_TEXT[ev.action]}${amount}`,
    kind: revealKind ? meta.kind : null,
    equity: meta.equity,
  });

  if (ev.type === 'street') {
    t.log.push({ street: ev.street, text: `🂠 **${ev.street}** 오픈` });
    updatePrivates(t);
    t.live.push(tablePayload(t, `🂠 **${ev.street}** 카드가 열렸습니다!`));
    await sleep(PK.STREET_PAUSE_MS);
  }
  return ev;
}

function armTurnTimer(t, idx) {
  clearTimeout(t.turnTimer);
  t.turnTimer = setTimeout(() => {
    runExclusive(t, async () => {
      const e = t.engine;
      if (e.finished || e.actor !== idx) return;
      const act = e.legal(idx).toCall === 0 ? 'check' : 'fold';
      t.log.push({ street: e.street, text: `⏱️ ${e.seats[idx].name} 시간 초과` });
      await apply(t, idx, act);
      await drive(t);
    });
  }, PK.TURN_MS);
}

async function finishGame(t) {
  clearTimeout(t.turnTimer);
  t.state = 'done';
  const e = t.engine;

  await Promise.all(
    e.seats.map(async (s, idx) => {
      if (s.type !== 'human') return;
      const r = e.results[idx];
      try {
        await wallet.settle(s.id, t.guildId, r.net, {
          inc: { pokerHands: 1, ...(r.winner && r.net > 0 ? { pokerWins: 1 } : {}) },
          wagered: s.totalIn,
        });
      } catch (err) {
        console.error(`[poker settle] ${s.id}`, err);
      }
    }),
  );
  for (const h of t.humans) sessions.end(h.marker);
  tables.delete(t.id);

  const winners = e.results.map((r, i) => (r.winner ? e.seats[i].name : null)).filter(Boolean);
  const summary =
    t.endReason === 'fold'
      ? `🏆 **${winners[0]}** 님이 팟 **${num(e.pot)}** 획득 (나머지 전원 다이)`
      : `🏆 쇼다운 승자: **${winners.join(', ')}** · 팟 **${num(e.pot)}**${winners.length > 1 ? ' (분할)' : ''}`;

  updatePrivates(t);
  await t.live.final(tablePayload(t, summary, { final: true })).catch((err) => console.error('[poker final]', err));
}

// ───────────────────────────── 버튼 ─────────────────────────────

async function join(i, t) {
  if (t.state !== 'lobby') return i.reply(ephemeral('이미 시작된 테이블이에요.'));
  if (t.humans.some((h) => h.id === i.user.id)) return i.reply(ephemeral('이미 참가했어요.'));
  if (t.humans.length >= t.maxHumans) return i.reply(ephemeral('자리가 꽉 찼어요.'));

  const marker = sessions.start(i.user.id, 'poker', { tableId: t.id });
  if (!marker) return i.reply(ephemeral(busyText));
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const account = await wallet.getAccount(i.user.id, i.guildId);
  if (account.money < t.ante * EXPOSURE) {
    sessions.end(marker);
    return i.editReply(`참가하려면 잔고가 ${chips(t.ante * EXPOSURE)} 이상 필요해요. (현재 ${chips(account.money)})`);
  }
  if (t.state !== 'lobby' || t.humans.length >= t.maxHumans) {
    sessions.end(marker);
    return i.editReply('그 사이에 자리가 찼거나 게임이 시작됐어요.');
  }

  t.humans.push({ id: i.user.id, name: displayName(i), marker, privateEdit: (p) => i.editReply(p) });
  await i.editReply('✅ 참가 완료! 게임이 시작되면 이 메시지에 내 패가 표시됩니다. (나에게만 보임)');

  if (t.humans.length >= t.maxHumans) return runExclusive(t, () => startGame(t)); // 만석이면 바로 시작
  t.live.push(lobbyPayload(t));
}

async function leave(i, t) {
  if (t.state !== 'lobby') return i.reply(ephemeral('게임 중에는 나갈 수 없어요. 다이 버튼을 사용하세요.'));
  if (i.user.id === t.hostId) return i.reply(ephemeral('호스트는 취소 버튼을 사용하세요.'));
  const k = t.humans.findIndex((h) => h.id === i.user.id);
  if (k < 0) return i.reply(ephemeral('참가하지 않은 테이블이에요.'));
  const [h] = t.humans.splice(k, 1);
  sessions.end(h.marker);
  await i.reply(ephemeral('🚪 테이블에서 나왔어요.'));
  t.live.push(lobbyPayload(t));
}

async function hostControl(i, t, action) {
  if (i.user.id !== t.hostId) return i.reply(ephemeral('👑 호스트만 할 수 있어요.'));
  if (t.state !== 'lobby') return i.deferUpdate();
  if (action === 'start' && seatCount(t) < 2) return i.reply(ephemeral('최소 2좌석(사람 + 봇)이 필요해요.'));
  await i.deferUpdate();
  t.ui = i;
  if (action === 'cancel') return runExclusive(t, () => cancelTable(t, '✖️ 호스트가 테이블을 취소했습니다.'));
  return runExclusive(t, () => startGame(t));
}

function showHand(i, t) {
  if (t.state !== 'playing') return i.reply(ephemeral('아직 카드가 배분되지 않았어요.'));
  const idx = t.engine.seats.findIndex((s) => s.type === 'human' && s.id === i.user.id);
  if (idx < 0) return i.reply(ephemeral('이 테이블 참가자가 아니에요.'));
  return i.reply({ ...privateText(t, idx), flags: MessageFlags.Ephemeral });
}

async function humanAction(i, t, act) {
  if (t.state !== 'playing') return i.reply(ephemeral('진행 중인 게임이 아니에요.'));
  const e = t.engine;
  const idx = e.actor;
  const seat = idx !== null ? e.seats[idx] : null;
  if (!seat || seat.type !== 'human' || seat.id !== i.user.id) {
    const seated = e.seats.some((s) => s.type === 'human' && s.id === i.user.id);
    return i.reply(ephemeral(seated ? `지금은 **${seat?.name ?? '-'}** 님 차례예요.` : '이 테이블 참가자가 아니에요.'));
  }
  if (t.busy) return i.deferUpdate();
  await i.deferUpdate();
  t.ui = i; // 가장 최근 토큰으로 테이블 메시지 편집
  await runExclusive(t, async () => {
    if (e.finished || e.actor !== idx) return;
    clearTimeout(t.turnTimer);
    await apply(t, idx, act);
    await drive(t);
  });
}

module.exports = {
  prefix: PREFIX,
  data: new SlashCommandBuilder()
    .setName('포커페이스')
    .setDescription('봇·유저가 함께하는 다자간 홀덤 — 블러핑을 판독하세요')
    .addIntegerOption((o) =>
      o.setName('금액').setDescription(`앤티 (참가자 잔고가 앤티 × ${EXPOSURE} 이상 필요)`).setRequired(true).setMinValue(config.MIN_BET).setMaxValue(config.MAX_BET),
    )
    .addIntegerOption((o) => o.setName('봇').setDescription(`AI 봇 수 (0~${PK.MAX_BOTS}, 기본 1)`).setMinValue(0).setMaxValue(PK.MAX_BOTS))
    .addIntegerOption((o) =>
      o.setName('최대인원').setDescription(`사람 최대 인원, 나 포함 (1~${PK.MAX_HUMANS}, 기본 1 = 혼자 봇과 대결)`).setMinValue(1).setMaxValue(PK.MAX_HUMANS),
    ),

  async execute(i) {
    return openTable(i, {
      ante: i.options.getInteger('금액', true),
      bots: i.options.getInteger('봇') ?? 1,
      maxHumans: i.options.getInteger('최대인원') ?? 1,
    });
  },

  async handleButton(i, { action, arg }) {
    if (action === 'again') {
      const [ante, bots, maxHumans] = arg.split('.').map(Number);
      return openTable(i, { ante, bots, maxHumans });
    }
    const t = tables.get(arg);
    if (!t) return expired(i);
    switch (action) {
      case 'join':
        return join(i, t);
      case 'leave':
        return leave(i, t);
      case 'start':
      case 'cancel':
        return hostControl(i, t, action);
      case 'hand':
        return showHand(i, t);
      case 'call':
      case 'raise':
      case 'fold':
        return humanAction(i, t, action);
      default:
        return undefined;
    }
  },
};
