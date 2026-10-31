const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const sessions = require('../services/sessions');
const wallet = require('../services/wallet');
const poker = require('../engine/poker');
const { createDecks } = require('../engine/cards');
const { shuffle } = require('../utils/rng');
const { COLOR, chips, num, netText, netColor, handText, sleep, ephemeral, expired, busyText } = require('../utils/format');

const PK = config.POKER;
const PREFIX = 'pk';
const cid = (uid, action) => `${PREFIX}:${uid}:${action}:`;

const KIND_LABEL = {
  value: '💪 밸류 (진짜 패)',
  semibluff: '🎯 세미블러핑 (드로우)',
  bluff: '🎭 블러핑 (뻥카)',
  slowplay: '🪤 슬로우플레이',
  check: '체크',
};

const street = (s) => poker.STREETS[s.revealed];
const unit = (s) => (s.revealed === 5 ? s.ante * 2 : s.ante); // 리버는 2배 단위
const visibleBoard = (s) => s.board.slice(0, s.revealed);

function boardText(s, revealAll = false) {
  const hidden = revealAll ? [] : [0, 1, 2, 3, 4].filter((n) => n >= s.revealed);
  return handText(s.board, hidden);
}

function dealerText(s, reveal) {
  if (reveal) return handText(s.dealerHole);
  return handText(s.dealerHole, PK.DEALER_SHOWS_ONE ? [1] : [0, 1]);
}

function rows(s, { ended = false } = {}) {
  const callLabel = s.toCall > 0 ? `콜 ${num(s.toCall)}` : '체크';
  const raiseAmt = s.toCall + unit(s);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(cid(s.userId, 'call')).setLabel(callLabel).setEmoji('📞').setStyle(ButtonStyle.Primary).setDisabled(ended),
      new ButtonBuilder()
        .setCustomId(cid(s.userId, 'raise'))
        .setLabel(`${s.toCall > 0 ? '레이즈' : '베팅'} ${num(raiseAmt)}`)
        .setEmoji('⬆️')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(ended),
      new ButtonBuilder().setCustomId(cid(s.userId, 'die')).setLabel('다이').setEmoji('🏳️').setStyle(ButtonStyle.Secondary).setDisabled(ended),
      new ButtonBuilder().setCustomId(cid(s.userId, 'hand')).setLabel('내 패').setEmoji('🃏').setStyle(ButtonStyle.Secondary).setDisabled(ended),
    ),
  ];
}

function logText(s, reveal) {
  if (!s.log.length) return '_아직 액션 없음_';
  return s.log
    .slice(-8)
    .map((e) => {
      const base = `\`${e.street}\` ${e.text}`;
      if (!reveal || !e.kind) return base;
      return `${base} → ${KIND_LABEL[e.kind]} · 당시 딜러 승률 ${(e.equity * 100).toFixed(0)}%`;
    })
    .join('\n');
}

function payload(s, { prompt = '', result = null } = {}) {
  const reveal = Boolean(result) && (result.kind !== 'user_fold' || PK.REVEAL_ON_FOLD);
  const embed = new EmbedBuilder()
    .setColor(result ? netColor(result.net) : COLOR.table)
    .setTitle(`🎭 포커페이스 · 앤티 ${chips(s.ante)}`)
    .setDescription(
      [
        `🤖 **딜러** — ${dealerText(s, reveal)}${reveal ? `  \`${result.dealerHand}\`` : ''}`,
        `🂠 **커뮤니티** — ${boardText(s, result?.kind === 'showdown')}`,
        result ? `🧑 **나** — ${handText(s.userHole)}  \`${result.userHand}\`` : '',
        '',
        `💰 팟 **${num(s.pot)}** · 내 누적 베팅 **${num(s.userIn)}**`,
        '',
        `📜 **베팅 로그**${reveal ? ' (딜러 의도 공개)' : ''}`,
        logText(s, reveal),
        '',
        result ? `**${result.label}** — 순손익 **${netText(result.net)}** · 잔고 ${chips(s.balanceAfter)}` : prompt,
      ]
        .filter((x, idx, arr) => x !== '' || (arr[idx - 1] !== '' && idx > 0))
        .join('\n'),
    )
    .setFooter({ text: '딜러 핸드는 쇼다운까지 비공개 · 플롭/턴 1단위, 리버 2단위 베팅' });
  return { embeds: [embed], components: rows(s, { ended: Boolean(result) }) };
}

const edit = (s, p) => s.ui.editReply(p);

/** 딜러가 먼저 행동 (블러핑 여부는 내부에 기록만 하고 숨김) */
async function dealerOpen(s) {
  const a = poker.analyze(s.dealerHole, visibleBoard(s), PK.SIMULATIONS);
  const d = poker.decideOpen(a, street(s));
  s.toCall = 0;
  if (d.act === 'bet') {
    const u = unit(s);
    s.dealerIn += u;
    s.pot += u;
    s.toCall = u;
    s.log.push({ street: street(s), text: `🤖 딜러 베팅 **${num(u)}**`, kind: d.kind, equity: a.equity });
    await edit(s, payload(s, { prompt: `➡️ 딜러가 **${num(u)}** 베팅했습니다. 블러핑일까요?` }));
  } else {
    s.log.push({ street: street(s), text: '🤖 딜러 체크', kind: d.kind, equity: a.equity });
    await edit(s, payload(s, { prompt: '➡️ 딜러 체크. 체크로 넘기거나 베팅하세요.' }));
  }
}

async function advance(s) {
  if (s.revealed === 5) return finish(s, 'showdown');
  s.revealed += 1;
  s.toCall = 0;
  await edit(s, payload(s, { prompt: `🂠 **${street(s)}** 카드 오픈!` }));
  await sleep(800);
  await dealerOpen(s);
}

