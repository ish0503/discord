const { MessageFlags } = require('discord.js');

const COLOR = {
  table: 0x1f8b4c,
  gold: 0xf1c40f,
  win: 0x2ecc71,
  lose: 0xe74c3c,
  push: 0x95a5a6,
  info: 0x5865f2,
};

const chips = (n) => `🪙 ${Math.floor(n).toLocaleString('en-US')}`;
const num = (n) => Math.floor(n).toLocaleString('en-US');
const signed = (n, digits = 0) => `${n > 0 ? '+' : ''}${Number(n).toFixed(digits)}`;
const netText = (n) => (n > 0 ? `+${num(n)}` : n < 0 ? `-${num(-n)}` : '±0');
const netColor = (n) => (n > 0 ? COLOR.win : n < 0 ? COLOR.lose : COLOR.push);

const { card: themedCard, cardMarkup } = require('../content/cosmetics');

const cardText = (c, theme = 'classic') => themedCard(c, theme);
/** 카드 목록 표기. theme = 카드 테마(꾸미기 아이템) — 테마마다 표기 방식이 다름 */
const handText = (cards, hidden = [], theme = 'classic') =>
  cards.map((c, i) => (hidden.includes(i) ? '`🂠`' : cardMarkup(c, theme))).join(' ');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

/** 세션이 사라진(재시작·만료) 게임 메시지의 버튼 클릭 처리 */
async function expired(interaction) {
  return interaction
    .update({ content: '⌛ 종료되었거나 만료된 게임입니다. 명령어로 새 게임을 시작하세요.', components: [] })
    .catch(() => {});
}

const busyText = '🎲 이미 진행 중인 게임이 있어요. 끝낸 뒤 다시 시도하세요.';

module.exports = { COLOR, chips, num, signed, netText, netColor, cardText, handText, sleep, ephemeral, expired, busyText };
