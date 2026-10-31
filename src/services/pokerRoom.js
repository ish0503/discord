/**
 * 노리밋 홀덤 테이블 진행기 (현금 테이블·토너먼트 공용).
 * HoldemHand(순수 엔진)를 감싸 봇 차례 자동 진행, 사람 차례 대기·타임아웃, 화면 렌더링, 비공개 패 갱신을 담당.
 * 핸드가 끝나면 hooks.onHandEnd(room, hand)를 호출 — 정산·다음 핸드 여부는 게임 쪽이 결정.
 */
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const poker = require('../engine/poker');
const { HoldemHand } = require('../engine/holdem');
const { createDecks } = require('../engine/cards');
const { shuffle, randomInt } = require('../utils/rng');
const { unixIn, runExclusive, runSoon } = require('../utils/table');
const { COLOR, num, netText, handText, sleep, ephemeral } = require('../utils/format');

const KIND_LABEL = {
  value: '💪 밸류 (진짜 패)',
  semibluff: '🎯 세미블러핑 (드로우)',
  bluff: '🎭 블러핑 (뻥카)',
  slowplay: '🪤 슬로우플레이',
};
const ACTION_TEXT = { fold: '🏳️ 다이', check: '✋ 체크', call: '📞 콜', 'allin-call': '🔥 올인 콜', bet: '💰 베팅', raise: '⬆️ 레이즈', allin: '🔥 올인' };

const rooms = new Map();

function makeBots(n, names, stack) {
  const keys = Object.keys(poker.BOT_STYLES);
  return Array.from({ length: n }, (_, k) => ({
    type: 'bot',
    id: `bot${k}`,
    name: `봇 ${names[k] ?? k + 1}`,
    style: poker.BOT_STYLES[keys[randomInt(0, keys.length)]],
    stack,
  }));
}

class PokerRoom {
  /**
   * @param o { id, prefix, guildId, channelId, title(room)→string, seats, live, ui, message,
   *            turnMs, thinkMs, simulations, streetPauseMs, revealFoldedBots, autoSitOut, footer(room)→string, onHandEnd }
   */
  constructor(o) {
    Object.assign(this, o);
    this.handNo = 0;
    this.busy = false;
    this.timers = {};
    this.state = 'playing';
    rooms.set(this.id, this);
  }

  cid(action, extra = '') {
    return `${this.prefix}:*:${action}:${this.id}~${extra}`;
  }

  close() {
    this.state = 'done';
    for (const t of Object.values(this.timers)) clearTimeout(t);
    rooms.delete(this.id);
  }

  async playHand({ sb, bb, ante = 0, button }) {
    this.handNo += 1;
    this.blinds = { sb, bb, ante };
    this.handSeats = this.seats.filter((s) => s.stack > 0);
    this.startStacks = this.handSeats.map((s) => s.stack);
    this.allIns = new Set();
    this.hand = new HoldemHand(
      this.handSeats.map((s) => ({ id: s.id, name: s.name, stack: s.stack })),
      { button, sb, bb, ante },
    );
    this.hand.start(shuffle(createDecks(1)));
    this.log = [{ text: `🂠 핸드 #${this.handNo} · 블라인드 ${num(sb)}/${num(bb)}${ante ? ` · 앤티 ${num(ante)}` : ''}` }];
    this.updatePrivates();
    await this.drive();
  }

  /** 봇·자리비움 차례는 자동, 사람 차례면 화면 갱신 후 대기 */
  async drive() {
    const h = this.hand;
    while (!h.finished && this.state === 'playing') {
      const idx = h.actor;
      const hs = h.seats[idx];
      const seat = this.handSeats[idx];
      if (seat.type === 'human' && !seat.sittingOut) {
        this.live.push(this.render(`👉 **${seat.name}** 님 차례 · <t:${unixIn(this.turnMs)}:R> 자동 처리`));
        this.armTimer(idx);
        return;
      }
      if (seat.type === 'human') {
        await this.apply(idx, { type: h.legal(idx).toCall === 0 ? 'check' : 'fold' }, { auto: true });
        continue;
      }
      this.live.push(this.render(`🤖 **${seat.name}** 생각 중...`));
      await sleep(this.thinkMs);
      const lg = h.legal(idx);
      const opponents = h.liveIndexes.length - 1;
      const a = poker.analyze(hs.hole, h.visibleBoard, opponents, this.simulations);
      const d = poker.botDecide(
        a,
        { opponents, toCall: lg.toCall, pot: lg.pot, stack: hs.stack, streetIn: hs.streetIn, currentBet: h.currentBet, minRaise: h.minRaise, minTo: lg.minTo, maxTo: lg.maxTo, canRaise: lg.canRaise, bb: h.bb, street: h.streetName },
        seat.style,
      );
      await this.apply(idx, d, { kind: d.kind, equity: a.equity });
    }
    if (h.finished && this.state === 'playing') {
      clearTimeout(this.timers.turn);
      await this.onHandEnd(this, h);
    }
  }

