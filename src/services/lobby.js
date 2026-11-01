/**
 * 모집 로비 (포커 현금 테이블·토너먼트 공용).
 * 참가/나가기/시작/취소 버튼, 참가 조건 검사, 호스트 권한, 자동 시작, 참가자별 비공개 메시지 확보.
 * 시작되면 spec.onStart(lobby)로 넘기고, 이후 세션 마커 정리는 게임 쪽 책임.
 */
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const sessions = require('./sessions');
const wallet = require('./wallet');
const profile = require('./profile');
const { displayName, unixIn, runExclusive, runSoon, attachLive, captureMessage } = require('../utils/table');
const { COLOR, ephemeral, busyText } = require('../utils/format');

const lobbies = new Map();
const cid = (l, action) => `${l.spec.prefix}:*:${action}:${l.id}`;

function render(l, note = '', { closed = false } = {}) {
  const full = l.humans.length >= l.spec.maxHumans;
  const embed = new EmbedBuilder()
    .setColor(closed ? COLOR.push : COLOR.info)
    .setTitle(l.spec.title)
    .setDescription(
      [
        ...l.spec.info(l),
        `🧑 사람 **${l.humans.length}/${l.spec.maxHumans}** · 🤖 봇 **${l.spec.bots}**`,
        '',
        l.humans.map((h, k) => `\`${k + 1}\` 🧑 ${h.name}${h.id === l.hostId ? ' 👑' : ''}`).join('\n'),
        l.spec.bots ? `🤖 봇 ${l.spec.bots}명 대기 중 (성향은 게임이 끝나면 공개)` : '',
        '',
        note || `⏳ <t:${l.endsAt}:R> 자동 시작 (${l.spec.minSeats}좌석 이상일 때) · 👑 호스트는 바로 시작 가능`,
      ].join('\n'),
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid(l, 'join')).setLabel('참가').setEmoji('🙋').setStyle(ButtonStyle.Success).setDisabled(closed || full),
    new ButtonBuilder().setCustomId(cid(l, 'leave')).setLabel('나가기').setEmoji('🚪').setStyle(ButtonStyle.Secondary).setDisabled(closed),
    new ButtonBuilder().setCustomId(cid(l, 'start')).setLabel('시작').setEmoji('▶️').setStyle(ButtonStyle.Primary).setDisabled(closed),
    new ButtonBuilder().setCustomId(cid(l, 'cancel')).setLabel('취소').setEmoji('✖️').setStyle(ButtonStyle.Danger).setDisabled(closed),
  );
  return { embeds: [embed], components: closed ? [] : [row] };
}

const seats = (l) => l.humans.length + l.spec.bots;

/**
 * @param spec { prefix, game, sessionScope?, busyText?, allow(userId)→거절 사유|null (비공개 방), title, info(l)→string[], maxHumans, bots, minSeats, lobbyMs, entryCheck(userId, guildId)→사유|null, onStart(l) }
 */
async function open(i, spec) {
  const denied = spec.allow ? await spec.allow(i.user.id) : null;
  if (denied) return i.reply(ephemeral(denied));
  const marker = sessions.start(i.user.id, spec.game, {}, { persistent: true, scope: spec.sessionScope });
  if (!marker) return i.reply(ephemeral(spec.busyText ?? busyText));
  await i.deferReply();
  const reason = await spec.entryCheck(i.user.id, i.guildId).catch((e) => e.message);
  if (reason) {
    sessions.end(marker);
    return i.editReply(reason);
  }
  const l = { id: i.id, spec, hostId: i.user.id, guildId: i.guildId, channelId: i.channelId, humans: [], state: 'lobby', ui: i, busy: false, timers: {}, endsAt: unixIn(spec.lobbyMs) };
  attachLive(l);
  lobbies.set(l.id, l);
  const host = { id: i.user.id, name: displayName(i), marker, privateEdit: null, cos: await profile.cosmeticsOf(i.user.id) };
  l.humans.push(host);

  const solo = spec.maxHumans === 1;
  await i.editReply(render(l, solo ? '🃏 딜링 준비 중...' : ''));
  await captureMessage(l, i);
  try {
    const msg = await i.followUp({ content: '🃏 게임이 시작되면 이 메시지에 내 패가 표시됩니다. (나에게만 보임)', flags: MessageFlags.Ephemeral });
    host.privateEdit = (p) => i.webhook.editMessage(msg, p);
  } catch (err) {
    console.warn('[lobby] 호스트 비공개 메시지 실패:', err.message);
  }
  if (solo) return runExclusive(l, () => start(l));
  l.timers.lobby = setTimeout(() => runSoon(l, () => (seats(l) >= spec.minSeats ? start(l) : cancel(l, '⌛ 인원이 모이지 않아 취소되었습니다.'))), spec.lobbyMs);
  return undefined;
}

