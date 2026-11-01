/**
 * /그래프 — Crash. 자동 캐시아웃, 최근 폭발 기록, 지연 정산 정책.
 *
 * 정산 정책 (공개):
 *  - 수동 캐시아웃: 봇 서버가 버튼 이벤트를 받은 시각의 배수로 정산 (화면 갱신 지연과 무관)
 *  - 자동 캐시아웃: 목표 배수 ≤ 폭발 배수이면 정확히 목표 배수로 정산 (같은 배수면 캐시아웃 우선)
 *  - 배수는 0.80x에서 출발: 1.00x(본전) 전에 탈출하면 원금 일부만 돌려받음
 *  - 서버 재시작: 자동 캐시아웃 판은 시작 시점에 결과가 확정·선기록되어 그대로 정산,
 *               수동 판은 결과 미확정이므로 베팅 전액 환불
 */
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const sessions = require('../services/sessions');
const wallet = require('../services/wallet');
const settlement = require('../services/settlement');
const gameState = require('../services/gameState');
const stats = require('../services/stats');
const crash = require('../engine/crash');
const { LiveMessage } = require('../utils/liveMessage');
const { COLOR, chips, num, netText, ephemeral, busyText } = require('../utils/format');

const CR = config.CRASH;
const K = CR.GROWTH_PER_MS;
const START = CR.START_MULTIPLIER ?? 1;
const PREFIX = 'cr';
const cid = (uid, action) => `${PREFIX}:${uid}:${action}:`;

function graph(history, height = CR.GRAPH_HEIGHT) {
  const top = Math.max(2, ...history);
  const lt = Math.log(top / START);
  const levels = history.map((v) => Math.round((Math.log(Math.max(v, START) / START) / lt) * height));
  const even = Math.round((Math.log(1 / START) / lt) * height); // 본전(1.00x) 높이
  const rows = [];
  for (let r = height; r >= 1; r--) {
    const label = r === height ? `${top.toFixed(2)}x` : r === even ? '1.00x' : '';
    rows.push(`${label.padStart(7)} ┤${levels.map((l) => (l >= r ? (r <= even ? '▒' : '█') : r === even ? '┄' : ' ')).join('')}`);
  }
  rows.push(`${`${START.toFixed(2)}x`.padStart(7)} └${'─'.repeat(Math.max(history.length, 1))}`);
  return '```\n' + rows.join('\n') + '\n```';
}

function recentText(list) {
  if (!list.length) return '';
  return `🕘 최근 폭발: ${list.slice(0, CR.RECENT_HISTORY).map((x) => (x >= 2 ? `**${x.toFixed(2)}**` : x.toFixed(2))).join(' · ')}`;
}

