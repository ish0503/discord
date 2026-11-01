/**
 * /클랜 — 이용자 모임(클랜). 서버 안에서만 존재하고, 경험치는 칩과 분리된다.
 * 권한 검사·입력 검증은 services/clan.js 에서 (명령어는 화면만).
 */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('../config');
const clan = require('../services/clan');
const rules = require('../content/clan');
const { COLOR, chips, num, ephemeral } = require('../utils/format');

const C = config.CLAN;
const ROLE_CHOICES = [
  { name: '부클랜장', value: 'officer' },
  { name: '멤버', value: 'member' },
];
const LOG_TEXT = { create: '창설', apply: '가입 신청', join: '가입', reject: '신청 거절', leave: '탈퇴', kick: '추방', role: '직책 변경', transfer: '클랜장 위임', settings: '설정 변경', levelup: '레벨업', achievement: '클랜 업적', weekly1: '주간 1위', season1: '시즌 1위', disband: '해산', 'admin-disband': '관리자 해산' };

function infoEmbed(r) {
  const c = r.clan;
  const next = rules.expForLevel(c.level + 1);
  const owner = r.members.find((m) => m.role === 'owner');
  const achNames = (c.achievements || []).map((id) => rules.CLAN_ACHIEVEMENTS.find((a) => a.id === id)?.name).filter(Boolean);
  return new EmbedBuilder()
    .setColor(COLOR.info)
    .setTitle(`${c.emblem} [${c.tag}] ${c.name} · Lv.${c.level}`)
    .setDescription(
      [
        c.description || '_소개가 없어요_',
        c.notice ? `\n📢 **공지** ${c.notice}` : '',
        '',
        `👑 클랜장 <@${owner?.userId ?? c.ownerId}> · 👥 ${c.memberCount}/${rules.maxMembers(c.level)}명`,
        `✨ 경험치 ${num(c.exp)}${c.level < C.MAX_LEVEL ? ` / 다음 레벨 ${num(next)}` : ' (최대 레벨)'} · 이번 주 ${num(c.weekly?.exp ?? 0)}`,
        achNames.length ? `🏅 클랜 업적: ${achNames.join(' · ')}` : '',
        r.pending.length ? `📨 대기 중인 신청 ${r.pending.length}건` : '',
        '',
        '**최근 활동**',
        r.logs.map((l) => `<t:${Math.floor(new Date(l.at).getTime() / 1000)}:R> ${LOG_TEXT[l.type] ?? l.type}${l.targetId ? ` <@${l.targetId}>` : l.actorId ? ` <@${l.actorId}>` : ''}${l.detail?.to ? ` → Lv.${l.detail.to}` : ''}${l.detail?.name ? ` 「${l.detail.name}」` : ''}`).join('\n') || '-',
      ]
        .filter((x) => x !== '')
        .join('\n')
        .slice(0, 4096),
    )
    .setFooter({ text: '클랜 경험치는 플레이 횟수·승리로 쌓이고 칩과는 무관해요 · 멤버당 하루 기여 상한 있음' });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('클랜')
    .setDescription('클랜(이용자 길드) — 함께 레벨을 올리고 주간·시즌 순위를 다퉈요')
    .addSubcommand((s) =>
      s
        .setName('생성')
        .setDescription(`클랜 만들기 (비용 ${C.CREATE_COST.toLocaleString('en-US')}칩)`)
        .addStringOption((o) => o.setName('이름').setDescription('한글·영문·숫자 2~16자').setRequired(true).setMaxLength(16))
        .addStringOption((o) => o.setName('태그').setDescription('2~5자 (예: FIRE)').setRequired(true).setMaxLength(5))
        .addStringOption((o) => o.setName('엠블럼').setDescription('클랜 문양').addChoices(...rules.EMBLEMS.map((e) => ({ name: e, value: e }))))
        .addStringOption((o) => o.setName('소개').setDescription('100자 이하').setMaxLength(100)),
    )
    .addSubcommand((s) => s.setName('신청').setDescription('클랜 가입 신청').addStringOption((o) => o.setName('이름').setDescription('클랜 이름').setRequired(true)))
    .addSubcommand((s) => s.setName('신청취소').setDescription('보낸 가입 신청 취소').addStringOption((o) => o.setName('이름').setDescription('클랜 이름').setRequired(true)))
    .addSubcommand((s) => s.setName('신청목록').setDescription('내 클랜에 온 가입 신청 (부클랜장 이상)'))
    .addSubcommand((s) => s.setName('승인').setDescription('가입 승인 (부클랜장 이상)').addUserOption((o) => o.setName('유저').setDescription('대상').setRequired(true)))
    .addSubcommand((s) => s.setName('거절').setDescription('가입 거절 (부클랜장 이상)').addUserOption((o) => o.setName('유저').setDescription('대상').setRequired(true)))
    .addSubcommand((s) => s.setName('탈퇴').setDescription('클랜 탈퇴'))
    .addSubcommand((s) => s.setName('추방').setDescription('멤버 추방 (자신보다 낮은 직책)').addUserOption((o) => o.setName('유저').setDescription('대상').setRequired(true)))
    .addSubcommand((s) =>
      s
        .setName('직책')
        .setDescription('멤버 직책 변경 (클랜장)')
        .addUserOption((o) => o.setName('유저').setDescription('대상').setRequired(true))
        .addStringOption((o) => o.setName('직책').setDescription('직책').setRequired(true).addChoices(...ROLE_CHOICES)),
    )
    .addSubcommand((s) => s.setName('위임').setDescription('클랜장 넘기기 (클랜장)').addUserOption((o) => o.setName('유저').setDescription('새 클랜장').setRequired(true)))
    .addSubcommand((s) =>
      s
        .setName('설정')
        .setDescription('소개·엠블럼·공지 변경 (부클랜장 이상)')
        .addStringOption((o) => o.setName('소개').setDescription('100자 이하').setMaxLength(100))
        .addStringOption((o) => o.setName('엠블럼').setDescription('클랜 문양').addChoices(...rules.EMBLEMS.map((e) => ({ name: e, value: e }))))
        .addStringOption((o) => o.setName('공지').setDescription('클랜 공지 (200자 이하, 클랜 채널에 알림)').setMaxLength(200)),
    )
    .addSubcommand((s) => s.setName('해산').setDescription('클랜 해산 (클랜장)').addStringOption((o) => o.setName('확인').setDescription('클랜 이름을 정확히 입력').setRequired(true)))
    .addSubcommand((s) => s.setName('정보').setDescription('클랜 정보').addStringOption((o) => o.setName('이름').setDescription('클랜 이름 (비우면 내 클랜)')))
    .addSubcommand((s) => s.setName('멤버').setDescription('클랜 멤버와 기여도').addStringOption((o) => o.setName('이름').setDescription('클랜 이름 (비우면 내 클랜)')))
    .addSubcommand((s) =>
      s
        .setName('순위')
        .setDescription('클랜 순위')
        .addStringOption((o) => o.setName('기간').setDescription('기간').addChoices({ name: '이번 주', value: 'weekly' }, { name: '이번 시즌', value: 'season' }, { name: '누적', value: 'all' })),
    ),

  async execute(i) {
    const sub = i.options.getSubcommand();
    const g = i.guildId;
    const u = i.user.id;
    const target = () => i.options.getUser('유저', true);
    const done = (r, okText, pub = false) => (r.ok ? i.reply(pub ? { content: okText, allowedMentions: { parse: [] } } : ephemeral(okText)) : i.reply(ephemeral(`❌ ${r.reason}`)));

    if (sub === '생성') {
      await i.deferReply();
      const r = await clan.create({ guildId: g, userId: u, name: i.options.getString('이름', true), tag: i.options.getString('태그', true), description: i.options.getString('소개') ?? '', emblem: i.options.getString('엠블럼') ?? '🛡️', channelId: i.channelId });
      if (!r.ok) return i.editReply(`❌ ${r.reason}`);
      return i.editReply({ content: `🎉 클랜 ${r.clan.emblem} **[${r.clan.tag}] ${r.clan.name}** 창설! (비용 ${chips(C.CREATE_COST)}) — 이 채널에 클랜 소식이 올라와요.`, allowedMentions: { parse: [] } });
    }
    if (sub === '신청') {
      const r = await clan.apply({ guildId: g, userId: u, name: i.options.getString('이름', true) });
      return done(r, r.ok ? `📨 **${r.clan.name}** 에 가입 신청했어요. 승인되면 소속돼요.` : '');
    }
    if (sub === '신청취소') return done(await clan.cancelApplication({ guildId: g, userId: u, name: i.options.getString('이름', true) }), '신청을 취소했어요.');
    if (sub === '신청목록') {
      const me = await clan.membership(g, u);
      if (!me || !rules.CAN.approve(me.role)) return i.reply(ephemeral('부클랜장 이상만 볼 수 있어요.'));
      const r = await clan.info(g, { userId: u });
      return i.reply(ephemeral(r.pending.length ? `📨 대기 중인 신청\n${r.pending.map((p) => `- <@${p.userId}> <t:${Math.floor(new Date(p.createdAt).getTime() / 1000)}:R>`).join('\n')}\n\`/클랜 승인\` · \`/클랜 거절\`` : '대기 중인 신청이 없어요.'));
    }
    if (sub === '승인' || sub === '거절') {
      const t = target();
      const r = await clan.decide({ guildId: g, actorId: u, targetId: t.id, approve: sub === '승인' });
      return done(r, r.approved ? `✅ <@${t.id}> 님이 **${r.clan?.name}** 에 합류했어요!` : `거절했어요.`, r.approved);
    }
    if (sub === '탈퇴') {
      const r = await clan.leave({ guildId: g, userId: u });
      return done(r, `🚪 **${r.clan?.name}** 에서 탈퇴했어요. ${Math.round(C.REJOIN_COOLDOWN_MS / 3600_000)}시간 동안 다른 클랜에 가입할 수 없어요. (쌓은 기여는 클랜에 남아요)`);
    }
    if (sub === '추방') {
      const t = target();
      return done(await clan.kick({ guildId: g, actorId: u, targetId: t.id }), `🥾 <@${t.id}> 님을 추방했어요.`);
    }
    if (sub === '직책') {
      const t = target();
      return done(await clan.setRole({ guildId: g, actorId: u, targetId: t.id, role: i.options.getString('직책', true) }), `직책을 바꿨어요.`);
    }
    if (sub === '위임') {
      const t = target();
      return done(await clan.transfer({ guildId: g, actorId: u, targetId: t.id }), `👑 클랜장을 <@${t.id}> 님에게 넘겼어요. (나는 부클랜장)`, true);
    }
    if (sub === '설정') return done(await clan.settings({ guildId: g, actorId: u, description: i.options.getString('소개'), emblem: i.options.getString('엠블럼'), notice: i.options.getString('공지') }), '클랜 설정을 바꿨어요.');
    if (sub === '해산') {
      const r = await clan.disband({ guildId: g, actorId: u, confirmName: i.options.getString('확인', true) });
      return done(r, `🏳️ 클랜 **${r.clan?.name}** 이(가) 해산됐어요. (멤버 ${r.members}명)`, true);
    }
    if (sub === '정보' || sub === '멤버') {
      const name = i.options.getString('이름');
      const r = await clan.info(g, name ? { name } : { userId: u });
      if (!r) return i.reply(ephemeral(name ? '그런 이름의 클랜이 없어요.' : '소속된 클랜이 없어요. `/클랜 신청` 또는 `/클랜 생성`'));
      if (sub === '정보') return i.reply({ embeds: [infoEmbed(r)], allowedMentions: { parse: [] } });
      const embed = new EmbedBuilder()
        .setColor(COLOR.info)
        .setTitle(`${r.clan.emblem} [${r.clan.tag}] ${r.clan.name} · 멤버 ${r.members.length}명`)
        .setDescription(r.members.map((m, k) => `\`${k + 1}\` ${rules.ROLES[m.role]?.label ?? m.role} <@${m.userId}> · 기여 ${num(m.contribution)} · 이번 주 ${num(m.weekly?.exp ?? 0)} · <t:${Math.floor(new Date(m.joinedAt).getTime() / 1000)}:d> 가입`).join('\n').slice(0, 4096));
      return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }
    // 순위
    const kind = i.options.getString('기간') ?? 'weekly';
    const list = (await clan.ranking(g, kind)).slice(0, 10);
    const embed = new EmbedBuilder()
      .setColor(COLOR.gold)
      .setTitle(`🛡️ 클랜 순위 · ${{ weekly: '이번 주', season: '이번 시즌', all: '누적' }[kind]}`)
      .setDescription(list.map((x, k) => `${['🥇', '🥈', '🥉'][k] ?? `\`${k + 1}\``} ${x.clan.emblem} **[${x.clan.tag}] ${x.clan.name}** Lv.${x.clan.level} · ${num(x.score)} · ${x.clan.memberCount}명`).join('\n') || '_아직 클랜이 없어요. `/클랜 생성`_')
      .setFooter({ text: '주간 1위는 클랜 업적, 시즌 1위는 명예의 전당에 올라요' });
    return i.reply({ embeds: [embed] });
  },
};