  async apply(idx, action, meta = {}) {
    const h = this.hand;
    const seat = this.handSeats[idx];
    const street = h.streetName;
    const ev = h.act(idx, action);
    if (ev.action === 'allin' || ev.action === 'allin-call') this.allIns.add(seat.id);
    const aggressive = ['bet', 'raise', 'allin'].includes(ev.action);
    this.log.push({
      street,
      text: `${seat.type === 'bot' ? '🤖' : '🧑'} ${seat.name} ${ACTION_TEXT[ev.action] ?? ev.action}${ev.amount ? ` ${num(ev.amount)}` : ''}${meta.auto ? ' (자동)' : ''}`,
      kind: seat.type === 'bot' && (aggressive || meta.kind === 'slowplay') ? meta.kind : null,
      equity: meta.equity,
    });
    if (ev.type === 'street') {
      this.log.push({ street: ev.street, text: `🂠 **${ev.street}** 오픈` });
      this.updatePrivates();
      this.live.push(this.render(`🂠 **${ev.street}** 카드가 열렸습니다!`));
      await sleep(this.streetPauseMs);
    } else if (ev.type === 'end' && h.endReason === 'showdown') {
      this.log.push({ street: '쇼다운', text: '🂠 남은 카드 공개 → 쇼다운' });
      this.updatePrivates();
    }
    return ev;
  }

  armTimer(idx) {
    clearTimeout(this.timers.turn);
    const h = this.hand;
    this.timers.turn = setTimeout(() => {
      runSoon(this, async () => {
        if (this.hand !== h || h.finished || h.actor !== idx) return;
        const seat = this.handSeats[idx];
        seat.timeouts = (seat.timeouts ?? 0) + 1;
        if (this.autoSitOut && seat.timeouts >= 2) seat.sittingOut = true;
        await this.apply(idx, { type: h.legal(idx).toCall === 0 ? 'check' : 'fold' }, { auto: true });
        await this.drive();
      });
    }, this.turnMs);
  }

  /** 사람 버튼 처리 */
  async handleAction(i, action, extra) {
    const h = this.hand;
    const uid = i.user.id;
    const mineIdx = this.handSeats?.findIndex((s) => s.type === 'human' && s.id === uid) ?? -1;
    if (action === 'hand') {
      if (mineIdx < 0) return i.reply(ephemeral('이번 핸드 참가자가 아니에요.'));
      return i.reply({ ...this.privateText(mineIdx), flags: MessageFlags.Ephemeral });
    }
    if (action === 'back') {
      const seat = this.seats.find((s) => s.id === uid);
      if (!seat) return i.reply(ephemeral('참가자가 아니에요.'));
      seat.sittingOut = false;
      seat.timeouts = 0;
      return i.reply(ephemeral('🔙 복귀했어요. 다음 차례부터 직접 행동합니다.'));
    }
    if (!h || h.finished || this.state !== 'playing') return i.reply(ephemeral('진행 중인 핸드가 없어요.'));
    const idx = h.actor;
    const seat = this.handSeats[idx];
    if (seat.id !== uid) return i.reply(ephemeral(mineIdx >= 0 ? `지금은 **${seat.name}** 님 차례예요.` : '이 테이블 참가자가 아니에요.'));
    const [handNo, toRaw] = String(extra).split('.');
    if (Number(handNo) !== this.handNo) return i.reply(ephemeral('지난 핸드의 버튼이에요.'));
    if (this.busy) return i.deferUpdate();
    await i.deferUpdate();
    this.ui = i;
    seat.timeouts = 0;
    await runExclusive(this, async () => {
      if (this.hand !== h || h.actor !== idx) return;
      clearTimeout(this.timers.turn);
      const act = action === 'raise' ? { type: 'raise', to: Number(toRaw) } : { type: action };
      await this.apply(idx, act);
      await this.drive();
    });
    return undefined;
  }

