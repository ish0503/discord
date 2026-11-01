require('dotenv').config();
const http = require('node:http');
const mongoose = require('mongoose');
const { Client, GatewayIntentBits, Events, MessageFlags } = require('discord.js');
const config = require('./src/config');
const { connectDB } = require('./src/db/connect');
const SystemState = require('./src/db/SystemState');
const { loadCommands, registerCommands } = require('./src/registerCommands');
const sessions = require('./src/services/sessions');
const wallet = require('./src/services/wallet');
const gameState = require('./src/services/gameState');
const guildConfig = require('./src/services/guildConfig');
const rateLimit = require('./src/services/rateLimit');
const seasons = require('./src/services/seasons');
const notifier = require('./src/services/notifier');
const dashboard = require('./src/services/dashboard');
const keepAlive = require('./src/services/keepAlive');
const outbox = require('./src/services/outbox');
const scheduler = require('./src/services/scheduler');
const instanceLock = require('./src/services/instanceLock');
const { alert } = require('./src/services/alerts');
require('./src/services/profile'); // round:settled → 전적·미션·업적 리스너 등록

const { DISCORD_TOKEN, MONGODB_URI, CLIENT_ID, DEV_GUILD_ID, REGISTER_COMMANDS } = process.env;
for (const [key, val] of Object.entries({ DISCORD_TOKEN, MONGODB_URI })) {
  if (!val) {
    console.error(`❌ 환경 변수 ${key} 가 설정되지 않았습니다.`);
    process.exit(1);
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
notifier.setClient(client);

const commands = new Map();
const handlers = new Map(); // customId prefix → 명령어 모듈
for (const cmd of loadCommands()) {
  commands.set(cmd.data.name, cmd);
  if (cmd.prefix) handlers.set(cmd.prefix, cmd);
}

const reply = (i, content) => {
  const payload = { content, flags: MessageFlags.Ephemeral };
  return i.deferred || i.replied ? i.followUp(payload).catch(() => {}) : i.reply(payload).catch(() => {});
};

/** 게임 명령어 가드: 점검·비활성·베팅 한도 */
async function guard(i, cmd) {
  if (!cmd.game) return null;
  const blocked = await guildConfig.gameBlockReason(i.guildId, cmd.game);
  if (blocked) return blocked;
  const amount = i.options.getInteger('금액') ?? i.options.getInteger('참가비');
  if (amount !== null && amount !== undefined) return guildConfig.betBlockReason(i.guildId, cmd.game, amount);
  return null;
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isRepliable()) return;
    if (!rateLimit.allow(interaction.user.id)) return reply(interaction, '⏳ 너무 빨라요. 잠시 후 다시 시도해 주세요.');

    if (interaction.isChatInputCommand()) {
      const cmd = commands.get(interaction.commandName);
      if (!cmd) return undefined;
      if (!interaction.inGuild()) return reply(interaction, '서버 채널에서만 사용할 수 있어요.');
      const blocked = await guard(interaction, cmd);
      if (blocked) return reply(interaction, blocked);
      return await cmd.execute(interaction);
    }

    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      // customId 규칙: prefix:ownerId:action:arg  (ownerId '*' = 공용 버튼, 권한은 핸들러가 검사)
      const [prefix, ownerId, action, ...rest] = interaction.customId.split(':');
      const handler = handlers.get(prefix);
      if (!handler) return undefined;
      if (ownerId !== '*' && ownerId !== interaction.user.id) return reply(interaction, '🙅 다른 사람의 화면은 조작할 수 없어요. 명령어로 직접 열어 보세요!');
      const ctx = { action, arg: rest.join(':') };
      if (interaction.isButton() && handler.handleButton) return await handler.handleButton(interaction, ctx);
      if (interaction.isStringSelectMenu() && handler.handleSelect) return await handler.handleSelect(interaction, ctx);
    }
  } catch (err) {
    console.error('[interaction error]', err);
    alert('error', '인터랙션 처리 오류', `${interaction.customId ?? interaction.commandName}: ${err.message}`);
    return reply(interaction, '⚠️ 처리 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.');
  }
  return undefined;
});

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ 로그인: ${c.user.tag} · 서버 ${c.guilds.cache.size}곳`);
  if (REGISTER_COMMANDS === 'true') {
    await registerCommands({ token: DISCORD_TOKEN, clientId: CLIENT_ID || c.user.id, guildId: DEV_GUILD_ID }).catch((e) => console.error('명령어 등록 실패:', e));
  }
  if (config.ECONOMY.RECOVER_ON_BOOT) {
    await gameState.recoverBoot(bootRecovery).catch((e) => console.error('[recoverBoot]', e));
  }
});
client.on(Events.ShardDisconnect, (_, id) => alert('warn', '디스코드 연결 끊김', `shard ${id}`));
client.on(Events.Error, (err) => alert('error', '디스코드 클라이언트 오류', err.message));

// ───────────── 헬스 체크 + 대시보드 HTTP 서버 ─────────────
const port = Number(process.env.PORT) || 8000;
const server = http
  .createServer(async (req, res) => {
    if (await dashboard.handle(req, res, client)) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        discord: client.isReady() ? 'ready' : 'connecting',
        mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        sessions: sessions.size,
        instance: wallet.INSTANCE_ID,
        uptime: Math.round(process.uptime()),
      }),
    );
  })
  .listen(port, () => {
    const d = dashboard.enabledState();
    const note = d.ok ? ' · 📊 /dashboard 활성 (로그인: /dashboard/login)' : config.DASHBOARD.TOKEN ? ` · ⚠️ 대시보드 비활성 (${d.why})` : '';
    console.log(`🩺 헬스 체크 :${port}${note}`);
  });

// ───────────── 주기 작업 ─────────────
async function sweepEscrow() {
  try {
    const r = await wallet.recoverStale();
    if (r.settled || r.refunded) console.log(`♻️ 미정산 판 자동 처리: 정산 ${r.settled}, 환불 ${r.refunded}`);
    if (r.failed) alert('error', '미정산 판 처리 실패', `${r.failed}건`);
  } catch (err) {
    alert('error', '에스크로 스윕 오류', err.message);
  }
}

async function heartbeat() {
  await SystemState.updateOne({ _id: 'main' }, { $set: { lastHeartbeat: new Date(), instance: wallet.INSTANCE_ID, cleanShutdown: false } }, { upsert: true }).catch(() => {});
}

let bootRecovery = null;
let shuttingDown = false;
const lock = instanceLock.create(wallet.INSTANCE_ID);

// ───────────── 주기 작업 (리더 임대를 가진 인스턴스만 실행) ─────────────
scheduler.register('escrow-sweep', config.ECONOMY.ESCROW_SWEEP_MS, sweepEscrow);
scheduler.register('heartbeat', 30_000, heartbeat);
scheduler.register('season-rollover', 3600_000, () => seasons.autoRollover());
scheduler.register(
  'outbox',
  config.OUTBOX.SWEEP_MS,
  async () => {
    const r = await outbox.sweep();
    if (r.processed || r.materialized) console.log(`📮 Outbox: 이관 ${r.materialized}, 처리 ${r.processed}, 실패 ${r.failed}`);
  },
  { runOnStart: true },
);
scheduler.register('transfer-recovery', 60_000, async () => {
  const r = await wallet.recoverTransfers();
  if (r.completed || r.failed) console.log(`💸 중단된 송금 복구: 완료 ${r.completed}, 취소 ${r.failed}`);
});

async function shutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 ${signal} — 진행 중 게임 ${sessions.size}개 종료, 이 프로세스의 판 복구 처리`);
  scheduler.stop();
  sessions.shutdown();
  try {
    const r = await wallet.recoverOwn();
    if (r.settled || r.refunded) console.log(`♻️ 종료 처리: 확정 결과 정산 ${r.settled}, 환불 ${r.refunded}`);
    await SystemState.updateOne({ _id: 'main' }, { $set: { cleanShutdown: true, lastHeartbeat: new Date() } });
  } catch (err) {
    console.error('[shutdown]', err.message);
  }
  await lock.release(); // 다음 인스턴스가 기다리지 않고 바로 이어받도록
  server.close();
  await client.destroy();
  await mongoose.disconnect().catch(() => {});
  process.exit(code);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
  alert('error', 'Unhandled Rejection', err?.stack ?? String(err));
});
process.on('uncaughtException', async (err) => {
  console.error('[uncaughtException]', err);
  await alert('error', '치명적 오류로 종료', err?.stack ?? String(err));
  shutdown('uncaughtException', 1);
});

