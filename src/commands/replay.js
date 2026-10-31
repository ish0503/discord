/** /리플레이 — 판 ID(앞부분)로 게임 진행·결과 다시 보기 (GameLog.detail 기반) */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const GameLog = require('../db/GameLog');
const registry = require('../games/registry');
const { COLOR, num, netText, handText } = require('../utils/format');

function describe(l) {
  const d = l.detail || {};
  switch (l.game) {
    case 'blackjack':
      return [`딜러: ${handText(d.dealer || [])}`, ...(d.hands || []).map((h, k) => `손 ${k + 1}: ${handText(h)} → ${d.outcomes?.[k] ?? '?'}`), d.insurance ? `보험 ${num(d.insurance)} → ${d.insurancePaid ? '적중' : '소멸'}` : ''].filter(Boolean);
    case 'baccarat':
      return [`플레이어: ${handText(d.player || [])}`, `뱅커: ${handText(d.banker || [])}`, `승리: ${d.winner} · 내 베팅: ${d.side}${d.natural ? ' · 내추럴' : ''}`];
    case 'slot':
      return [`[ ${(d.reels || []).join(' | ')} ] ×${d.multiplier ?? 0}${d.jackpot ? ` + 잭팟 ${num(d.jackpot)}` : ''}`];
    case 'crash':
      return [`폭발 ${d.crashPoint?.toFixed?.(2)}x · ${d.cashedAt ? `${d.cashedAt.toFixed(2)}x 탈출` : '탈출 실패'}${d.auto ? ` (자동 ${d.auto}x)` : ''}`];
    case 'dice':
      return [`선택 ${d.choice} · 주사위 ${(d.dice || []).join('+')}${d.assisted ? ' · 🍀 보정 재굴림' : ''} · 굴리기 전 연패 ${d.streakBefore ?? 0}`];
    case 'poker':
      return [`내 패 ${handText(d.hole || [])} · 보드 ${handText(d.board || [])}`, `${d.hand ? `족보 ${d.hand}` : '쇼다운 전 종료'} · ${d.seats}인 테이블${d.wentAllIn ? ' · 🔥 올인' : ''}`];
    case 'tournament':
      return [`최종 ${d.place}위 / ${d.entrants}명 · 사람 중 ${d.humanPlace}위 · 상금 ${num(d.prize ?? 0)}`];
    default:
      return [JSON.stringify(d).slice(0, 500)];
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('리플레이')
    .setDescription('지난 판 다시 보기')
    .addStringOption((o) => o.setName('판id').setDescription('판 ID 앞 8자리 이상 (생략 시 내 최근 판)')),
  async execute(i) {
    const id = i.options.getString('판id');
    const q = id ? { roundId: { $regex: `^${id.replace(/[^0-9a-f-]/gi, '')}` } } : { userId: i.user.id };
    const l = await GameLog.findOne(q).sort({ createdAt: -1 }).lean();
    if (!l) return i.reply({ content: '해당 판을 찾지 못했어요.', ephemeral: true });
    const embed = new EmbedBuilder()
      .setColor(l.net > 0 ? COLOR.win : l.net < 0 ? COLOR.lose : COLOR.push)
      .setTitle(`🎞️ 리플레이 · ${registry.label(l.game)}`)
      .setDescription(
        [
          `<@${l.userId}> · <t:${Math.floor(new Date(l.createdAt).getTime() / 1000)}:f>`,
          `베팅 ${num(l.staked)} → 지급 ${num(l.payout)} · **${netText(l.net)}**${l.status === 'refunded' ? ' (환불)' : ''}${l.recovered ? ' · 🔧 장애 복구 정산' : ''}`,
          '',
          ...describe(l),
        ].join('\n'),
      )
      .setFooter({ text: `판 ID ${l.roundId}` });
    return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};