  privateText(idx) {
    const h = this.hand;
    const s = h.seats[idx];
    const seat = this.handSeats[idx];
    const theme = seat.cos?.cardTheme ?? 'classic';
    const cur = poker.evaluate([...s.hole, ...h.visibleBoard]);
    let txt = `🃏 **내 패** ${handText(s.hole, [], theme)}\n🂠 보드 ${handText(h.visibleBoard, [], theme) || '(아직 없음)'}\n`;
    txt += h.visibleBoard.length ? `현재 족보: **${cur.name}** (${h.streetName})` : `프리플랍 · 스택 ${num(s.stack)}`;
    if (s.folded) txt += '\n🏳️ 이번 핸드는 다이했습니다.';
    if (h.finished) txt += `\n\n핸드 결과 · ${netText(h.results[idx].net)} · 스택 ${num(h.results[idx].finalStack)}`;
    return { content: txt };
  }

  updatePrivates() {
    this.handSeats.forEach((seat, idx) => {
      if (seat.type !== 'human' || !seat.privateEdit) return;
      Promise.resolve()
        .then(() => seat.privateEdit(this.privateText(idx)))
        .catch(() => {});
    });
  }

  potText() {
    const h = this.hand;
    const pots = HoldemHand.buildPots(h.seats);
    if (pots.length <= 1) return `💰 팟 **${num(h.pot)}**`;
    return `💰 팟 **${num(h.pot)}** (${pots.map((p, k) => `${k ? `사이드${k}` : '메인'} ${num(p.amount)}`).join(' · ')})`;
  }

  seatLines(final) {
    const h = this.hand;
    const showdown = h.finished && h.endReason === 'showdown';
    return h.seats
      .map((s, k) => {
        const seat = this.handSeats[k];
        const r = final ? h.results[k] : null;
        const turn = !final && h.actor === k ? '▶' : '　';
        const icon = seat.type === 'bot' ? '🤖' : '🧑';
        const pos = [k === h.button ? '🔘' : '', k === h.sbIndex ? 'SB' : '', k === h.bbIndex ? 'BB' : ''].filter(Boolean).join(' ');
        let line = `${turn}\`${k + 1}\` ${icon} **${seat.name}**${pos ? ` ${pos}` : ''} · 스택 ${num(s.stack)}`;
        if (s.folded) line += ' · 🏳️';
        else if (s.allIn) line += ' · 🔥 올인';
        if (!final && s.streetIn) line += ` · 이번 ${num(s.streetIn)}`;
        if (seat.sittingOut) line += ' · 💤';
        if (final) {
          const showCards = seat.type === 'bot' ? !s.folded || this.revealFoldedBots : showdown && !s.folded;
          if (showCards) line += ` ${handText(s.hole, [], seat.cos?.cardTheme)}`;
          if (showdown && !s.folded) line += ` \`${r.hand.name}\``;
          line += ` → ${r.winner ? '🏆 ' : ''}**${netText(r.net)}**`;
          if (seat.type === 'bot') line += `\n　　└ ${seat.style.label}`;
        }
        return line;
      })
      .join('\n');
  }

  logLines(final) {
    return this.log
      .slice(final ? -14 : -8)
      .map((e) => {
        let line = e.street ? `\`${e.street}\` ${e.text}` : e.text;
        if (final && e.kind && KIND_LABEL[e.kind]) line += ` → ${KIND_LABEL[e.kind]} · 당시 승률 ${(e.equity * 100).toFixed(0)}%`;
        return line;
      })
      .join('\n');
  }