function payload(s, { state, m, net = 0 }) {
  const elapsed = ((Date.now() - s.startAt) / 1000).toFixed(1);
  const lines = [];
  let color = COLOR.info;
  let title = '📈 그래프';
  if (state === 'running') {
    lines.push(`**🚀 ${m.toFixed(2)}x**`);
    lines.push(`⏱️ ${elapsed}s · 상승 속도 **+${crash.speedAt(m, K).toFixed(3)}x/s**`);
    lines.push(`💰 지금 탈출 시 **${chips(Math.floor(s.bet * m))}** (${netText(Math.floor(s.bet * m) - s.bet)})${m < 1 ? ' · ⚠️ 아직 본전 아래' : ''}`);
    if (s.autoTarget) lines.push(`🤖 자동 캐시아웃 **${s.autoTarget.toFixed(2)}x** 대기 중`);
  } else if (state === 'bust') {
    color = COLOR.lose;
    title = '💥 BUST!';
    lines.push(`**💥 ${s.crashPoint.toFixed(2)}x 에서 폭발**`);
    lines.push(`순손익 **${netText(net)}** · 잔고 ${chips(s.balanceAfter)}`);
  } else {
    color = m >= 1 ? COLOR.win : COLOR.push;
    title = s.autoHit ? '🤖 자동 캐시아웃 성공' : m >= 1 ? '💰 캐시아웃 성공' : '↘️ 조기 탈출';
    lines.push(`**${m >= 1 ? '✅' : '↘️'} ${m.toFixed(2)}x 탈출**${m < 1 ? ' (본전 전 탈출 — 일부만 회수)' : ''}`);
    lines.push(`이번 판 폭발 지점: **${s.crashPoint.toFixed(2)}x**`);
    lines.push(`순손익 **${netText(net)}** · 잔고 ${chips(s.balanceAfter)}`);
  }
  lines.push(graph(s.history.slice(-CR.GRAPH_POINTS)));
  if (state !== 'running') lines.push(recentText([s.crashPoint, ...s.recent]));
  else if (s.recent.length) lines.push(recentText(s.recent));

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${title} · 베팅 ${chips(s.bet)}`)
    .setDescription(lines.filter(Boolean).join('\n'))
    .setFooter({ text: `${START.toFixed(2)}x에서 시작 · 1.00x부터 이익 · 하우스 엣지 ${CR.HOUSE_EDGE * 100}% · 폭발 배수는 시작 시 결정 · 캐시아웃은 서버 수신 시각 기준` });
  const btn = new ButtonBuilder()
    .setCustomId(cid(s.userId, 'cashout'))
    .setLabel(state === 'running' ? `캐시아웃 (${num(s.bet * m)})` : '종료')
    .setEmoji('💰')
    .setStyle(state === 'running' ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setDisabled(state !== 'running');
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(btn)] };
}

async function finish(s, { payout, m }) {
  const net = payout - s.bet;
  const st = await settlement.finalize({
    userId: s.userId,
    guildId: s.guildId,
    roundId: s.roundId,
    payout,
    game: 'crash',
    gameId: s.gameId,
    channelId: s.channelId,
    inc: { crashRounds: 1 },
    max: m ? { crashMaxMultiplier: m } : {},
    wagered: s.bet,
    detail: { crashPoint: s.crashPoint, cashedAt: m ?? null, auto: s.autoTarget ?? null },
  });
  s.balanceAfter = st.ok ? st.balance : s.balance;
  gameState.transition(s.gameId, 'COMPLETED');
  return net;
}

async function bust(s) {
  if (s.state !== 'running') return;
  s.state = 'bust';
  sessions.end(s);
  s.history.push(s.crashPoint);
  const net = await finish(s, { payout: 0 });
  await s.live.final(payload(s, { state: 'bust', net })).catch(() => {});
}

async function cashout(s, m, auto = false) {
  if (s.state !== 'running') return;
  s.state = 'cashed';
  s.autoHit = auto;
  sessions.end(s);
  s.history.push(m);
  const net = await finish(s, { payout: Math.floor(s.bet * m), m });
  await s.live.final(payload(s, { state: 'cashed', m, net })).catch(() => {});
}

function tick(s) {
  if (s.state !== 'running') return;
  const now = Date.now();
  if (now >= s.crashAt) return;
  const m = Math.min(crash.multiplierAt(now - s.startAt, K, START), s.crashPoint);
  s.history.push(m);
  if (s.history.length > CR.GRAPH_POINTS * 2) s.history.splice(0, s.history.length - CR.GRAPH_POINTS);
  s.live.push(payload(s, { state: 'running', m }));
}

module.exports = {
  prefix: PREFIX,
  game: 'crash',
  data: new SlashCommandBuilder()
    .setName('그래프')
    .setDescription('0.80x에서 치솟는 배수가 터지기 전에 탈출하세요 (Crash)')
    .addIntegerOption((o) => o.setName('금액').setDescription('베팅 금액').setRequired(true).setMinValue(config.MIN_BET).setMaxValue(config.MAX_BET))
    .addNumberOption((o) => o.setName('자동캐시아웃').setDescription('이 배수에 도달하면 자동 탈출 (예: 2.0)').setMinValue(1.01).setMaxValue(CR.MAX_MULTIPLIER)),

  async execute(i) {
    const bet = i.options.getInteger('금액', true);
    const auto = i.options.getNumber('자동캐시아웃');
    const s = sessions.start(i.user.id, 'crash', { guildId: i.guildId, channelId: i.channelId, bet, gameId: i.id, state: 'init' });
    if (!s) return i.reply(ephemeral(busyText));
    await i.deferReply();

    await wallet.getAccount(i.user.id, i.guildId);
    const r = await wallet.reserve(i.user.id, i.guildId, 'crash', bet, { gameId: s.gameId });
    if (!r) {
      sessions.end(s);
      return i.editReply('잔고가 부족해요. `/잔고`로 확인해 보세요.');
    }
    s.roundId = r.roundId;
    s.balance = r.balance;
    s.crashPoint = crash.generateCrashPoint(CR.HOUSE_EDGE, CR.MAX_MULTIPLIER, START); // 폭발 배수 선 연산
    s.autoTarget = auto ? Math.floor(auto * 100) / 100 : null;
    s.recent = await stats.crashRecent(i.guildId, CR.RECENT_HISTORY).catch(() => []);
    s.history = [START];
    s.live = new LiveMessage((p) => i.editReply(p));

    // 자동 캐시아웃이면 결과가 지금 확정 → 선기록 (재시작해도 같은 결과로 정산)
    if (s.autoTarget) {
      const win = crash.autoCashoutWins(s.crashPoint, s.autoTarget);
      await settlement.commit({ userId: s.userId, guildId: s.guildId, roundId: s.roundId, payout: win ? Math.floor(bet * s.autoTarget) : 0, game: 'crash', detail: { crashPoint: s.crashPoint, cashedAt: win ? s.autoTarget : null, auto: s.autoTarget } });
    }

    s.startAt = Date.now();
    s.state = 'running';
    await i.editReply(payload(s, { state: 'running', m: START }));
    const msg = await i.fetchReply().catch(() => null);
    gameState.create({ gameId: s.gameId, game: 'crash', guildId: i.guildId, channelId: i.channelId, messageId: msg?.id, players: [i.user.id], state: 'PLAYING' });

    s.startAt = Date.now();
    s.crashAt = s.startAt + crash.timeToReach(s.crashPoint, K, START);
    const timers = [setInterval(() => tick(s), CR.TICK_MS), setTimeout(() => bust(s).catch(console.error), Math.max(0, s.crashAt - Date.now()))];
    if (s.autoTarget && crash.autoCashoutWins(s.crashPoint, s.autoTarget)) {
      const at = s.startAt + crash.timeToReach(s.autoTarget, K, START);
      // 목표 = 폭발 배수인 경우에도 캐시아웃이 먼저 처리되도록 1ms 앞당김
      timers.push(setTimeout(() => cashout(s, s.autoTarget, true).catch(console.error), Math.max(0, Math.min(at, s.crashAt - 1) - Date.now())));
    }
    s.cleanup = () => timers.forEach((t) => (clearInterval(t), clearTimeout(t)));
  },

  async handleButton(i) {
    const clickAt = Date.now(); // await 이전에 시각 고정
    const s = sessions.get(i.user.id);
    if (!s || s.game !== 'crash' || s.state !== 'running' || clickAt >= s.crashAt) return i.deferUpdate().catch(() => {});
    const m = Math.min(crash.multiplierAt(clickAt - s.startAt, K, START), s.crashPoint);
    const done = cashout(s, m); // 상태를 동기적으로 먼저 확정 (응답 대기 중 폭발 타이머와 경합 방지)
    await i.deferUpdate();
    await done;
  },
};
