const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const sessions = require('../services/sessions');
const wallet = require('../services/wallet');
const crash = require('../engine/crash');
const { LiveMessage } = require('../utils/liveMessage');
const { COLOR, chips, num, netText, ephemeral, busyText } = require('../utils/format');

const CR = config.CRASH;
const K = CR.GROWTH_PER_MS;
const PREFIX = 'cr';
const cid = (uid, action) => `${PREFIX}:${uid}:${action}:`;

/** 로그 스케일 막대 그래프 (코드 블록) */
function graph(history, height = CR.GRAPH_HEIGHT) {
  const top = Math.max(2, ...history);
  const lt = Math.log(top);
  const levels = history.map((v) => Math.round((Math.log(v) / lt) * height));
  const rows = [];
  for (let r = height; r >= 1; r--) {
    const label = r === height ? `${top.toFixed(2)}x`.padStart(7) : ' '.repeat(7);
    rows.push(`${label} ┤${levels.map((l) => (l >= r ? '█' : ' ')).join('')}`);
  }
  rows.push(`${'1.00x'.padStart(7)} └${'─'.repeat(Math.max(history.length, 1))}`);
  return '```\n' + rows.join('\n') + '\n```';
}

function payload(s, { state, m, net = 0 }) {
  const elapsed = ((Date.now() - s.startAt) / 1000).toFixed(1);
  const lines = [];
  let color = COLOR.info;
  let title = '📈 그래프';

  if (state === 'running') {
    lines.push(`**🚀 ${m.toFixed(2)}x**`);
    lines.push(`⏱️ ${elapsed}s · 상승 속도 **+${crash.speedAt(m, K).toFixed(3)}x/s**`);
    lines.push(`💰 지금 탈출 시 **${chips(Math.floor(s.bet * m))}**`);
  } else if (state === 'bust') {
    color = COLOR.lose;
    title = '💥 BUST!';
    lines.push(`**💥 ${s.crashPoint.toFixed(2)}x 에서 폭발**`);
    lines.push(`순손익 **${netText(net)}** · 잔고 ${chips(s.balanceAfter)}`);
  } else {
    color = COLOR.win;
    title = '💰 캐시아웃 성공';
    lines.push(`**✅ ${m.toFixed(2)}x 탈출**`);
    lines.push(`이번 판 폭발 지점: **${s.crashPoint.toFixed(2)}x**`);
    lines.push(`순손익 **${netText(net)}** · 잔고 ${chips(s.balanceAfter)}`);
  }
  lines.push(graph(s.history.slice(-CR.GRAPH_POINTS)));

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${title} · 베팅 ${chips(s.bet)}`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `하우스 엣지 ${CR.HOUSE_EDGE * 100}% · 폭발 배수는 시작 시 결정됨` });

  const btn = new ButtonBuilder()
    .setCustomId(cid(s.userId, 'cashout'))
    .setLabel(state === 'running' ? `캐시아웃 (${num(s.bet * m)})` : '종료')
    .setEmoji('💰')
    .setStyle(state === 'running' ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setDisabled(state !== 'running');
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(btn)] };
}

async function bust(s) {
  if (s.state !== 'running') return;
  s.state = 'bust';
  sessions.end(s); // cleanup → 타이머 정리
  s.history.push(s.crashPoint);
  const st = await wallet
    .settleRound(s.userId, s.roundId, 0, {
      game: 'crash',
      guildId: s.guildId,
      inc: { crashRounds: 1 },
      wagered: s.bet,
      detail: { crashPoint: s.crashPoint, cashedAt: null },
    })
    .catch((e) => {
      console.error('[crash settle]', e);
      return { ok: false };
    });
  s.balanceAfter = st.ok ? st.balance : s.balance;
  await s.live.final(payload(s, { state: 'bust', net: -s.bet })).catch(() => {});
}

function tick(s) {
  if (s.state !== 'running') return;
  const now = Date.now();
  if (now >= s.crashAt) return; // 폭발 처리는 bust 타이머가 담당
  const m = Math.min(crash.multiplierAt(now - s.startAt, K), s.crashPoint);
  s.history.push(m);
  if (s.history.length > CR.GRAPH_POINTS * 2) s.history.splice(0, s.history.length - CR.GRAPH_POINTS);
  s.live.push(payload(s, { state: 'running', m }));
}

module.exports = {
  prefix: PREFIX,
  data: new SlashCommandBuilder()
    .setName('그래프')
    .setDescription('치솟는 배수가 터지기 전에 탈출하세요 (Crash)')
    .addIntegerOption((o) =>
      o.setName('금액').setDescription('베팅 금액').setRequired(true).setMinValue(config.MIN_BET).setMaxValue(config.MAX_BET),
    ),

  async execute(i) {
    const bet = i.options.getInteger('금액', true);
    const s = sessions.start(i.user.id, 'crash', { guildId: i.guildId, bet, state: 'init' });
    if (!s) return i.reply(ephemeral(busyText));
    await i.deferReply();

    const account = await wallet.getAccount(i.user.id, i.guildId);
    const r = await wallet.reserve(i.user.id, i.guildId, 'crash', bet);
    if (!r) {
      sessions.end(s);
      return i.editReply(`잔고가 부족해요. (현재 ${chips(account.money)})`);
    }
    s.roundId = r.roundId;

    // 폭발 배수 선 연산 — 이후 어떤 입력도 이 값을 바꾸지 않는다
    s.crashPoint = crash.generateCrashPoint(CR.HOUSE_EDGE, CR.MAX_MULTIPLIER);
    s.balance = r.balance;
    s.history = [1];
    s.live = new LiveMessage((p) => i.editReply(p));
    s.startAt = Date.now();
    s.crashAt = s.startAt + crash.timeToReach(s.crashPoint, K);
    s.state = 'running';

    await i.editReply(payload(s, { state: 'running', m: 1 }));
    s.startAt = Date.now(); // 첫 화면이 뜬 시점부터 상승 시작
    s.crashAt = s.startAt + crash.timeToReach(s.crashPoint, K);

    const ticker = setInterval(() => tick(s), CR.TICK_MS);
    const bustTimer = setTimeout(() => bust(s).catch(console.error), Math.max(0, s.crashAt - Date.now()));
    s.cleanup = () => {
      clearInterval(ticker);
      clearTimeout(bustTimer);
    };
  },

  async handleButton(i) {
    const clickAt = Date.now(); // await 이전에 시각 고정 (네트워크 지연이 유저에게 불리하지 않도록)
    const s = sessions.get(i.user.id);
    if (!s || s.game !== 'crash' || s.state !== 'running' || clickAt >= s.crashAt) {
      return i.deferUpdate().catch(() => {});
    }
    s.state = 'cashed'; // 동기적으로 상태 확정 → bust와 경합 불가
    sessions.end(s);

    const m = Math.min(crash.multiplierAt(clickAt - s.startAt, K), s.crashPoint);
    const payout = Math.floor(s.bet * m);
    const net = payout - s.bet;
    s.history.push(m);

    await i.deferUpdate();
    const st = await wallet.settleRound(s.userId, s.roundId, payout, {
      game: 'crash',
      guildId: s.guildId,
      inc: { crashRounds: 1 },
      max: { crashMaxMultiplier: m },
      wagered: s.bet,
      detail: { crashPoint: s.crashPoint, cashedAt: m },
    });
    s.balanceAfter = st.ok ? st.balance : s.balance;
    await s.live.final(payload(s, { state: 'cashed', m, net }));
  },
};
