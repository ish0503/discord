/** /보스 — 서버 월드 보스 협동 이벤트 (상태 · 공격 · 순위 · 기록). 공격은 무료, 하루 횟수 제한 */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('../config');
const boss = require('../services/worldBoss');
const bosses = require('../content/bosses');
const { COLOR, num, ephemeral } = require('../utils/format');

const B = config.BOSS;
const unix = (d) => Math.floor(new Date(d).getTime() / 1000);

function statusEmbed(b, def, extra = []) {
  const hp = Math.max(0, b.hp);
  return new EmbedBuilder()
    .setColor(b.phase === 3 ? COLOR.lose : COLOR.gold)
    .setTitle(`${def.emoji} ${def.name} · ${b.phase}페이즈${b.phase === 3 ? ' 🔥광폭화' : ''}`)
    .setDescription(
      [
        `_${def.flavor}_`,
        '',
        `❤️ \`${bosses.hpBar(hp, b.maxHp)}\` **${num(hp)} / ${num(b.maxHp)}** (${((hp / b.maxHp) * 100).toFixed(1)}%)`,
        `⏰ <t:${unix(b.endsAt)}:R> 도망 · 공격은 하루 ${B.DAILY_ATTEMPTS}회 (무료) · 평소 게임 1판마다 지원 피해 (하루 ${B.PASSIVE_DAILY_CAP}까지)`,
        ...extra,
      ].join('\n'),
    )
    .setFooter({
      text: `보상: 참여 보스 카드 · 처치 시 황금 카드 + 칩(최대 ${B.CHIP_REWARD_CAP.toLocaleString('en-US')}, 계정 ${B.MIN_ACCOUNT_AGE_DAYS}일 이상·이 서버 ${B.MIN_GAMES_FOR_CHIPS}판 이상·기여 ${B.MIN_CONTRIBUTION} 이상) · 보상은 종료 즉시 지급`,
    });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('보스')
    .setDescription('월드 보스 — 서버 모두가 함께 쓰러뜨리는 협동 이벤트')
    .addSubcommand((s) => s.setName('상태').setDescription('보스 체력·남은 시간·내 기여도'))
    .addSubcommand((s) => s.setName('공격').setDescription(`보스 공격 (무료, 하루 ${B.DAILY_ATTEMPTS}회)`))
    .addSubcommand((s) => s.setName('순위').setDescription('개인·클랜 기여도 순위'))
    .addSubcommand((s) => s.setName('기록').setDescription('지난 보스 기록과 보스 도감')),

  async execute(i) {
    const sub = i.options.getSubcommand();
    if (sub === '기록') {
      const h = await boss.history(i.guildId);
      const embed = new EmbedBuilder()
        .setColor(COLOR.info)
        .setTitle('📕 보스 도감 · 기록')
        .setDescription(
          [
            '**도감** (이 서버가 처치한 보스)',
            bosses.BOSSES.map((d) => `${h.defeatedDefs.includes(d.id) ? d.emoji : '❔'} ${h.defeatedDefs.includes(d.id) ? d.name : '???'}`).join('\n'),
            '',
            '**지난 보스**',
            h.list.map((b) => `${b.status === 'defeated' ? '🏆' : '💨'} ${bosses.byId[b.defId]?.name ?? b.defId} · <t:${unix(b.endedAt ?? b.endsAt)}:d> · ${b.status === 'defeated' ? '처치' : '도망'}`).join('\n') || '_아직 없어요_',
          ].join('\n'),
        );
      return i.reply({ embeds: [embed] });
    }
    const b = await boss.active(i.guildId);
    if (!b) return i.reply(ephemeral('지금은 출현한 보스가 없어요. 관리자가 `/관리자 보스시작` 으로 소환할 수 있어요. 지난 기록은 `/보스 기록`'));
    const def = bosses.byId[b.defId];
    if (sub === '공격') {
      const r = await boss.attack({ guildId: i.guildId, userId: i.user.id });
      if (!r.ok) return i.reply(ephemeral(`❌ ${r.reason}`));
      const line = `🎲 ${r.roll.join(' + ')}${r.crit ? ' **더블! 치명타 ×2**' : ''} → <@${i.user.id}> 의 공격 **${num(r.dmg)}** 피해! (오늘 남은 공격 ${r.left}회 · 내 기여 ${num(r.contribution)})`;
      const embed = statusEmbed(r.boss, def, ['', line]);
      if (r.boss.hp <= 0 || r.boss.status !== 'active') embed.setTitle(`🏆 ${def.emoji} ${def.name} 처치!`);
      return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }
    if (sub === '순위') {
      const r = await boss.ranking(b.bossId);
      const clanDocs = await require('../db/Clan').find({ clanId: { $in: r.clans.map(([id]) => id) } }).lean();
      const embed = new EmbedBuilder()
        .setColor(COLOR.gold)
        .setTitle(`${def.emoji} 기여도 순위 · 참여 ${r.participants}명`)
        .setDescription(
          [
            '**개인**',
            r.personal.map((c, k) => `${['🥇', '🥈', '🥉'][k] ?? `\`${k + 1}\``} <@${c.userId}> ${num(c.contribution)} (공격 ${c.attempts}회)`).join('\n') || '-',
            '',
            '**클랜**',
            r.clans.map(([id, v], k) => {
              const c = clanDocs.find((x) => x.clanId === id);
              return `\`${k + 1}\` ${c ? `${c.emblem} [${c.tag}] ${c.name}` : '(해산된 클랜)'} ${num(v)}`;
            }).join('\n') || '-',
            '',
            `서버 누적 피해 ${num(r.total)}`,
          ].join('\n'),
        );
      return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }
    const mine = await boss.myContribution(i.guildId, i.user.id);
    return i.reply({ embeds: [statusEmbed(b, def, ['', `🗡️ 내 기여 ${num(mine?.contribution ?? 0)} · 오늘 공격 ${mine?.day === require('../content/time').dayKey() ? mine.attemptsToday : 0}/${B.DAILY_ATTEMPTS}`])] });
  },
};
