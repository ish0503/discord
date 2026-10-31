/** /슬롯 — 가중치 3릴 슬롯 + 연속 스핀 + 프로그레시브 잭팟 + 슬롯 테마 */
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const sessions = require('../services/sessions');
const wallet = require('../services/wallet');
const settlement = require('../services/settlement');
const gameState = require('../services/gameState');
const jackpot = require('../services/jackpot');
const profile = require('../services/profile');
const slot = require('../engine/slot');
const cosmetics = require('../content/cosmetics');
const { COLOR, chips, num, netText, netColor, sleep, ephemeral, expired, busyText } = require('../utils/format');

const SL = config.SLOT;
const PREFIX = 'sl';
const cid = (uid, action, arg = '') => `${PREFIX}:${uid}:${action}:${arg}`;
const BLANK = '🎰';

const sym = (s, e) => (e === BLANK ? BLANK : cosmetics.slotSymbol(e, s.cos.slotTheme));
const paytableText = (s) =>
  Object.entries(SL.PAYTABLE.triple)
    .reverse()
    .map(([e, m]) => `${sym(s, e).repeat(3)} ×${m}`)
    .join(' · ') + ` · ${sym(s, '🍒').repeat(2)} ×${SL.PAYTABLE.twoCherry}`;

function rows(s, { spinning = false, ended = false } = {}) {
  if (s.auto && !ended) {
    return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(cid(s.userId, 'stopauto')).setLabel(`자동 정지 (${s.auto.done}/${s.auto.total})`).setEmoji('⏹️').setStyle(ButtonStyle.Danger))];
  }
  const off = spinning || ended;
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(cid(s.userId, 'spin')).setLabel(`스핀 (${num(s.bet)})`).setEmoji('🎰').setStyle(ButtonStyle.Success).setDisabled(off),
      ...SL.AUTO_SPIN_OPTIONS.map((n) => new ButtonBuilder().setCustomId(cid(s.userId, 'auto', n)).setLabel(`×${n}`).setEmoji('🔁').setStyle(ButtonStyle.Primary).setDisabled(off)),
      new ButtonBuilder().setCustomId(cid(s.userId, 'stop')).setLabel('그만').setStyle(ButtonStyle.Secondary).setDisabled(off),
    ),
  ];
}

function payload(s, reels, { result = null, spinning = false, ended = false } = {}) {
  const sess = s.session;
  const embed = new EmbedBuilder()
    .setColor(cosmetics.color(s.cos.color, result ? netColor(result.net) : COLOR.gold))
    .setTitle('🎰 슬롯머신')
    .setDescription(
      [
        `💰 **잭팟 풀 ${chips(s.pool ?? 0)}** — ${sym(s, SL.JACKPOT_SYMBOL).repeat(3)} 당첨 시 ×${SL.PAYTABLE.triple[SL.JACKPOT_SYMBOL]} + 풀 전액`,
        '',
        `**[ ${reels.map((e) => sym(s, e)).join(' | ')} ]**`,
        result ? `**${result.label}** — 순손익 **${netText(result.net)}**` : spinning ? '릴이 돌아갑니다...' : '버튼을 눌러 스핀!',
        '',
        `💼 잔고 ${chips(s.balance)} · 베팅 ${chips(s.bet)}`,
        `📊 이번 세션 ${num(sess.spins)}회 · 당첨 ${num(sess.wins)}회 · 순손익 **${netText(sess.net)}**${sess.best ? ` · 최고 ${chips(sess.best)}` : ''}`,
      ].join('\n'),
    )
    .setFooter({ text: `${paytableText(s)} · 잭팟 풀은 베팅의 ${SL ? config.JACKPOT.CONTRIBUTION * 100 : 1}%를 하우스가 적립` });
  return { embeds: [embed], components: rows(s, { spinning, ended }) };
}

