/** 디스코드 클라이언트 참조 보관 & 채널 알림 (업적 달성, 복구 안내 등) */
let client = null;

function setClient(c) {
  client = c;
}

async function send(channelId, payload) {
  if (!client || !channelId) return null;
  try {
    const ch = await client.channels.fetch(channelId);
    return await ch?.send(typeof payload === 'string' ? { content: payload, allowedMentions: { parse: [] } } : payload);
  } catch (err) {
    console.warn('[notifier]', err.message);
    return null;
  }
}

async function editMessage(channelId, messageId, payload) {
  if (!client || !channelId || !messageId) return false;
  try {
    const ch = await client.channels.fetch(channelId);
    const msg = await ch.messages.fetch(messageId);
    await msg.edit(payload);
    return true;
  } catch (err) {
    console.warn('[notifier edit]', err.message);
    return false;
  }
}

module.exports = { setClient, send, editMessage, get client() { return client; } };
