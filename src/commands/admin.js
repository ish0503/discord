/**
 * /관리자 — 운영 명령어. 권한: 봇 소유자(BOT_OWNER_IDS) ∪ 서버 관리 권한 ∪ 지정 관리자 역할.
 * 상태를 바꾸는 모든 작업은 AuditLog에 기록 (실행자·대상·금액·사유·전후 값).
 */
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const wallet = require('../services/wallet');
const guildConfig = require('../services/guildConfig');
const stats = require('../services/stats');
const seasons = require('../services/seasons');
const events = require('../services/events');
const gameState = require('../services/gameState');
const profile = require('../services/profile');
const outbox = require('../services/outbox');
const settlement = require('../services/settlement');
const scheduler = require('../services/scheduler');
const dashboard = require('../services/dashboard');
const User = require('../db/User');
const Transfer = require('../db/Transfer');
const AuditLog = require('../db/AuditLog');
const registry = require('../games/registry');
const { COLOR, chips, num, netText, ephemeral } = require('../utils/format');

const PERIOD_CHOICES = [
  { name: '24시간', value: '24h' },
  { name: '7일', value: '7d' },
  { name: '30일', value: '30d' },
  { name: '전체', value: 'all' },
];
const GAME_CHOICES = registry.ids().map((id) => ({ name: registry.GAMES[id].label, value: id }));
const pct = (x) => `${(x * 100).toFixed(2)}%`;

function audit(i, action, fields = {}) {
  return AuditLog.create({ guildId: i.guildId, actorId: i.user.id, action, ...fields }).catch((err) => console.error('[audit]', err.message));
}

function validAmount(n) {
  return Number.isSafeInteger(n) && n > 0 && n <= config.ADMIN.MAX_ADJUST;
}

/** 공개 공지 (채널 전체에 보이는 메시지) */
const announce = (title, description, color = COLOR.info, mentions = []) => ({
  announce: new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp(new Date()),
  mentions,
});
/** 공개 모드에서도 실패 안내는 실행자에게만 */
const fail = (text) => ({ fail: text });

/**
 * 공개 메시지로 보낼 하위 명령어 (모두가 알아야 하는 운영 소식).
 * 값이 함수면 상황에 따라 판단 — 예: 지급/회수는 [공개] 옵션을 켰을 때만.
 */
const PUBLIC = {
  이벤트: () => true,
  이벤트종료: async (i) => (await events.active(i.guildId)).length > 0,
  시즌종료: () => true,
  점검: () => true,
  지급: (i) => i.options.getBoolean('공개') === true,
  회수: (i) => i.options.getBoolean('공개') === true,
};

