const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes } = require('discord.js');

function loadCommands() {
  const dir = path.join(__dirname, 'commands');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => require(path.join(dir, f)));
}

/**
 * 슬래시 명령어 등록.
 * DEV_GUILD_ID가 있으면 그 서버에만 즉시 반영(개발용), 없으면 전역 등록.
 */
async function registerCommands({ token, clientId, guildId }) {
  const body = loadCommands().map((c) => c.data.toJSON());
  const rest = new REST().setToken(token);
  const route = guildId ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId);
  const result = await rest.put(route, { body });
  console.log(`📝 슬래시 명령어 ${result.length}개 등록 (${guildId ? `길드 ${guildId}` : '전역'})`);
  return result;
}

module.exports = { loadCommands, registerCommands };