  actionRows() {
    const h = this.hand;
    const idx = h.actor;
    if (idx === null || h.finished) return [];
    const lg = h.legal(idx);
    const hs = h.seats[idx];
    const row1 = [
      new ButtonBuilder()
        .setCustomId(this.cid('call', `${this.handNo}.0`))
        .setLabel(lg.toCall === 0 ? '체크' : `콜 ${num(lg.toCall)}${lg.toCall >= hs.stack ? ' (올인)' : ''}`)
        .setEmoji('📞')
        .setStyle(ButtonStyle.Primary),
    ];
    if (lg.canRaise) {
      const potAfterCall = lg.pot + lg.toCall;
      const cands = [
        ['최소', lg.minTo],
        ['½팟', h.currentBet + Math.max(h.minRaise, Math.round(potAfterCall * 0.5))],
        ['팟', h.currentBet + Math.max(h.minRaise, potAfterCall)],
      ];
      const seen = new Set();
      for (const [name, raw] of cands) {
        const to = Math.min(Math.max(raw, lg.minTo), lg.maxTo);
        if (to >= lg.maxTo || seen.has(to)) continue;
        seen.add(to);
        row1.push(new ButtonBuilder().setCustomId(this.cid('raise', `${this.handNo}.${to}`)).setLabel(`${name} ${num(to)}`).setEmoji('⬆️').setStyle(ButtonStyle.Danger));
      }
      row1.push(new ButtonBuilder().setCustomId(this.cid('allin', `${this.handNo}.0`)).setLabel(`올인 ${num(lg.maxTo)}`).setEmoji('🔥').setStyle(ButtonStyle.Danger));
    }
    const row2 = [
      new ButtonBuilder().setCustomId(this.cid('fold', `${this.handNo}.0`)).setLabel('다이').setEmoji('🏳️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(this.cid('hand')).setLabel('내 패').setEmoji('🃏').setStyle(ButtonStyle.Secondary),
    ];
    if (this.seats.some((s) => s.sittingOut)) row2.push(new ButtonBuilder().setCustomId(this.cid('back')).setLabel('복귀').setEmoji('🔙').setStyle(ButtonStyle.Success));
    return [new ActionRowBuilder().addComponents(row1.slice(0, 5)), new ActionRowBuilder().addComponents(row2)];
  }

  render(prompt, { final = false, extraRows = [], extraLines = [] } = {}) {
    const h = this.hand;
    const hidden = [0, 1, 2, 3, 4].filter((n) => n >= h.revealed);
    const desc = [
      `🂠 **보드** ${handText(h.board, hidden)}`,
      this.potText(),
      '',
      '💺 **좌석**',
      this.seatLines(final),
      '',
      `📜 **로그**${final ? ' (봇 의도 공개)' : ''}`,
      this.logLines(final),
      ...(extraLines.length ? ['', ...extraLines] : []),
      '',
      prompt,
    ].join('\n');
    const embed = new EmbedBuilder()
      .setColor(final ? COLOR.gold : COLOR.table)
      .setTitle(this.title(this))
      .setDescription(desc.slice(0, 4096))
      .setFooter({ text: this.footer(this) });
    return { embeds: [embed], components: final ? extraRows : this.actionRows() };
  }

  /** 핸드 결과 요약 (팟별 승자) */
  potSummary() {
    const h = this.hand;
    const name = (i) => this.handSeats[i].name;
    if (h.endReason === 'fold') {
      const w = h.liveIndexes[0];
      return `🏆 **${name(w)}** 님이 팟 **${num(h.pot)}** 획득 (나머지 전원 다이)`;
    }
    return h.pots
      .map((p, k) => {
        if (p.eligible.length === 1) return `↩️ ${name(p.winners[0])} 언콜드 ${num(p.amount)} 반환`;
        const hand = h.results[p.winners[0]].hand.name;
        return `🏆 ${k ? `사이드${k}` : '메인'} ${num(p.amount)} → **${p.winners.map(name).join(', ')}** (${hand})${p.winners.length > 1 ? ' 분할' : ''}`;
      })
      .join('\n');
  }
}

/** 버튼 라우팅: customId arg = roomId~extra */
function route(i, action, arg) {
  const [roomId, extra = ''] = String(arg).split('~');
  const room = rooms.get(roomId);
  if (!room) return i.reply(ephemeral('이미 끝난 테이블이에요.'));
  return room.handleAction(i, action, extra);
}

module.exports = { PokerRoom, makeBots, route, rooms, KIND_LABEL };