/** 한 번 스핀. 잔고 부족이면 false */
async function spinOnce(s) {
  const r = await wallet.reserve(s.userId, s.guildId, 'slot', s.bet, { gameId: s.gameId });
  if (!r) return false;
  s.balance = r.balance;
  jackpot.contribute(s.guildId, s.bet).catch(() => {});

  // 결과 선 연산 → 선기록 → 연출 → 정산
  const reels = slot.spin(SL.SYMBOLS);
  const ev = slot.evaluate(reels, SL.PAYTABLE);
  let pool = 0;
  if (reels.every((e) => e === SL.JACKPOT_SYMBOL)) pool = await jackpot.take(s.guildId, s.userId);
  const payout = Math.floor(s.bet * ev.multiplier) + pool;
  await settlement.commit({ userId: s.userId, guildId: s.guildId, roundId: r.roundId, payout, game: 'slot', detail: { reels } });

  const frame = [BLANK, BLANK, BLANK];
  const fast = Boolean(s.auto);
  await s.ui.editReply(payload(s, frame, { spinning: true }));
  for (let k = 0; k < 3; k++) {
    await sleep(fast ? SL.REEL_DELAY_MS / 2 : SL.REEL_DELAY_MS);
    frame[k] = reels[k];
    if (k < 2) await s.ui.editReply(payload(s, frame, { spinning: true }));
  }

  const st = await settlement.finalize({
    userId: s.userId,
    guildId: s.guildId,
    roundId: r.roundId,
    payout,
    game: 'slot',
    gameId: s.gameId,
    channelId: s.channelId,
    inc: { slotSpins: 1, ...(pool ? { jackpots: 1 } : {}) },
    max: { slotBestWin: payout },
    wagered: s.bet,
    detail: { reels, multiplier: ev.multiplier, jackpot: pool },
  });
  if (st.ok) s.balance = st.balance;
  const net = payout - s.bet;
  Object.assign(s.session, { spins: s.session.spins + 1, wins: s.session.wins + (net > 0 ? 1 : 0), net: s.session.net + net, best: Math.max(s.session.best, payout) });
  if (pool) s.pool = config.JACKPOT.SEED;
  else s.pool = (s.pool ?? 0) + Math.floor(s.bet * config.JACKPOT.CONTRIBUTION);
  const label = pool ? `🎉🎉 JACKPOT! 풀 ${chips(pool)} 획득!` : ev.multiplier >= 50 ? `🎉 대박! ${ev.label}` : ev.label;
  await s.ui.editReply(payload(s, reels, { result: { net, label } }));
  return true;
}

async function autoSpin(s, n) {
  s.auto = { total: n, done: 0, stop: false };
  while (s.auto.done < n && !s.auto.stop && !s.ended) {
    if (!(await spinOnce(s))) {
      await s.ui.followUp(ephemeral('잔고가 부족해 자동 스핀을 멈췄어요.')).catch(() => {});
      break;
    }
    s.auto.done += 1;
    if (s.auto.done < n && !s.auto.stop) await sleep(SL.AUTO_SPIN_GAP_MS);
  }
  s.auto = null;
  await s.ui.editReply(payload(s, ['✅', '✅', '✅'], { result: { net: s.session.net, label: '자동 스핀 종료 (세션 합계)' } }));
}

module.exports = {
  prefix: PREFIX,
  game: 'slot',
  data: new SlashCommandBuilder()
    .setName('슬롯')
    .setDescription('3릴 슬롯머신 — 연속 스핀 · 프로그레시브 잭팟')
    .addIntegerOption((o) => o.setName('금액').setDescription('1회 스핀 금액').setRequired(true).setMinValue(config.MIN_BET).setMaxValue(config.MAX_BET)),

  async execute(i) {
    const bet = i.options.getInteger('금액', true);
    const s = sessions.start(i.user.id, 'slot', { guildId: i.guildId, channelId: i.channelId, bet, gameId: i.id, session: { spins: 0, wins: 0, net: 0, best: 0 } }, {
      onTimeout: async (x) => {
        sessions.end(x);
        gameState.transition(x.gameId, 'COMPLETED', 'idle');
        await x.ui.editReply(payload(x, [BLANK, BLANK, BLANK], { ended: true })).catch(() => {});
      },
    });
    if (!s) return i.reply(ephemeral(busyText));
    s.ui = i;
    await i.deferReply();
    const [account, cos, pool] = await Promise.all([wallet.getAccount(i.user.id, i.guildId), profile.cosmeticsOf(i.user.id), jackpot.get(i.guildId)]);
    Object.assign(s, { balance: account.money, cos, pool: pool.amount });
    if (s.balance < bet) {
      sessions.end(s);
      return i.editReply(`잔고가 부족해요. (현재 ${chips(s.balance)})`);
    }
    await i.editReply(payload(s, [BLANK, BLANK, BLANK]));
    const msg = await i.fetchReply().catch(() => null);
    gameState.create({ gameId: s.gameId, game: 'slot', guildId: i.guildId, channelId: i.channelId, messageId: msg?.id, players: [i.user.id], state: 'PLAYING' });
  },

  async handleButton(i, { action, arg }) {
    const s = sessions.get(i.user.id);
    if (!s || s.game !== 'slot') return expired(i);
    if (action === 'stopauto') {
      if (s.auto) s.auto.stop = true;
      return i.deferUpdate();
    }
    await i.deferUpdate();
    s.ui = i;
    await sessions.run(s, async () => {
      if (action === 'spin') {
        if (!(await spinOnce(s))) await i.followUp(ephemeral('잔고가 부족해요. `/잔고`로 확인해 보세요.'));
      } else if (action === 'auto' && SL.AUTO_SPIN_OPTIONS.includes(Number(arg))) {
        await autoSpin(s, Number(arg));
      } else if (action === 'stop') {
        sessions.end(s);
        gameState.transition(s.gameId, 'COMPLETED', 'stop');
        await i.editReply(payload(s, ['👋', '👋', '👋'], { ended: true }));
      }
    });
  },
};
