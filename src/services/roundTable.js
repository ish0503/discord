/**
 * 라운드형 공유 테이블 관리자 (블랙잭·바카라 공용).
 *
 *   로비 ──▶ 베팅 ──▶ 라운드 진행 ──▶ 베팅 ──▶ … ──▶ 닫힘
 *            ▲ 참가는 로비·베팅·진행 중 언제든 (진행 중 참가자는 다음 판부터)
 *
 * - 채널당 게임별 테이블 1개 → 그 채널의 카드 슈를 테이블 전원이 공유
 * - 베팅 버튼을 누르는 즉시 wallet.reserve()로 칩을 에스크로에 묶음
 * - 딜이 시작된 뒤 도착한 늦은 베팅은 자동 환불
 * - 연속 IDLE_ROUNDS_TO_CLOSE판 동안 아무도 베팅하지 않거나 전원이 나가면 테이블 종료
 *
 * 게임별 훅(spec):
 *   parseBet(extra) → { amount, ... } | null
 *   betLabel(bet) → string
 *   betRows(t) → ActionRow[]           (최대 4줄, 마지막 줄은 관리자 버튼)
 *   describe(t, prompt) → string        (임베드 본문)
 *   playRows(t) → ActionRow[]          (라운드 진행 중 버튼)
 *   playRound(t, entries) → Promise     (테이블 락 안에서 호출. 라운드가 끝나면 mgr.afterRound 호출)
 *   onAction(i, t, action, extra)      (게임 고유 버튼)
 */
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const sessions = require('./sessions');
const wallet = require('./wallet');
const gameState = require('./gameState');
const guildConfig = require('./guildConfig');
const profile = require('./profile');
const { displayName, unixIn, runExclusive, runSoon, attachLive, captureMessage } = require('../utils/table');
const { COLOR, ephemeral, expired, busyText } = require('../utils/format');

class RoundTableManager {
  constructor(spec) {
    Object.assign(this, spec);
    this.tables = new Map(); // tableId → table
    this.byChannel = new Map(); // channelId → tableId
  }

  /** customId: prefix:*:action:tableId~extra  (공용 버튼, 권한은 핸들러가 검사) */
  cid(t, action, extra = '') {
    return `${this.prefix}:*:${action}:${t.id}~${extra}`;
  }

  seat(t, userId) {
    return t.players.find((p) => p.id === userId);
  }

  confirmedBet(t, userId) {
    const b = t.bets.get(userId);
    return b && !b.pending ? b : null;
  }

  // ───────────────────────── 화면 ─────────────────────────

  lobbyRow(t) {
    const full = t.players.length >= t.maxPlayers;
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(this.cid(t, 'join')).setLabel('참가').setEmoji('🙋').setStyle(ButtonStyle.Success).setDisabled(full),
      new ButtonBuilder().setCustomId(this.cid(t, 'leave')).setLabel('나가기').setEmoji('🚪').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(this.cid(t, 'start')).setLabel('시작').setEmoji('▶️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(this.cid(t, 'close')).setLabel('취소').setEmoji('✖️').setStyle(ButtonStyle.Danger),
    );
  }

