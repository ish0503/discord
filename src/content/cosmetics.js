/**
 * 꾸미기 아이템 카탈로그 & 렌더링 (순수 로직).
 * 모든 아이템은 외형만 바꾸며 확률·배당에는 영향이 없다.
 * price.points = 보상 포인트, price.chips = 카지노 칩 (칩 구매는 경제에서 칩을 회수하는 역할)
 */
/**
 * 카드 테마: 같은 카드를 디스코드에서 확실히 다르게 보이도록 표기 방식 자체를 바꾼다.
 *  code: true면 `A♠` 처럼 코드 블록으로 감싸 표시
 *  art: 프로필 이미지에 그릴 카드 색 (bg 카드 바탕, edge 테두리, suits 무늬별 글자색)
 */
const ROYAL_RANK = { A: '🅰️', 2: '2️⃣', 3: '3️⃣', 4: '4️⃣', 5: '5️⃣', 6: '6️⃣', 7: '7️⃣', 8: '8️⃣', 9: '9️⃣', 10: '🔟', J: '💂', Q: '👸', K: '🤴' };
const CARD_THEMES = {
  classic: {
    name: '클래식',
    desc: '코드 블록 · 기본 무늬',
    code: true,
    fmt: (c) => `${c.rank}${c.suit}`,
    art: { bg: '#fdfdfd', edge: '#c9c9c9', suits: { '♠': '#1b1b1b', '♥': '#d0312d', '♦': '#d0312d', '♣': '#1b1b1b' } },
  },
  emoji: {
    name: '4색 컬러',
    desc: '무늬마다 다른 색 (♠️검정 ♥️빨강 🔷파랑 🍀초록) — 플러시가 한눈에',
    code: false,
    fmt: (c) => `**${c.rank}**${{ '♠': '♠️', '♥': '♥️', '♦': '🔷', '♣': '🍀' }[c.suit] ?? c.suit}`,
    art: { bg: '#ffffff', edge: '#9aa4b1', suits: { '♠': '#111111', '♥': '#e02424', '♦': '#1c64f2', '♣': '#0e9f6e' } },
  },
  outline: {
    name: '로열 아이콘',
    desc: '숫자는 키캡, J·Q·K는 인물 이모지 (🤴♥️ 👸♠️)',
    code: false,
    fmt: (c) => `${ROYAL_RANK[c.rank] ?? c.rank}${{ '♠': '♠️', '♥': '♥️', '♦': '♦️', '♣': '♣️' }[c.suit] ?? c.suit}`,
    art: { bg: '#fff6dc', edge: '#c9a227', suits: { '♠': '#2b2140', '♥': '#b3122e', '♦': '#b3122e', '♣': '#2b2140' } },
  },
  letters: {
    name: '포커 표기',
    desc: '프로 포커 기보식 (As Kh Td 2c)',
    code: true,
    fmt: (c) => `${c.rank === '10' ? 'T' : c.rank}${{ '♠': 's', '♥': 'h', '♦': 'd', '♣': 'c' }[c.suit] ?? c.suit}`,
    art: { bg: '#1f2633', edge: '#3fe0c5', suits: { '♠': '#e6edf3', '♥': '#ff7b9c', '♦': '#ffb86b', '♣': '#7ee787' } },
  },
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
  legend: { name: '전설의 왕좌', l: '⟪👑 ', r: ' 👑⟫' }, // 스토리 최종 챕터 보상 (판매 안 함)
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

/** 판매하지 않는 보상 아이템 (스토리·보스·수집 세트 등으로만 획득). 장착 가능 여부는 inventory로 판단 */
const REWARD_ITEMS = [{ id: 'reward:frame:legend', type: 'frame', value: 'legend', source: '스토리 4장 완료' }];

const TYPE_LABEL = { cardTheme: '🃏 카드 테마', slotTheme: '🎰 슬롯 테마', diceSkin: '🎲 주사위 스킨', color: '🎨 색상', frame: '🖼️ 프로필 테두리', title: '🏷️ 칭호' };
const DEFAULTS = { cardTheme: 'classic', slotTheme: 'fruit', diceSkin: 'classic', color: 'default', frame: 'none' };
const CATALOG = { cardTheme: CARD_THEMES, slotTheme: SLOT_THEMES, diceSkin: DICE_SKINS, color: COLORS, frame: FRAMES };

function itemName(item) {
  if (item.type === 'title') return `칭호 「${item.value}」`;
  return `${CATALOG[item.type][item.value].name} ${TYPE_LABEL[item.type].split(' ').slice(1).join(' ')}`;
}

const cardTheme = (theme) => CARD_THEMES[theme] ?? CARD_THEMES.classic;
/** 카드 한 장의 표기 (마크다운 없이) */
const card = (c, theme = 'classic') => cardTheme(theme).fmt(c);
/** 메시지에 넣을 카드 한 장 (코드 블록 테마는 `…`로 감쌈) */
const cardMarkup = (c, theme = 'classic') => (cardTheme(theme).code ? `\`${card(c, theme)}\`` : card(c, theme));
const slotSymbol = (emoji, theme = 'fruit') => (SLOT_THEMES[theme] ?? SLOT_THEMES.fruit).map[emoji] ?? emoji;
const diceFace = (n, skin = 'classic') => (DICE_SKINS[skin] ?? DICE_SKINS.classic).faces[n - 1];
const color = (id, fallback) => COLORS[id]?.hex ?? fallback;
const framed = (text, frame = 'none') => `${(FRAMES[frame] ?? FRAMES.none).l}${text}${(FRAMES[frame] ?? FRAMES.none).r}`;

/** 장착 가능한 아이템 정의 (상점 + 보상) */
const ownableItems = () => [...SHOP, ...REWARD_ITEMS];

module.exports = { SHOP, REWARD_ITEMS, ownableItems, CATALOG, TYPE_LABEL, DEFAULTS, CARD_THEMES, itemName, card, cardMarkup, cardTheme, slotSymbol, diceFace, color, framed };
