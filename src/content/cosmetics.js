/**
 * 꾸미기 아이템 카탈로그 & 렌더링 (순수 로직).
 * 모든 아이템은 외형만 바꾸며 확률·배당에는 영향이 없다.
 * price.points = 보상 포인트, price.chips = 카지노 칩 (칩 구매는 경제에서 칩을 회수하는 역할)
 */
const CARD_THEMES = {
  classic: { name: '클래식', suits: { '♠': '♠', '♥': '♥', '♦': '♦', '♣': '♣' } },
  emoji: { name: '컬러 이모지', suits: { '♠': '♠️', '♥': '♥️', '♦': '♦️', '♣': '♣️' } },
  outline: { name: '아웃라인', suits: { '♠': '♤', '♥': '♡', '♦': '◇', '♣': '♧' } },
  letters: { name: '알파벳', suits: { '♠': 's', '♥': 'h', '♦': 'd', '♣': 'c' } },
};
const SLOT_THEMES = {
  fruit: { name: '과일', map: {} },
  gems: { name: '보석', map: { '🍒': '🔴', '🍋': '🟡', '🔔': '🟢', '💎': '💠', '7️⃣': '👑' } },
  space: { name: '우주', map: { '🍒': '🪐', '🍋': '🌙', '🔔': '⭐', '💎': '☄️', '7️⃣': '🚀' } },
  animals: { name: '동물', map: { '🍒': '🐹', '🍋': '🐥', '🔔': '🐸', '💎': '🦄', '7️⃣': '🐉' } },
};
const DICE_SKINS = {
  classic: { name: '클래식', faces: ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'] },
  numbers: { name: '숫자', faces: ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣'] },
  roman: { name: '로마 숫자', faces: ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ'] },
};
const COLORS = {
  default: { name: '기본', hex: null },
  crimson: { name: '크림슨', hex: 0xdc143c },
  ocean: { name: '오션', hex: 0x1e90ff },
  gold: { name: '골드', hex: 0xffc300 },
  violet: { name: '바이올렛', hex: 0x8e44ad },
};
const FRAMES = {
  none: { name: '없음', l: '', r: '' },
  star: { name: '별빛', l: '✦ ', r: ' ✦' },
  crown: { name: '왕관', l: '👑 ', r: ' 👑' },
  fire: { name: '불꽃', l: '🔥 ', r: ' 🔥' },
  diamond: { name: '다이아', l: '💎 ', r: ' 💎' },
};

const SHOP = [
  { id: 'card:emoji', type: 'cardTheme', value: 'emoji', price: { points: 300 } },
  { id: 'card:outline', type: 'cardTheme', value: 'outline', price: { points: 300 } },
  { id: 'card:letters', type: 'cardTheme', value: 'letters', price: { chips: 50_000 } },
  { id: 'slot:gems', type: 'slotTheme', value: 'gems', price: { points: 400 } },
  { id: 'slot:space', type: 'slotTheme', value: 'space', price: { points: 400 } },
  { id: 'slot:animals', type: 'slotTheme', value: 'animals', price: { chips: 80_000 } },
  { id: 'dice:numbers', type: 'diceSkin', value: 'numbers', price: { points: 250 } },
  { id: 'dice:roman', type: 'diceSkin', value: 'roman', price: { chips: 40_000 } },
  { id: 'color:crimson', type: 'color', value: 'crimson', price: { points: 200 } },
  { id: 'color:ocean', type: 'color', value: 'ocean', price: { points: 200 } },
  { id: 'color:gold', type: 'color', value: 'gold', price: { chips: 100_000 } },
  { id: 'color:violet', type: 'color', value: 'violet', price: { points: 200 } },
  { id: 'frame:star', type: 'frame', value: 'star', price: { points: 500 } },
  { id: 'frame:fire', type: 'frame', value: 'fire', price: { points: 500 } },
  { id: 'frame:crown', type: 'frame', value: 'crown', price: { chips: 250_000 } },
  { id: 'frame:diamond', type: 'frame', value: 'diamond', price: { points: 1500 } },
  { id: 'title:신사', type: 'title', value: '카지노 신사', price: { points: 300 } },
  { id: 'title:야간', type: 'title', value: '야간 근무자', price: { points: 300 } },
  { id: 'title:큰손', type: 'title', value: '큰손', price: { chips: 500_000 } },
];

const TYPE_LABEL = { cardTheme: '🃏 카드 테마', slotTheme: '🎰 슬롯 테마', diceSkin: '🎲 주사위 스킨', color: '🎨 색상', frame: '🖼️ 프로필 테두리', title: '🏷️ 칭호' };
const DEFAULTS = { cardTheme: 'classic', slotTheme: 'fruit', diceSkin: 'classic', color: 'default', frame: 'none' };
const CATALOG = { cardTheme: CARD_THEMES, slotTheme: SLOT_THEMES, diceSkin: DICE_SKINS, color: COLORS, frame: FRAMES };

function itemName(item) {
  if (item.type === 'title') return `칭호 「${item.value}」`;
  return `${CATALOG[item.type][item.value].name} ${TYPE_LABEL[item.type].split(' ').slice(1).join(' ')}`;
}

const card = (c, theme = 'classic') => `${c.rank}${(CARD_THEMES[theme] ?? CARD_THEMES.classic).suits[c.suit] ?? c.suit}`;
const slotSymbol = (emoji, theme = 'fruit') => (SLOT_THEMES[theme] ?? SLOT_THEMES.fruit).map[emoji] ?? emoji;
const diceFace = (n, skin = 'classic') => (DICE_SKINS[skin] ?? DICE_SKINS.classic).faces[n - 1];
const color = (id, fallback) => COLORS[id]?.hex ?? fallback;
const framed = (text, frame = 'none') => `${(FRAMES[frame] ?? FRAMES.none).l}${text}${(FRAMES[frame] ?? FRAMES.none).r}`;

module.exports = { SHOP, CATALOG, TYPE_LABEL, DEFAULTS, itemName, card, slotSymbol, diceFace, color, framed };
