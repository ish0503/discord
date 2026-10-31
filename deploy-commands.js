/**
 * 수동 명령어 등록 스크립트:  npm run deploy
 * (Koyeb에서는 REGISTER_COMMANDS=true 환경 변수로 부팅 시 자동 등록 가능)
 */
require('dotenv').config();
const { registerCommands } = require('./src/registerCommands');

const { DISCORD_TOKEN, CLIENT_ID, DEV_GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('DISCORD_TOKEN, CLIENT_ID 환경 변수가 필요합니다.');
  process.exit(1);
}

registerCommands({ token: DISCORD_TOKEN, clientId: CLIENT_ID, guildId: DEV_GUILD_ID })
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
