require('dotenv').config();
const http = require('node:http');
const mongoose = require('mongoose');
const { Client, GatewayIntentBits, Events, MessageFlags } = require('discord.js');
const { connectDB } = require('./src/db/connect');
const { loadCommands, registerCommands } = require('./src/registerCommands');
const sessions = require('./src/services/sessions');
const wallet = require('./src/services/wallet');
const config = require('./src/config');

const { DISCORD_TOKEN, MONGODB_URI, CLIENT_ID, DEV_GUILD_ID, REGISTER_COMMANDS } = process.env;
for (const [key, val] of Object.entries({ DISCORD_TOKEN, MONGODB_URI })) {
  if (!val) {
    console.error(`❌ 환경 변수 ${key} 가 설정되지 않았습니다.`);
    process.exit(1);
  }
}

// 슬래시 명령어만 쓰므로 Guilds 인텐트 하나면 충분 (Privileged Intent 불필요)
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = new Map();
const buttonHandlers = new Map();
for (const cmd of loadCommands()) {
  commands.set(cmd.data.name, cmd);
  if (cmd.prefix && cmd.handleButton) buttonHandlers.set(cmd.prefix, cmd);
}

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ 로그인: ${c.user.tag} · 서버 ${c.guilds.cache.size}곳`);
  if (REGISTER_COMMANDS === 'true') {
    await registerCommands({ token: DISCORD_TOKEN, clientId: CLIENT_ID || c.user.id, guildId: DEV_GUILD_ID }).catch((e) =>
      console.error('명령어 등록 실패:', e),
    );
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = commands.get(interaction.commandName);
      if (!cmd) return;
      if (!interaction.inGuild()) {
        return interaction.reply({ content: '서버 채널에서만 사용할 수 있어요.', flags: MessageFlags.Ephemeral });
      }
      return await cmd.execute(interaction);
    }

    if (interaction.isButton()) {
      // customId 규칙: prefix:ownerId:action:arg  (ownerId가 '*'이면 공용 버튼 — 핸들러가 권한 검사)
      const [prefix, ownerId, action, arg] = interaction.customId.split(':');
      const handler = buttonHandlers.get(prefix);
      if (!handler) return;
      if (ownerId !== '*' && ownerId !== interaction.user.id) {
        return interaction.reply({
          content: '🙅 다른 사람의 게임은 조작할 수 없어요. 명령어로 직접 시작해 보세요!',
          flags: MessageFlags.Ephemeral,
        });
      }
      return await handler.handleButton(interaction, { action, arg });
    }
  } catch (err) {
    console.error('[interaction error]', err);
    const payload = { content: '⚠️ 처리 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

// Koyeb 헬스 체크용 HTTP 서버 (Web 서비스로 배포할 때 필요, Worker면 무해)
const port = Number(process.env.PORT) || 8000;
const server = http
  .createServer((req, res) => {
    const body = JSON.stringify({
      status: 'ok',
      discord: client.isReady() ? 'ready' : 'connecting',
      mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      sessions: sessions.size,
      uptime: Math.round(process.uptime()),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  })
  .listen(port, () => console.log(`🩺 헬스 체크 서버 :${port}`));

/** 오래 정산되지 않은 에스크로 환불 (다른 인스턴스·이전 프로세스가 비정상 종료한 경우) */
async function sweepEscrow() {
  try {
    const n = await wallet.refundStale();
    if (n) console.log(`♻️ 미정산 판 ${n}건 자동 환불`);
  } catch (err) {
    console.error('[escrow sweep]', err.message);
  }
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 ${signal} 수신 — 진행 중 게임 ${sessions.size}개 종료, 이 프로세스의 미정산 판 환불`);
  sessions.shutdown();
  await wallet
    .refundOwn()
    .then((n) => n && console.log(`♻️ 진행 중이던 판 ${n}건 환불`))
    .catch((err) => console.error('[shutdown refund]', err.message));
  server.close();
  await client.destroy();
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

(async () => {
  await connectDB(MONGODB_URI);
  await sweepEscrow();
  setInterval(sweepEscrow, config.ECONOMY.ESCROW_SWEEP_MS).unref();
  await client.login(DISCORD_TOKEN);
})().catch((err) => {
  console.error('❌ 시작 실패:', err);
  process.exit(1);
});
