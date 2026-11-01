/** /라이벌 — 서로 동의한 라이벌과의 맞대결 기록 (포커·토너먼트에서 함께 앉은 실제 게임) */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const rival = require('../services/rival');
const time = require('../content/time');
const { COLOR, ephemeral } = require('../utils/format');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('라이벌')
    .setDescription('라이벌 — 서로 동의한 상대와의 맞대결 기록·주간 도전')
    .addSubcommand((s) => s.setName('신청').setDescription('라이벌 신청 (상대가 수락해야 맺어져요)').addUserOption((o) => o.setName('유저').setDescription('상대').setRequired(true)))
    .addSubcommand((s) => s.setName('수락').setDescription('받은 신청 수락').addUserOption((o) => o.setName('유저').setDescription('신청한 사람').setRequired(true)))
    .addSubcommand((s) => s.setName('거절').setDescription('받은 신청 거절').addUserOption((o) => o.setName('유저').setDescription('신청한 사람').setRequired(true)))
    .addSubcommand((s) => s.setName('해제').setDescription('라이벌 관계 끝내기').addUserOption((o) => o.setName('유저').setDescription('상대').setRequired(true)))
    .addSubcommand((s) => s.setName('정보').setDescription('라이벌 목록과 맞대결 전적').addUserOption((o) => o.setName('유저').setDescription('특정 상대와의 전적')))
    .addSubcommand((s) => s.setName('도전').setDescription(`이번 주 라이벌 도전 (공개 게임에서 라이벌에게 ${rival.WEEKLY_GOAL}승)`)),

  async execute(i) {
    const sub = i.options.getSubcommand();
    const g = i.guildId;
    const u = i.user.id;
    if (sub === '신청') {
      const t = i.options.getUser('유저', true);
      const r = await rival.request({ guildId: g, from: u, to: t.id, isBot: !!t.bot });
      if (!r.ok) return i.reply(ephemeral(`❌ ${r.reason}`));
      // 상대에게는 이 한 번만 알림 (수락 전까지 추가 알림 없음)
      return i.reply({ content: `⚔️ <@${u}> 님이 <@${t.id}> 님에게 라이벌을 신청했어요! \`/라이벌 수락\` 으로 받아들일 수 있어요.`, allowedMentions: { users: [t.id] } });
    }
    if (sub === '수락' || sub === '거절') {
      const t = i.options.getUser('유저', true);
      const r = await rival.respond({ guildId: g, userId: u, other: t.id, accept: sub === '수락' });
      if (!r.ok) return i.reply(ephemeral(`❌ ${r.reason}`));
      return r.accepted ? i.reply({ content: `🔥 <@${u}> ⚔️ <@${t.id}> 라이벌 성립!`, allowedMentions: { parse: [] } }) : i.reply(ephemeral('신청을 거절했어요.'));
    }
    if (sub === '해제') {
      const t = i.options.getUser('유저', true);
      const r = await rival.end({ guildId: g, userId: u, other: t.id });
      return i.reply(ephemeral(r.ok ? '라이벌 관계를 끝냈어요. (전적은 남아요)' : `❌ ${r.reason}`));
    }
    const all = await rival.list(g, u);
    const active = all.filter((x) => x.status === 'active');
    const wk = time.weekKey();
    const line = (x) => {
      const other = x.a === u ? x.b : x.a;
      const mine = x.a === u ? x.aWins : x.bWins;
      const theirs = x.a === u ? x.bWins : x.aWins;
      const wkWins = x.weekly?.key === wk ? x.weekly.wins?.[u] ?? 0 : 0;
      const streak = x.streakHolder ? `${x.streakHolder === u ? '내' : '상대'} ${x.streak}연승 중` : '';
      return { other, text: `⚔️ <@${other}> **${mine}승 ${theirs}패**${x.draws ? ` ${x.draws}무` : ''}${streak ? ` · ${streak}` : ''} · 이번 주 ${wkWins}/${rival.WEEKLY_GOAL}승${x.weeklyClaimed?.includes(`${u}:${wk}`) ? ' ✅' : ''} · 내 최고 연승 ${x.bestStreak?.[u] ?? 0}` };
    };
    if (sub === '도전') {
      const embed = new EmbedBuilder()
        .setColor(COLOR.gold)
        .setTitle('🎯 이번 주 라이벌 도전')
        .setDescription(
          [`목표: **공개 게임**(포커·토너먼트)에서 라이벌에게 **${rival.WEEKLY_GOAL}승** → ⭐ ${rival.WEEKLY_POINTS}P (라이벌별 주 1회)`, '비공개 방 맞대결은 전적에는 남지만 도전·업적에는 세지 않아요.', '', ...active.map((x) => line(x).text)].join('\n') || '라이벌이 없어요.',
        );
      return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }
    const t = i.options.getUser('유저');
    const list = t ? active.filter((x) => line(x).other === t.id) : active;
    const pending = all.filter((x) => x.status === 'pending');
    const embed = new EmbedBuilder()
      .setColor(COLOR.info)
      .setTitle(`⚔️ 라이벌 ${active.length}/${rival.MAX}`)
      .setDescription(
        [
          ...list.map((x) => line(x).text),
          pending.length ? `\n📨 대기 중: ${pending.map((x) => `<@${x.a === u ? x.b : x.a}>${x.requestedBy === u ? ' (내가 신청)' : ' (받은 신청)'}`).join(', ')}` : '',
        ].join('\n') || '_라이벌이 없어요. `/라이벌 신청`_',
      )
      .setFooter({ text: '두 사람이 같은 포커 핸드·토너먼트에 함께 앉았을 때만 기록돼요' });
    return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};