(async () => {
  await connectDB(MONGODB_URI);
  mongoose.connection.on('disconnected', () => alert('error', 'MongoDB 연결 끊김', '자동 재연결 시도 중'));

  // Koyeb 등 scale-to-zero 호스팅에서 잠들지 않도록 공개 URL로 주기적 핑 (임대 대기 중에도 헬스 체크는 응답)
  keepAlive.start({ onFail: (streak, err) => streak >= 3 && alert('warn', 'keep-alive 핑 연속 실패', `${streak}회 · ${err.message} — 인스턴스가 잠들 수 있어요`) });

  // 단일 인스턴스 보장: 리더 임대를 얻을 때까지 디스코드 로그인·복구·주기 작업을 하지 않음
  let alerted = false;
  await lock.acquire({
    onWait: (h) => {
      console.warn(`⏳ 다른 인스턴스(${h?.instance ?? '?'})가 실행 중 — 임대 만료(${h?.leaseUntil ? new Date(h.leaseUntil).toISOString() : '?'})까지 대기`);
      if (!alerted) alert('warn', '중복 인스턴스 감지', `실행 중인 인스턴스 ${h?.instance ?? '?'} 의 임대가 끝날 때까지 이 인스턴스는 대기합니다.`);
      alerted = true;
    },
  });
  console.log(`👑 리더 임대 획득 (${wallet.INSTANCE_ID})`);
  lock.keep({
    onLost: (h) => {
      alert('error', '리더 임대 상실 — 중복 실행', `다른 인스턴스(${h?.instance ?? '?'})가 임대를 가져갔습니다. 중복 처리를 막기 위해 이 인스턴스를 종료합니다.`);
      shutdown('lease-lost', 1);
    },
  });

  // 이전 프로세스의 비정상 종료 감지
  const prev = await SystemState.findById('main').lean();
  if (prev && prev.cleanShutdown === false) alert('warn', '비정상 종료 감지', `이전 프로세스 마지막 생존 신호: ${prev.lastHeartbeat?.toISOString?.() ?? '?'}`);
  await SystemState.updateOne({ _id: 'main' }, { $set: { bootedAt: new Date(), instance: wallet.INSTANCE_ID, cleanShutdown: false } }, { upsert: true });

  // 재시작 복구: 이전 프로세스의 판 — 결과 확정분은 정산(전적·미션 포함), 나머지 환불 (디스코드 메시지 정리는 로그인 후)
  if (config.ECONOMY.RECOVER_ON_BOOT) {
    bootRecovery = await wallet.recoverPrevious();
    console.log(`🔧 부팅 복구: 정산 ${bootRecovery.settled}, 환불 ${bootRecovery.refunded}, 차단 ${bootRecovery.blocked}, 실패 ${bootRecovery.failed}`);
  } else await sweepEscrow();
  const tr = await wallet.recoverTransfers(0);
  if (tr.completed || tr.failed) console.log(`💸 부팅 송금 복구: 완료 ${tr.completed}, 취소 ${tr.failed}`);

  scheduler.start({ isLeader: () => lock.isLeader() && !shuttingDown });
  await heartbeat();
  await client.login(DISCORD_TOKEN);
})().catch(async (err) => {
  console.error('❌ 시작 실패:', err);
  await alert('error', '봇 시작 실패', err.message);
  process.exit(1);
});