async function finish(s, kind) {
  const full = s.board;
  const u = poker.evaluate([...s.userHole, ...full]);
  const d = poker.evaluate([...s.dealerHole, ...full]);
  let net;
  let label;
  if (kind === 'user_fold') {
    net = -s.userIn;
    label = '🏳️ 다이';
  } else if (kind === 'dealer_fold') {
    net = s.pot - s.userIn;
    label = '🤖 딜러 폴드 — 팟 획득!';
  } else if (u.score > d.score) {
    net = s.pot - s.userIn;
    label = `🎉 쇼다운 승리 (${u.name} vs ${d.name})`;
  } else if (u.score < d.score) {
    net = -s.userIn;
    label = `😵 쇼다운 패배 (${u.name} vs ${d.name})`;
  } else {
    net = Math.floor(s.pot / 2) - s.userIn;
    label = `🤝 무승부 (${u.name})`;
  }

  const cur = (hole) => poker.evaluate([...hole, ...(kind === 'showdown' ? full : visibleBoard(s))]).name;
  const doc = await wallet.settle(s.userId, s.guildId, net, {
    inc: { pokerHands: 1, ...(net > 0 ? { pokerWins: 1 } : {}) },
    wagered: s.userIn,
  });
  s.balanceAfter = doc?.money ?? s.balance + net;
  sessions.end(s);
  await edit(s, payload(s, { result: { kind, net, label, userHand: cur(s.userHole), dealerHand: cur(s.dealerHole) } }));
}

async function userAction(s, action) {
  if (action === 'die') {
    s.log.push({ street: street(s), text: '🧑 다이' });
    return finish(s, 'user_fold');
  }
  if (action === 'call') {
    const pay = s.toCall;
    s.userIn += pay;
    s.pot += pay;
    s.log.push({ street: street(s), text: pay > 0 ? `🧑 콜 ${num(pay)}` : '🧑 체크' });
    s.toCall = 0;
    return advance(s);
  }
  if (action === 'raise') {
    const u = unit(s);
    const pay = s.toCall + u;
    s.userIn += pay;
    s.pot += pay;
    s.log.push({ street: street(s), text: `🧑 ${s.toCall > 0 ? '레이즈' : '베팅'} ${num(pay)}` });
    s.toCall = 0;
    await edit(s, payload(s, { prompt: '🤔 딜러가 고민 중...' }));
    await sleep(900);

    const a = poker.analyze(s.dealerHole, visibleBoard(s), PK.SIMULATIONS);
    if (poker.decideFacingRaise(a, u, s.pot) === 'call') {
      s.dealerIn += u;
      s.pot += u;
      s.log.push({ street: street(s), text: `🤖 딜러 콜 ${num(u)}` });
      return advance(s);
    }
    s.log.push({ street: street(s), text: '🤖 딜러 폴드' });
    return finish(s, 'dealer_fold');
  }
}

function handReply(s) {
  const cur = poker.evaluate([...s.userHole, ...visibleBoard(s)]);
  return ephemeral(`🃏 **내 패**: ${handText(s.userHole)}\n현재 족보: **${cur.name}** (보드 ${s.revealed}장 기준)`);
}

module.exports = {
  prefix: PREFIX,
  data: new SlashCommandBuilder()
    .setName('포커페이스')
    .setDescription('AI 딜러와 1:1 홀덤 — 딜러의 블러핑을 판독하세요')
    .addIntegerOption((o) =>
      o.setName('금액').setDescription(`앤티 금액 (잔고가 앤티의 ${config.POKER.MAX_EXPOSURE}배 이상 필요)`).setRequired(true).setMinValue(config.MIN_BET).setMaxValue(config.MAX_BET),
    ),

  async execute(i) {
    const ante = i.options.getInteger('금액', true);
    const s = sessions.start(i.user.id, 'poker', { guildId: i.guildId, ante }, {
      idleMs: PK.IDLE_MS,
      onTimeout: async (x) => {
        x.log.push({ street: street(x), text: '⏱️ 시간 초과 — 자동 다이' });
        await finish(x, 'user_fold');
      },
    });
    if (!s) return i.reply(ephemeral(busyText));
    s.ui = i;
    await i.deferReply();

    const account = await wallet.getAccount(i.user.id, i.guildId);
    if (account.money < ante * PK.MAX_EXPOSURE) {
      sessions.end(s);
      return i.editReply(`최대 리스크(앤티 × ${PK.MAX_EXPOSURE} = ${chips(ante * PK.MAX_EXPOSURE)})를 감당할 잔고가 필요해요. (현재 ${chips(account.money)})`);
    }

    const deck = shuffle(createDecks(1));
    Object.assign(s, {
      balance: account.money,
      userHole: [deck.pop(), deck.pop()],
      dealerHole: [deck.pop(), deck.pop()],
      board: [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()],
      revealed: 3,
      pot: ante * 2,
      userIn: ante,
      dealerIn: ante,
      toCall: 0,
      log: [],
    });

    await sessions.run(s, async () => {
      await i.editReply(payload(s, { prompt: '🂠 플롭 오픈! 딜러가 액션을 고민합니다...' }));
      await i.followUp(handReply(s)); // 내 패는 나에게만 (ephemeral)
      await sleep(700);
      await dealerOpen(s);
    });
  },

  async handleButton(i, { action }) {
    const s = sessions.get(i.user.id);
    if (!s || s.game !== 'poker') return expired(i);
    if (action === 'hand') return i.reply(handReply(s));
    await i.deferUpdate();
    s.ui = i;
    await sessions.run(s, () => userAction(s, action));
  },
};