  controlRow(t) {
    const full = t.players.length >= t.maxPlayers;
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(this.cid(t, 'join')).setLabel('참가').setEmoji('🙋').setStyle(ButtonStyle.Success).setDisabled(full),
      new ButtonBuilder().setCustomId(this.cid(t, 'leave')).setLabel('나가기').setEmoji('🚪').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(this.cid(t, 'deal')).setLabel('바로 딜').setEmoji('⏩').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(this.cid(t, 'close')).setLabel('테이블 닫기').setEmoji('✖️').setStyle(ButtonStyle.Danger),
    );
  }

  /** 베팅 현황 (게임 describe에서 사용) */
  seatsBetText(t) {
    return t.players
      .map((p) => {
        const b = t.bets.get(p.id);
        const host = p.id === t.hostId ? ' 👑' : '';
        const status = !b ? '⏳ 대기' : b.pending ? '… 처리 중' : `✅ ${this.betLabel(b)}`;
        return `🧑 **${p.name}**${host} — ${status}`;
      })
      .join('\n');
  }

  render(t, prompt = '') {
    const embed = new EmbedBuilder().setColor(t.state === 'closed' ? COLOR.push : this.color).setTitle(this.titleFor(t));
    let components = [];

    if (t.state === 'lobby') {
      embed.setDescription(
        [
          this.lobbyInfo(t),
          `🧑 플레이어 **${t.players.length}/${t.maxPlayers}**`,
          '',
          t.players.map((p, k) => `\`${k + 1}\` 🧑 ${p.name}${p.id === t.hostId ? ' 👑' : ''}`).join('\n'),
          '',
          prompt || `⏳ <t:${t.lobbyEndsAt}:R> 첫 판 시작 · 👑 호스트는 바로 시작 가능 · 게임 중에도 언제든 참가 가능`,
        ].join('\n'),
      );
      components = [this.lobbyRow(t)];
    } else {
      embed.setDescription(this.describe(t, prompt).slice(0, 4096));
      if (t.state === 'betting') components = [...this.betRows(t), this.controlRow(t)];
      else if (t.state === 'playing') components = this.playRows(t);
    }

    const host = this.seat(t, t.hostId);
    embed.setFooter({ text: `👑 ${host?.name ?? '-'} · 좌석 ${t.players.length}/${t.maxPlayers} · 같은 채널의 슈를 공유합니다` });
    return { embeds: [embed], components };
  }

  bettingPrompt(t) {
    return `⏳ <t:${t.betEndsAt}:R> 딜 · 전원 베팅하면 즉시 시작`;
  }

  // ───────────────────────── 생명주기 ─────────────────────────

  async open(i, maxPlayers) {
    if (this.byChannel.has(i.channelId)) {
      return i.reply(ephemeral(`이 채널에는 이미 ${this.title} 테이블이 열려 있어요. 그 테이블의 🙋 참가 버튼을 눌러 주세요.`));
    }
    const marker = sessions.start(i.user.id, this.game, {}, { persistent: true });
    if (!marker) return i.reply(ephemeral(busyText));

    const t = {
      id: i.id,
      channelId: i.channelId,
      guildId: i.guildId,
      hostId: i.user.id,
      maxPlayers,
      state: 'lobby',
      players: [{ id: i.user.id, name: displayName(i), marker, cos: null }],
      bets: new Map(),
      idleRounds: 0,
      lastSummary: '',
      note: '',
      ui: i,
      busy: false,
      timers: {},
      lobbyEndsAt: unixIn(this.cfg.LOBBY_MS),
    };
    marker.tableId = t.id;
    attachLive(t);
    this.tables.set(t.id, t);
    this.byChannel.set(t.channelId, t.id);

    try {
      await i.deferReply();
      await wallet.getAccount(i.user.id, i.guildId);
      t.players[0].cos = await profile.cosmeticsOf(i.user.id);
    } catch (err) {
      this.#forget(t);
      sessions.end(marker);
      throw err;
    }

    await i.editReply(this.render(t, maxPlayers === 1 ? '🃏 테이블 준비 중...' : ''));
    await captureMessage(t, i);
    gameState.create({ gameId: t.id, game: this.game, guildId: t.guildId, channelId: t.channelId, messageId: t.message?.id, players: [i.user.id] });
    if (maxPlayers === 1) return runExclusive(t, () => this.startBetting(t));
    t.timers.lobby = setTimeout(() => runSoon(t, () => this.startBetting(t)), this.cfg.LOBBY_MS);
  }

  async startBetting(t, note = '') {
    if (t.state === 'closed') return;
    clearTimeout(t.timers.lobby);
    if (!t.players.length) return this.close(t, '🚪 플레이어가 없어 테이블을 닫았습니다.');
    t.state = 'betting';
    gameState.transition(t.id, 'BETTING');
    t.bets = new Map();
    t.note = note;
    t.betEndsAt = unixIn(this.cfg.BET_MS);
    clearTimeout(t.timers.bet);
    t.timers.bet = setTimeout(() => runSoon(t, () => this.deal(t)), this.cfg.BET_MS);
    t.live.push(this.render(t, this.bettingPrompt(t)));
  }

  allBet(t) {
    return t.players.length > 0 && t.players.every((p) => this.confirmedBet(t, p.id));
  }

  async deal(t) {
    if (t.state !== 'betting') return;
    clearTimeout(t.timers.bet);
    if (!t.players.length) return this.close(t, '🚪 플레이어가 없어 테이블을 닫았습니다.');

    const entries = t.players
      .map((p) => {
        const b = this.confirmedBet(t, p.id);
        return b ? { id: p.id, name: p.name, ...b } : null;
      })
      .filter(Boolean);

    if (!entries.length) {
      t.idleRounds += 1;
      if (t.idleRounds >= this.cfg.IDLE_ROUNDS_TO_CLOSE) return this.close(t, '💤 한동안 베팅이 없어 테이블을 닫았습니다.');
      return this.startBetting(t, `💤 이번 판은 아무도 베팅하지 않았어요 (${t.idleRounds}/${this.cfg.IDLE_ROUNDS_TO_CLOSE})`);
    }
    t.idleRounds = 0;
    t.state = 'playing';
    gameState.transition(t.id, 'PLAYING');
    t.roundEntries = entries;
    await this.playRound(t, entries);
  }

  /** 게임 훅이 라운드를 끝낸 뒤 호출 */
  async afterRound(t, summary) {
    t.lastSummary = summary;
    t.roundEntries = null;
    if (t.state === 'closed') return;
    await this.startBetting(t);
  }

  async close(t, reason) {
    if (t.state === 'closed') return;
    const wasBetting = t.state === 'betting';
    t.state = 'closed';
    for (const timer of Object.values(t.timers)) clearTimeout(timer);

    if (wasBetting) {
      for (const [uid, b] of t.bets) if (!b.pending) await wallet.refund({ userId: uid, guildId: t.guildId, roundId: b.roundId, reason: 'table-closed' }).catch(console.error);
    }
    for (const p of t.players) sessions.end(p.marker);
    this.#forget(t);
    gameState.transition(t.id, 'COMPLETED', reason);
    await t.live.final(this.render(t, reason)).catch(() => {});
  }

  #forget(t) {
    this.tables.delete(t.id);
    if (this.byChannel.get(t.channelId) === t.id) this.byChannel.delete(t.channelId);
  }

  // ───────────────────────── 버튼 ─────────────────────────

  async handleButton(i, { action, arg = '' }) {
    const [tableId, extra = ''] = arg.split('~');
    const t = this.tables.get(tableId);
    if (!t) return expired(i);

    switch (action) {
      case 'join':
        return this.join(i, t);
      case 'leave':
        return this.leave(i, t);
      case 'start':
      case 'deal':
      case 'close':
        return this.hostControl(i, t, action);
      case 'bet':
        return this.placeBet(i, t, extra);
      default:
        return this.onAction(i, t, action, extra);
    }
  }

  async join(i, t) {
    if (t.state === 'closed') return i.reply(ephemeral('닫힌 테이블이에요.'));
    if (this.seat(t, i.user.id)) return i.reply(ephemeral('이미 참가했어요.'));
    if (t.players.length >= t.maxPlayers) return i.reply(ephemeral('자리가 꽉 찼어요.'));

    const marker = sessions.start(i.user.id, this.game, { tableId: t.id }, { persistent: true });
    if (!marker) return i.reply(ephemeral(busyText));
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    let cos;
    try {
      await wallet.getAccount(i.user.id, i.guildId);
      cos = await profile.cosmeticsOf(i.user.id);
    } catch (err) {
      sessions.end(marker);
      throw err;
    }
    if (t.state === 'closed' || t.players.length >= t.maxPlayers || this.seat(t, i.user.id)) {
      sessions.end(marker);
      return i.editReply('그 사이에 자리가 찼거나 테이블이 닫혔어요.');
    }

    t.players.push({ id: i.user.id, name: displayName(i), marker, cos });
    gameState.addPlayer(t.id, i.user.id);
    await i.editReply(
      t.state === 'playing' ? '✅ 참가 완료! 지금 판이 끝나면 다음 베팅부터 참여합니다.' : '✅ 참가 완료! 베팅 시간에 칩 버튼을 눌러 주세요.',
    );

    if (t.state === 'lobby' && t.players.length >= t.maxPlayers) return runExclusive(t, () => this.startBetting(t));
    if (t.state !== 'playing') t.live.push(this.render(t, t.state === 'betting' ? this.bettingPrompt(t) : ''));
  }

  async leave(i, t) {
    const p = this.seat(t, i.user.id);
    if (!p) return i.reply(ephemeral('참가하지 않은 테이블이에요.'));
    if (t.state === 'playing' && t.roundEntries?.some((e) => e.id === p.id)) {
      return i.reply(ephemeral('베팅한 판이 끝난 뒤에 나갈 수 있어요.'));
    }
    if (t.bets.get(p.id)?.pending) return i.reply(ephemeral('베팅 처리 중이에요. 잠시 후 다시 시도하세요.'));

    await i.deferReply({ flags: MessageFlags.Ephemeral });
    let refunded = false;
    const done = await runExclusive(t, async () => {
      const b = this.confirmedBet(t, p.id);
      if (b && t.state === 'betting') {
        refunded = (await wallet.refund({ userId: p.id, guildId: t.guildId, roundId: b.roundId, reason: 'leave' })).ok;
        t.bets.delete(p.id);
      }
      t.players = t.players.filter((x) => x !== p);
      sessions.end(p.marker);
      if (p.id === t.hostId && t.players.length) t.hostId = t.players[0].id; // 호스트 위임

      if (!t.players.length) return this.close(t, '🚪 모든 플레이어가 떠나 테이블을 닫았습니다.');
      if (t.state === 'betting' && this.allBet(t)) return this.deal(t);
      if (t.state !== 'playing') t.live.push(this.render(t, t.state === 'betting' ? this.bettingPrompt(t) : ''));
    });
    if (!done) return i.editReply('딜러가 카드를 돌리는 중이에요. 잠시 후 다시 시도하세요.');
    return i.editReply(`🚪 테이블에서 나왔어요.${refunded ? ' 이번 판 베팅은 환불됐어요.' : ''}`);
  }

  async hostControl(i, t, action) {
    if (i.user.id !== t.hostId) return i.reply(ephemeral('👑 호스트만 할 수 있어요.'));
    const allowed = { start: ['lobby'], deal: ['betting'], close: ['lobby', 'betting'] }[action];
    if (!allowed.includes(t.state)) {
      return i.reply(ephemeral(t.state === 'playing' ? '진행 중인 판이 끝난 뒤에 할 수 있어요.' : '지금은 할 수 없어요.'));
    }
    await i.deferUpdate();
    t.ui = i;
    if (action === 'start') return runExclusive(t, () => this.startBetting(t));
    if (action === 'deal') return runExclusive(t, () => this.deal(t));
    return runExclusive(t, () => this.close(t, '✖️ 호스트가 테이블을 닫았습니다.'));
  }

  async placeBet(i, t, extra) {
    const uid = i.user.id;
    if (!this.seat(t, uid)) return i.reply(ephemeral('먼저 🙋 참가 버튼을 눌러 주세요.'));
    if (t.state !== 'betting') return i.reply(ephemeral('지금은 베팅 시간이 아니에요.'));
    if (t.bets.has(uid)) return i.reply(ephemeral('이번 판은 이미 베팅했어요.'));
    const bet = this.parseBet(extra);
    if (!bet) return i.reply(ephemeral('잘못된 베팅이에요.'));
    const blocked = (await guildConfig.gameBlockReason(t.guildId, this.game)) || (await guildConfig.betBlockReason(t.guildId, this.game, bet.amount));
    if (blocked) return i.reply(ephemeral(blocked));

    const marker = { pending: true, ...bet };
    t.bets.set(uid, marker); // 같은 유저의 연타·중복 베팅 차단
    await i.deferUpdate();
    t.ui = i;

    let r;
    try {
      r = await wallet.reserve(uid, t.guildId, this.game, bet.amount, { gameId: t.id });
    } catch (err) {
      if (t.bets.get(uid) === marker) t.bets.delete(uid);
      throw err;
    }
    if (!r) {
      if (t.bets.get(uid) === marker) t.bets.delete(uid);
      return i.followUp(ephemeral('잔고가 부족해요. `/잔고`로 확인해 보세요.'));
    }
    // 예약하는 사이 딜이 시작됐거나 테이블이 닫혔으면 즉시 환불
    if (t.state !== 'betting' || t.bets.get(uid) !== marker) {
      await wallet.refund({ userId: uid, guildId: t.guildId, roundId: r.roundId, reason: 'late-bet' });
      return i.followUp(ephemeral('딜이 이미 시작돼서 베팅이 환불됐어요. 다음 판에 걸어 주세요.'));
    }

    t.bets.set(uid, { ...bet, roundId: r.roundId, balance: r.balance });
    if (this.allBet(t)) {
      const started = await runExclusive(t, () => this.deal(t));
      if (started) return;
    }
    t.live.push(this.render(t, this.bettingPrompt(t)));
  }
}

module.exports = { RoundTableManager };