const handlers = {
  async 대시보드(i) {
    const o = await stats.overview(i.guildId, i.options.getString('기간') ?? '7d');
    const gameLines = o.byGame.map((g) => `${registry.label(g._id)} ${num(g.rounds)}판 · 👥${g.players} · 베팅 ${num(g.staked)} · 실제 RTP **${pct(g.payout / Math.max(1, g.staked))}** · 하우스 ${netText(g.staked - g.payout)}`);
    const ledgerLines = o.ledger.map((l) => `${l.amount >= 0 ? '🟢 발행' : '🔴 회수'} ${l._id} ${num(Math.abs(l.amount))} (${l.count}건)`);
    return new EmbedBuilder()
      .setColor(COLOR.info)
      .setTitle(`📊 경제 대시보드 · ${o.period}`)
      .addFields(
        { name: '게임', value: `총 ${num(o.totals.rounds)}판 · 시간당 ${o.gamesPerHour.toFixed(1)}판 · 활성 ${num(o.activePlayers)}명`, inline: false },
        { name: '베팅 / 지급', value: `${chips(o.totals.staked)} / ${chips(o.totals.payout)}\n실제 RTP **${pct(o.totals.rtp)}** · 하우스 순손익 **${netText(o.totals.houseNet)}**`, inline: false },
        { name: '칩 공급', value: `지갑 ${num(o.supply.users)}개 · 유통 ${chips(o.supply.money)} · 게임에 묶임 ${chips(o.supply.escrow)}\n기간 발행 +${num(o.minted)} · 회수 −${num(o.burned)}`, inline: false },
        { name: '장애', value: `복구 정산된 판 ${num(o.recovered)} · 관리자 확인 필요 게임 **${o.needRecovery}**`, inline: false },
        { name: '게임별', value: gameLines.join('\n').slice(0, 1024) || '-', inline: false },
        { name: '게임 외 칩 이동', value: ledgerLines.join('\n').slice(0, 1024) || '-', inline: false },
      )
      .setFooter({ text: 'RTP = 지급액(원금 포함) ÷ 베팅액(더블·스플릿·보험 포함) · 정밀 비교는 /관리자 밸런스' });
  },

  async 밸런스(i) {
    const rows = await stats.balance(i.guildId, i.options.getString('기간') ?? '30d');
    const lines = rows.map((r) => {
      const name = `${registry.label(r.game)}${r.sub ? ` (${r.sub})` : ''}`;
      const design = r.design != null ? pct(r.design) : '—';
      return `${name}: 표본 ${num(r.n)} · 설계 ${design} · 실제 **${pct(r.actual)}** · ${r.verdict}${r.z != null ? ` (z=${r.z.toFixed(1)})` : ''}`;
    });
    return new EmbedBuilder()
      .setColor(COLOR.info)
      .setTitle('⚖️ 설계 RTP vs 실제 RTP')
      .setDescription(lines.join('\n').slice(0, 4096) || '_데이터가 없어요._')
      .setFooter({ text: '표본 200판 이상에서 |z| > 3이면 편차 경고 · 블랙잭·포커는 전략·상대 의존이라 설계값 없음' });
  },

  async 유저(i) {
    const u = i.options.getUser('유저', true);
    const [acc, p, sum, logs] = await Promise.all([wallet.getAccount(u.id, i.guildId), profile.get(u.id), stats.userSummary(u.id, i.guildId), AuditLog.find({ guildId: i.guildId, targetId: u.id }).sort({ createdAt: -1 }).limit(5).lean()]);
    return new EmbedBuilder()
      .setColor(COLOR.info)
      .setTitle(`🔎 ${u.username}`)
      .setDescription(
        [
          `잔고 ${chips(acc.money)} · 묶인 칩 ${chips((acc.escrow || []).reduce((s, e) => s + e.amount, 0))} (${acc.escrow?.length ?? 0}판)`,
          `포인트 ${num(p.rewardPoints)}P · 업적 ${p.achievements.length} · 총 ${num(p.totals.games)}판 · 연속 출석 ${acc.dailyStreak}일`,
          '',
          ...sum.map((g) => `${registry.label(g._id)} ${num(g.rounds)}판 · RTP ${pct(g.payout / Math.max(1, g.staked))} · ${netText(g.net)}`),
          '',
          '**최근 관리 기록**',
          ...logs.map((l) => `<t:${Math.floor(new Date(l.createdAt).getTime() / 1000)}:R> ${l.action} ${l.amount ? num(l.amount) : ''} — ${l.reason ?? ''} (by <@${l.actorId}>)`),
        ].join('\n'),
      );
  },

  async 지급(i) {
    const u = i.options.getUser('유저', true);
    const amount = i.options.getInteger('금액', true);
    const reason = i.options.getString('사유', true).trim();
    if (!validAmount(amount)) return `금액은 1 ~ ${num(config.ADMIN.MAX_ADJUST)} 사이여야 해요.`;
    const before = (await wallet.getAccount(u.id, i.guildId)).money;
    const doc = await wallet.grant({ userId: u.id, guildId: i.guildId, amount, type: 'admin_grant', reason, actorId: i.user.id });
    await audit(i, 'wallet.grant', { targetId: u.id, amount, reason, before, after: doc.money });
    if (i.options.getBoolean('공개')) return announce('🎁 관리자 지급', `<@${u.id}> 님에게 **${chips(amount)}** 지급!\n📝 사유: ${reason}`, COLOR.win, [u.id]);
    return `✅ <@${u.id}> 에게 ${chips(amount)} 지급 (${num(before)} → ${num(doc.money)}) · 사유: ${reason}`;
  },

  async 회수(i) {
    const u = i.options.getUser('유저', true);
    const amount = i.options.getInteger('금액', true);
    const reason = i.options.getString('사유', true).trim();
    if (!validAmount(amount)) return `금액은 1 ~ ${num(config.ADMIN.MAX_ADJUST)} 사이여야 해요.`;
    const before = (await wallet.getAccount(u.id, i.guildId)).money;
    const doc = await wallet.debit({ userId: u.id, guildId: i.guildId, amount, type: 'admin_revoke', reason, actorId: i.user.id });
    if (!doc) return fail(`❌ 잔고(${num(before)})보다 많이 회수할 수 없어요. (게임에 묶인 칩은 회수 대상이 아님)`);
    await audit(i, 'wallet.revoke', { targetId: u.id, amount, reason, before, after: doc.money });
    if (i.options.getBoolean('공개')) return announce('⚖️ 관리자 회수', `<@${u.id}> 님에게서 **${chips(amount)}** 회수\n📝 사유: ${reason}`, COLOR.lose, [u.id]);
    return `✅ <@${u.id}> 에게서 ${chips(amount)} 회수 (${num(before)} → ${num(doc.money)}) · 사유: ${reason}`;
  },

  async 게임(i) {
    const game = i.options.getString('게임', true);
    const enabled = i.options.getBoolean('활성');
    const min = i.options.getInteger('최소');
    const max = i.options.getInteger('최대');
    const before = await guildConfig.get(i.guildId);
    const change = {};
    if (enabled === true) change.$pull = { disabledGames: game };
    if (enabled === false) change.$addToSet = { disabledGames: game };
    const limits = { ...(before.betLimits?.[game] || {}) };
    if (min !== null) limits.min = min;
    if (max !== null) limits.max = max;
    if (limits.min && limits.max && limits.min > limits.max) return '❌ 최소가 최대보다 클 수 없어요.';
    if (min !== null || max !== null) change.$set = { [`betLimits.${game}`]: limits };
    if (!Object.keys(change).length) {
      const l = await guildConfig.betLimits(i.guildId, game);
      return `${registry.label(game)}: ${before.disabledGames.includes(game) ? '⛔ 비활성' : '✅ 활성'} · 베팅 ${num(l.min)} ~ ${num(l.max)}`;
    }
    const after = await guildConfig.update(i.guildId, change);
    await audit(i, 'config.game', { targetId: game, before: { disabled: before.disabledGames.includes(game), limits: before.betLimits?.[game] }, after: { disabled: after.disabledGames.includes(game), limits: after.betLimits?.[game] } });
    const l = await guildConfig.betLimits(i.guildId, game);
    return `✅ ${registry.label(game)}: ${after.disabledGames.includes(game) ? '⛔ 비활성' : '✅ 활성'} · 베팅 ${num(l.min)} ~ ${num(l.max)}`;
  },

  async 점검(i) {
    const on = i.options.getBoolean('켜기', true);
    const message = i.options.getString('메시지') ?? '';
    await guildConfig.update(i.guildId, { $set: { maintenance: { on, message } } });
    await audit(i, 'config.maintenance', { after: { on, message } });
    return on
      ? announce('🛠️ 카지노 점검 중', `지금부터 **새 게임 시작이 잠시 막힙니다.**\n진행 중인 게임은 끝까지 정상 진행·정산돼요.${message ? `\n\n📢 ${message}` : ''}`, COLOR.push)
      : announce('✅ 점검 종료', '카지노가 다시 열렸습니다! 모든 게임을 이용할 수 있어요.', COLOR.win);
  },

  async 감사로그(i) {
    const n = i.options.getInteger('개수') ?? 15;
    const logs = await AuditLog.find({ guildId: i.guildId }).sort({ createdAt: -1 }).limit(n).lean();
    return new EmbedBuilder()
      .setColor(COLOR.info)
      .setTitle('🧾 감사 로그')
      .setDescription(
        logs.map((l) => `<t:${Math.floor(new Date(l.createdAt).getTime() / 1000)}:f> <@${l.actorId}> **${l.action}**${l.targetId ? ` → ${/^\d+$/.test(l.targetId) ? `<@${l.targetId}>` : l.targetId}` : ''}${l.amount ? ` ${num(l.amount)}` : ''}${l.reason ? ` · ${l.reason}` : ''}`).join('\n').slice(0, 4096) || '_기록 없음_',
      );
  },

  async 복구(i) {
    const id = i.options.getString('게임id');
    if (!id) {
      const list = await gameState.listRecovery(i.guildId);
      return list.length ? `🔧 확인 필요 게임:\n${list.map((g) => `\`${g.gameId}\` ${registry.label(g.game)} · ${g.history.at(-1)?.note ?? ''}`).join('\n')}` : '✅ 확인이 필요한 게임이 없어요.';
    }
    // 서버 간 격리: 이 서버의 게임만 재시도 가능
    if (!(await gameState.belongsTo(id, i.guildId))) return '❌ 이 서버의 게임 ID가 아니에요.';
    const out = await gameState.retry(id);
    await audit(i, 'recovery.retry', { targetId: id, after: { settled: out.settled, refunded: out.refunded, failed: out.failed } });
    return `🔧 재시도 결과: 정산 ${out.settled} · 환불 ${out.refunded} · 실패 ${out.failed}`;
  },

  async 시즌종료(i) {
    const r = await seasons.end(i.guildId, { channelId: i.channelId });
    if (!r) return '이미 종료 처리된 시즌이에요.';
    await audit(i, 'season.end', { after: { number: r.closed.number, top: r.closed.results.slice(0, 3) } });
    const top = r.closed.results.slice(0, 5);
    const medal = (k) => ['🥇', '🥈', '🥉'][k] ?? `\`${k + 1}위\``;
    return announce(
      `🏁 시즌 ${r.closed.number} 종료!`,
      [top.map((x, k) => `${medal(k)} <@${x.userId}> ${netText(x.net)} (${num(x.games)}판)`).join('\n') || '참가자 없음', '', `➡️ **시즌 ${r.next.number}** 시작! 모두 새 출발선에서 다시 겨뤄요.`].join('\n'),
      COLOR.gold,
      top.slice(0, 3).map((x) => x.userId),
    );
  },

  async 이벤트(i) {
    const name = i.options.getString('이름', true);
    const multiplier = i.options.getNumber('배수', true);
    const hours = i.options.getInteger('시간', true);
    const e = await events.create({ guildId: i.guildId, name, multiplier, hours, createdBy: i.user.id });
    await audit(i, 'event.create', { after: { name, multiplier, hours } });
    const end = Math.floor(e.endsAt.getTime() / 1000);
    return announce(`🎉 이벤트 시작: ${name}`, [`⭐ 보상 포인트 **×${multiplier}**`, `⏰ <t:${end}:f> 까지 (<t:${end}:R> 종료)`, '', '업적·미션 포인트가 배수로 지급돼요. (게임 확률·배당은 그대로)'].join('\n'), COLOR.gold);
  },

  async 이벤트종료(i) {
    const n = await events.endAll(i.guildId);
    if (!n) return '진행 중인 이벤트가 없어요.';
    await audit(i, 'event.endAll', { amount: n });
    return announce('🔚 이벤트 종료', `진행 중이던 이벤트 ${n}개가 종료되었습니다. 참여해 주셔서 감사합니다!`, COLOR.push);
  },

  async 정산상태(i) {
    const retry = i.options.getBoolean('재시도');
    let retried = 0;
    if (retry) {
      retried = await outbox.retryDead(i.guildId);
      await audit(i, 'outbox.retry', { amount: retried });
    }
    const key = wallet.economyKey(i.guildId);
    const [ob, recs, blockedUsers, pendingTx] = await Promise.all([
      outbox.status(i.guildId),
      settlement.pendingRecords(i.guildId),
      User.find({ guildId: key, 'escrow.blocked': { $ne: null } }, { userId: 1, escrow: 1 }).limit(10).lean(),
      Transfer.countDocuments({ economyKey: key, status: 'pending' }),
    ]);
    const blocked = blockedUsers.flatMap((u) => u.escrow.filter((e) => e.blocked).map((e) => `\`${e.gameId ?? e.roundId}\` <@${u.userId}> ${registry.label(e.game)} ${num(e.amount)} — ${e.blocked.reason}`));
    const jobs = scheduler.status();
    return new EmbedBuilder()
      .setColor(ob.dead || blocked.length || recs.length ? COLOR.lose : COLOR.win)
      .setTitle('🧾 정산·Outbox 상태')
      .addFields(
        { name: 'Outbox 이벤트', value: `대기 ${ob.pending} · 처리 중 ${ob.processing} · 재시도 대기 ${ob.failed} · **포기(dead) ${ob.dead}**${retry ? `\n🔁 ${retried}건 재시도 예약` : ''}` },
        { name: '최근 실패', value: ob.recent.map((e) => `\`${e.eventId}\` ${e.status} ${e.attempts}회 — ${e.lastError ?? ''}`).join('\n').slice(0, 1024) || '-' },
        { name: '확인 필요한 다인 정산', value: recs.map((r) => `\`${r.settlementId}\` ${r.status} — ${(r.issues || []).join(', ').slice(0, 120)}`).join('\n').slice(0, 1024) || '-' },
        { name: '검증 실패로 보류된 판 (자동 복구 제외)', value: blocked.join('\n').slice(0, 1024) || '-' },
        { name: '처리 중 송금', value: `${pendingTx}건 (1분 넘게 멈춘 거래는 자동 복구)` },
        { name: '주기 작업', value: jobs.map((j) => `${j.lastError ? '⚠️' : '✅'} ${j.name} · ${j.lastRun ? `<t:${Math.floor(new Date(j.lastRun).getTime() / 1000)}:R>` : '아직 실행 전'}`).join('\n').slice(0, 1024) || '-' },
      )
      .setFooter({ text: '보류된 판: /관리자 복구 게임id:<id> → 원금 환불 · Outbox 포기 이벤트: 재시도:True' });
  },

  async 대시보드세션폐기(i) {
    const n = dashboard.revokeAll();
    await audit(i, 'dashboard.revokeAll', { amount: n });
    return `🔒 대시보드 세션 ${n}개를 폐기했어요. 토큰을 바꾸려면 DASHBOARD_TOKEN을 새 값으로 바꾸고 재시작하세요 (이전 토큰 세션은 자동 무효).`;
  },

  async 알림(i) {
    const level = i.options.getString('빈도', true);
    const before = (await guildConfig.get(i.guildId)).notifyLevel ?? 'all';
    await guildConfig.update(i.guildId, { $set: { notifyLevel: level } });
    await audit(i, 'config.notifyLevel', { before, after: level });
    return `🔔 채널 알림 빈도: **${{ all: '모두', important: '중요한 것만 (영웅 이상 업적·기록 경신·보스·챕터 완료)', off: '끄기' }[level]}**`;
  },

  async 기록익명화(i) {
    const u = i.options.getUser('유저', true);
    const reason = i.options.getString('사유', true).trim();
    const n = await require('../services/hallOfFame').anonymize(i.guildId, u.id);
    await audit(i, 'hof.anonymize', { targetId: u.id, amount: n, reason });
    return `🕶️ <@${u.id}> 의 명예의 전당 기록 ${n}건을 익명 처리했어요 (수치·날짜는 보존). 사유: ${reason}`;
  },

  async 관리자역할(i) {
    const role = i.options.getRole('역할');
    await guildConfig.update(i.guildId, { $set: { adminRoleId: role?.id ?? null } });
    await audit(i, 'config.adminRole', { targetId: role?.id ?? null });
    return role ? `✅ 관리자 역할: <@&${role.id}>` : '✅ 관리자 역할 해제 (서버 관리 권한자만 사용 가능)';
  },
};