async function start(l) {
  if (l.state !== 'lobby') return;
  l.state = 'started';
  clearTimeout(l.timers.lobby);
  lobbies.delete(l.id);
  await l.spec.onStart(l);
}

async function cancel(l, reason) {
  if (l.state !== 'lobby') return;
  l.state = 'closed';
  clearTimeout(l.timers.lobby);
  lobbies.delete(l.id);
  for (const h of l.humans) sessions.end(h.marker);
  await l.live.final(render(l, reason, { closed: true })).catch(() => {});
}

const LOBBY_ACTIONS = ['join', 'leave', 'start', 'cancel'];

async function handleButton(i, action, lobbyId) {
  const l = lobbies.get(lobbyId);
  if (!l) return i.reply(ephemeral('이미 시작됐거나 닫힌 로비예요.'));
  const uid = i.user.id;

  if (action === 'join') {
    if (l.humans.some((h) => h.id === uid)) return i.reply(ephemeral('이미 참가했어요.'));
    if (l.humans.length >= l.spec.maxHumans) return i.reply(ephemeral('자리가 꽉 찼어요.'));
    const denied = l.spec.allow ? await l.spec.allow(uid) : null; // 비공개 방: 멤버만
    if (denied) return i.reply(ephemeral(denied));
    const marker = sessions.start(uid, l.spec.game, {}, { persistent: true, scope: l.spec.sessionScope });
    if (!marker) return i.reply(ephemeral(l.spec.busyText ?? busyText));
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const reason = await l.spec.entryCheck(uid, l.guildId).catch((e) => e.message);
    if (reason || l.state !== 'lobby' || l.humans.length >= l.spec.maxHumans) {
      sessions.end(marker);
      return i.editReply(reason || '그 사이에 자리가 찼거나 게임이 시작됐어요.');
    }
    l.humans.push({ id: uid, name: displayName(i), marker, privateEdit: (p) => i.editReply(p), cos: await profile.cosmeticsOf(uid) });
    await i.editReply('✅ 참가 완료! 게임이 시작되면 이 메시지에 내 패가 표시됩니다. (나에게만 보임)');
    if (l.humans.length >= l.spec.maxHumans) return runSoon(l, () => start(l));
    l.live.push(render(l));
    return undefined;
  }
  if (action === 'leave') {
    if (uid === l.hostId) return i.reply(ephemeral('호스트는 취소 버튼을 사용하세요.'));
    const k = l.humans.findIndex((h) => h.id === uid);
    if (k < 0) return i.reply(ephemeral('참가하지 않은 로비예요.'));
    const [h] = l.humans.splice(k, 1);
    sessions.end(h.marker);
    await i.reply(ephemeral('🚪 로비에서 나왔어요.'));
    l.live.push(render(l));
    return undefined;
  }
  if (uid !== l.hostId) return i.reply(ephemeral('👑 호스트만 할 수 있어요.'));
  if (action === 'start' && seats(l) < l.spec.minSeats) return i.reply(ephemeral(`최소 ${l.spec.minSeats}좌석(사람 + 봇)이 필요해요.`));
  await i.deferUpdate();
  l.ui = i;
  if (action === 'cancel') return runExclusive(l, () => cancel(l, '✖️ 호스트가 취소했습니다.'));
  return runExclusive(l, () => start(l));
}

module.exports = { open, handleButton, LOBBY_ACTIONS, render };
