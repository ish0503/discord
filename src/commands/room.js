/**
 * /방 — 비공개 게임방 & 초대전 (포커페이스·미니 토너먼트).
 * 참가·베팅은 기존 로비·에스크로 정산 그대로, 방장은 결과·잔액을 바꿀 수 없다.
 * 방 판은 전적에 🔒 로 따로 표시되고 랭크 리그·명예의 전당에서 제외된다.
 */
const { SlashCommandBuilder, EmbedBuilder, ChannelType } = require('discord.js');
const rooms = require('../services/privateRoom');
const notifier = require('../services/notifier');
const registry = require('../games/registry');
const { COLOR, num, netText, ephemeral } = require('../utils/format');

async function addToThread(threadId, userId) {
  try {
    const t = await notifier.client?.channels.fetch(threadId);
    await t?.members?.add(userId);
  } catch {
    /* 권한 없음 등 — 무시 (참가 자체는 성공) */
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('방')
    .setDescription('비공개 게임방 — 초대 코드로 친구끼리 포커·미니 토너먼트')
    .addSubcommand((s) =>
      s
        .setName('만들기')
        .setDescription('비공개 방 만들기 (초대 코드는 나에게만 보여요)')
        .addStringOption((o) => o.setName('이름').setDescription('방 이름').setRequired(true).setMaxLength(30))
        .addStringOption((o) => o.setName('게임').setDescription('게임').setRequired(true).addChoices({ name: '포커페이스', value: 'poker' }, { name: '미니 토너먼트', value: 'tournament' }))
        .addIntegerOption((o) => o.setName('금액').setDescription('바이인/참가비').setRequired(true).setMinValue(1000))
        .addIntegerOption((o) => o.setName('봇').setDescription('봇 수 (기본 0)').setMinValue(0).setMaxValue(6))
        .addIntegerOption((o) => o.setName('최대인원').setDescription('사람 최대 인원 (기본 4)').setMinValue(2).setMaxValue(8))
        .addBooleanOption((o) => o.setName('관전허용').setDescription('멤버가 아닌 사람도 구경 가능 (기본 허용)'))
        .addBooleanOption((o) => o.setName('승인제').setDescription('코드로 들어와도 방장 승인 필요 (기본 아님)')),
    )
    .addSubcommand((s) => s.setName('참가').setDescription('초대 코드로 참가 (코드 없이 쓰면 초대받은 방)').addStringOption((o) => o.setName('코드').setDescription('초대 코드').setMaxLength(20)))
    .addSubcommand((s) => s.setName('초대').setDescription('유저 초대 (방장)').addUserOption((o) => o.setName('유저').setDescription('대상').setRequired(true)))
    .addSubcommand((s) => s.setName('승인').setDescription('참가 요청 승인 (방장)').addUserOption((o) => o.setName('유저').setDescription('대상').setRequired(true)))
    .addSubcommand((s) => s.setName('추방').setDescription('멤버 내보내기 (방장)').addUserOption((o) => o.setName('유저').setDescription('대상').setRequired(true)))
    .addSubcommand((s) => s.setName('나가기').setDescription('방에서 나가기'))
    .addSubcommand((s) =>
      s
        .setName('설정')
        .setDescription('관전·승인제 변경, 초대 코드 재발급 (방장)')
        .addBooleanOption((o) => o.setName('관전허용').setDescription('관전 허용'))
        .addBooleanOption((o) => o.setName('승인제').setDescription('승인제'))
        .addBooleanOption((o) => o.setName('코드재발급').setDescription('새 초대 코드 (이전 코드는 무효)')),
    )
    .addSubcommand((s) => s.setName('시작').setDescription('방 게임 시작 (방장, 방 스레드에서)'))
    .addSubcommand((s) => s.setName('정보').setDescription('내 방 정보·멤버·게임 기록'))
    .addSubcommand((s) => s.setName('닫기').setDescription('방 닫기 (방장)')),

  async execute(i) {
    const sub = i.options.getSubcommand();
    const g = i.guildId;
    const u = i.user.id;
    const target = () => i.options.getUser('유저', true);
    const done = (r, text) => i.reply(ephemeral(r.ok ? text : `❌ ${r.reason}`));

    if (sub === '만들기') {
      const spectators = i.options.getBoolean('관전허용') ?? true;
      const r = await rooms.create({
        guildId: g,
        ownerId: u,
        name: i.options.getString('이름', true),
        gameType: i.options.getString('게임', true),
        settings: { amount: i.options.getInteger('금액', true), bots: i.options.getInteger('봇') ?? 0, maxHumans: i.options.getInteger('최대인원') ?? 4 },
        spectators,
        approval: i.options.getBoolean('승인제') ?? false,
        channelId: i.channelId,
      });
      if (!r.ok) return i.reply(ephemeral(`❌ ${r.reason}`));
      // 방 스레드: 관전 허용이면 공개, 아니면 비공개(멤버만)
      let thread = null;
      try {
        thread = await i.channel?.threads?.create({ name: `🔒 ${r.room.name}`.slice(0, 100), type: spectators ? ChannelType.PublicThread : ChannelType.PrivateThread, invitable: false, autoArchiveDuration: 1440, reason: '비공개 게임방' });
        if (thread) {
          await thread.members?.add(u).catch(() => {});
          await require('../db/PrivateRoom').updateOne({ roomId: r.room.roomId }, { $set: { threadId: thread.id } });
          await thread.send({ content: `🔒 **${r.room.name}** 방이 열렸어요. 방장 <@${u}> · ${registry.label(r.room.gameType)} · 금액 ${num(r.room.settings.amount)}\n방장은 이 스레드에서 \`/방 시작\` 으로 게임을 열어요.`, allowedMentions: { parse: [] } }).catch(() => {});
        }
      } catch {
        thread = null;
      }
      return i.reply(
        ephemeral(
          `🔒 방 **${r.room.name}** 생성!\n🔑 초대 코드: \`${r.code}\` (지금 한 번만 보여요 — 친구에게 전해 주세요, \`/방 설정 코드재발급:True\` 로 바꿀 수 있어요)\n${thread ? `🧵 방 스레드: <#${thread.id}>` : '스레드를 만들 수 없어 이 채널에서 진행해요.'}\n${spectators ? '👀 관전 허용' : '🙈 관전 비허용 (멤버만 보이는 비공개 스레드)'}${r.room.approval ? ' · ✋ 승인제' : ''} · ⏰ 24시간 뒤 자동으로 닫혀요`,
        ),
      );
    }
    if (sub === '참가') {
      const r = await rooms.join({ guildId: g, userId: u, code: i.options.getString('코드') });
      if (!r.ok) return i.reply(ephemeral(`❌ ${r.reason}`));
      if (r.pending) return i.reply(ephemeral(`✋ **${r.room.name}** 은 승인제예요. 방장이 승인하면 들어가요.`));
      if (r.room.threadId) await addToThread(r.room.threadId, u);
      return i.reply(ephemeral(`✅ **${r.room.name}** 에 ${r.already ? '이미 들어와 있어요' : '들어왔어요'}!${r.room.threadId ? ` 🧵 <#${r.room.threadId}>` : ''}`));
    }
    if (sub === '초대') {
      const t = target();
      const r = await rooms.invite({ guildId: g, ownerId: u, targetId: t.id });
      if (r.ok && r.room.threadId) notifier.send(r.room.threadId, { content: `📨 <@${t.id}> 님, **${r.room.name}** 에 초대됐어요! \`/방 참가\` (코드 없이) 로 들어오세요.`, allowedMentions: { users: [t.id] } });
      return done(r, `📨 <@${t.id}> 님을 초대했어요. (\`/방 참가\` 를 코드 없이 쓰면 들어와요)`);
    }
    if (sub === '승인') {
      const t = target();
      const r = await rooms.approve({ guildId: g, ownerId: u, targetId: t.id });
      if (r.ok && r.room.threadId) await addToThread(r.room.threadId, t.id);
      return done(r, `✅ <@${t.id}> 님 참가를 승인했어요.`);
    }
    if (sub === '추방') {
      const t = target();
      return done(await rooms.kick({ guildId: g, ownerId: u, targetId: t.id }), `🥾 <@${t.id}> 님을 내보냈어요.`);
    }
    if (sub === '나가기') return done(await rooms.leave({ guildId: g, userId: u }), '🚪 방에서 나왔어요.');
    if (sub === '설정') {
      const r = await rooms.settings({ guildId: g, ownerId: u, spectators: i.options.getBoolean('관전허용'), approval: i.options.getBoolean('승인제'), regenerate: i.options.getBoolean('코드재발급') === true });
      return done(r, `⚙️ 설정을 바꿨어요.${r.code ? `\n🔑 새 초대 코드: \`${r.code}\` (이전 코드는 이제 안 돼요)` : ''}`);
    }
    if (sub === '닫기') return done(await rooms.close({ guildId: g, ownerId: u }), '🔒 방을 닫았어요.');
    if (sub === '시작') {
      const room = await rooms.ownedOpen(g, u);
      if (!room) return i.reply(ephemeral('내가 연 방이 없어요. 방장만 시작할 수 있어요.'));
      if (room.threadId && i.channelId !== room.threadId) return i.reply(ephemeral(`방 스레드 <#${room.threadId}> 에서 \`/방 시작\` 해 주세요.`));
      const pr = { roomId: room.roomId, name: room.name, spectators: room.spectators };
      const st = room.settings;
      if (room.gameType === 'poker') return require('./poker').open(i, { buyin: st.amount, bots: st.bots, maxHumans: st.maxHumans, pr });
      return require('./tournament').open(i, { fee: st.amount, bots: st.bots, maxHumans: st.maxHumans, stack: st.stack, pr });
    }
    // 정보
    const room = await rooms.memberOf(g, u);
    if (!room) return i.reply(ephemeral('참가한 방이 없어요.'));
    const r = await rooms.info(room.roomId);
    const embed = new EmbedBuilder()
      .setColor(COLOR.info)
      .setTitle(`🔒 ${room.name} · ${registry.label(room.gameType)}`)
      .setDescription(
        [
          `👑 방장 <@${room.ownerId}> · 금액 ${num(room.settings.amount)} · 봇 ${room.settings.bots} · 최대 ${room.settings.maxHumans}명`,
          `${room.spectators ? '👀 관전 허용' : '🙈 관전 비허용'}${room.approval ? ' · ✋ 승인제' : ''} · ⏰ <t:${Math.floor(new Date(room.expiresAt).getTime() / 1000)}:R> 자동 종료`,
          `👥 멤버 ${room.members.map((m) => `<@${m}>`).join(' ')}`,
          room.pending.length ? `✋ 승인 대기 ${room.pending.map((m) => `<@${m}>`).join(' ')}` : '',
          '',
          '**방 게임 기록** (전적에 🔒 로 표시 · 랭크·명예의 전당 제외)',
          r.logs.map((l) => `<@${l.userId}> ${registry.label(l.game)} ${netText(l.net)} · <t:${Math.floor(new Date(l.createdAt).getTime() / 1000)}:R> \`${l.roundId.slice(0, 8)}\``).join('\n') || '_아직 없어요_',
        ]
          .filter((x) => x !== '')
          .join('\n')
          .slice(0, 4096),
      );
    return i.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
  },
};