const data = new SlashCommandBuilder()
  .setName('관리자')
  .setDescription('카지노 운영 명령어')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) => s.setName('대시보드').setDescription('경제·게임 통계').addStringOption((o) => o.setName('기간').setDescription('기간').addChoices(...PERIOD_CHOICES)))
  .addSubcommand((s) => s.setName('밸런스').setDescription('설계 RTP 대비 실제 RTP 편차 분석').addStringOption((o) => o.setName('기간').setDescription('기간').addChoices(...PERIOD_CHOICES)))
  .addSubcommand((s) => s.setName('유저').setDescription('유저 정보').addUserOption((o) => o.setName('유저').setDescription('대상').setRequired(true)))
  .addSubcommand((s) =>
    s.setName('지급').setDescription('칩 지급 (감사 로그 기록)')
      .addUserOption((o) => o.setName('유저').setDescription('대상').setRequired(true))
      .addIntegerOption((o) => o.setName('금액').setDescription('금액').setRequired(true).setMinValue(1).setMaxValue(config.ADMIN.MAX_ADJUST))
      .addStringOption((o) => o.setName('사유').setDescription('사유 (필수)').setRequired(true).setMinLength(2).setMaxLength(200))
      .addBooleanOption((o) => o.setName('공개').setDescription('채널에 공개 공지로 알리기 (기본: 나만 보기)')),
  )
  .addSubcommand((s) =>
    s.setName('회수').setDescription('칩 회수 (감사 로그 기록)')
      .addUserOption((o) => o.setName('유저').setDescription('대상').setRequired(true))
      .addIntegerOption((o) => o.setName('금액').setDescription('금액').setRequired(true).setMinValue(1).setMaxValue(config.ADMIN.MAX_ADJUST))
      .addStringOption((o) => o.setName('사유').setDescription('사유 (필수)').setRequired(true).setMinLength(2).setMaxLength(200))
      .addBooleanOption((o) => o.setName('공개').setDescription('채널에 공개 공지로 알리기 (기본: 나만 보기)')),
  )
  .addSubcommand((s) =>
    s.setName('게임').setDescription('게임 활성/비활성·베팅 한도')
      .addStringOption((o) => o.setName('게임').setDescription('게임').setRequired(true).addChoices(...GAME_CHOICES))
      .addBooleanOption((o) => o.setName('활성').setDescription('활성 여부'))
      .addIntegerOption((o) => o.setName('최소').setDescription('최소 베팅').setMinValue(1))
      .addIntegerOption((o) => o.setName('최대').setDescription('최대 베팅').setMinValue(1)),
  )
  .addSubcommand((s) => s.setName('점검').setDescription('점검 모드').addBooleanOption((o) => o.setName('켜기').setDescription('켜기/끄기').setRequired(true)).addStringOption((o) => o.setName('메시지').setDescription('안내 메시지')))
  .addSubcommand((s) => s.setName('감사로그').setDescription('관리 작업 기록').addIntegerOption((o) => o.setName('개수').setDescription('개수').setMinValue(1).setMaxValue(40)))
  .addSubcommand((s) => s.setName('복구').setDescription('정산 실패 게임 목록 / 재시도').addStringOption((o) => o.setName('게임id').setDescription('재시도할 게임 ID')))
  .addSubcommand((s) => s.setName('시즌종료').setDescription('현재 시즌 종료 & 새 시즌 시작'))
  .addSubcommand((s) =>
    s.setName('이벤트').setDescription('보상 포인트 배수 이벤트 시작')
      .addStringOption((o) => o.setName('이름').setDescription('이벤트 이름').setRequired(true).setMaxLength(50))
      .addNumberOption((o) => o.setName('배수').setDescription('포인트 배수').setRequired(true).setMinValue(1.1).setMaxValue(5))
      .addIntegerOption((o) => o.setName('시간').setDescription('진행 시간(시간)').setRequired(true).setMinValue(1).setMaxValue(24 * 14)),
  )
  .addSubcommand((s) => s.setName('이벤트종료').setDescription('진행 중 이벤트 모두 종료'))
  .addSubcommand((s) => s.setName('정산상태').setDescription('Outbox·다인 정산·보류된 판·주기 작업 상태').addBooleanOption((o) => o.setName('재시도').setDescription('실패·포기한 Outbox 이벤트를 다시 처리')))
  .addSubcommand((s) => s.setName('대시보드세션폐기').setDescription('웹 대시보드 로그인 세션 모두 폐기'))
  .addSubcommand((s) =>
    s.setName('알림').setDescription('채널 알림 빈도 (업적·기록·스토리·보스)')
      .addStringOption((o) => o.setName('빈도').setDescription('빈도').setRequired(true).addChoices({ name: '모두', value: 'all' }, { name: '중요한 것만', value: 'important' }, { name: '끄기', value: 'off' })),
  )
  .addSubcommand((s) =>
    s.setName('기록익명화').setDescription('개인정보 요청: 명예의 전당 기록에서 사용자 식별 정보 제거')
      .addUserOption((o) => o.setName('유저').setDescription('대상').setRequired(true))
      .addStringOption((o) => o.setName('사유').setDescription('사유 (필수)').setRequired(true).setMinLength(2).setMaxLength(200)),
  )
  .addSubcommand((s) => s.setName('관리자역할').setDescription('관리자 역할 지정 (비우면 해제)').addRoleOption((o) => o.setName('역할').setDescription('역할')));

module.exports = {
  data,
  async execute(i) {
    if (!(await guildConfig.isAdmin(i))) return i.reply(ephemeral('🔒 관리자만 사용할 수 있어요.'));
    const sub = i.options.getSubcommand();
    const isPublic = !!(await PUBLIC[sub]?.(i));
    await i.deferReply(isPublic ? {} : { ephemeral: true });
    const out = await handlers[sub](i);
    if (out?.fail) {
      // 공개로 열었는데 실패 → 공개 응답을 지우고 실행자에게만 안내
      if (isPublic) {
        await i.deleteReply?.().catch(() => {});
        return i.followUp(ephemeral(out.fail));
      }
      return i.editReply({ content: out.fail, allowedMentions: { parse: [] } });
    }
    if (out?.announce) {
      if (isPublic) return i.editReply({ embeds: [out.announce.setFooter({ text: `관리자 ${i.member?.displayName ?? i.user.username}` })], allowedMentions: { users: out.mentions } });
      return i.editReply({ embeds: [out.announce], allowedMentions: { parse: [] } });
    }
    return i.editReply(typeof out === 'string' ? { content: out, allowedMentions: { parse: [] } } : { embeds: [out] });
  },
};
