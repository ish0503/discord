/**
 * /프로필 이미지 카드 렌더러 (@napi-rs/canvas).
 *
 * 장착한 꾸미기가 그대로 "사진"으로 보이도록 그린다.
 *  - 🎨 색상  → 배경 그라데이션·강조색
 *  - 🖼️ 테두리 → 카드 외곽 장식 (별빛·왕관·불꽃·다이아)
 *  - 🃏 카드 테마 → 실제 카드 4장을 테마 색으로 그림
 *  - 🎲 주사위 스킨 → 주사위 2개를 스킨대로 그림
 *
 * 이모지 폰트에 의존하지 않도록 무늬·주사위·왕관은 모두 도형으로 그린다.
 * 한글은 저장소에 포함된 Pretendard(OFL)로 그려서 서버 OS 폰트와 무관하게 똑같이 나온다.
 * 캔버스 모듈을 불러오지 못하면 available()이 false → 명령어는 기존 임베드로 대체한다.
 */
const path = require('node:path');
const cosmetics = require('../content/cosmetics');
const achievements = require('../content/achievements');
const registry = require('../games/registry');

let canvasLib = null;
try {
  canvasLib = require('@napi-rs/canvas');
  const dir = path.join(__dirname, '../../assets/fonts');
  canvasLib.GlobalFonts.registerFromPath(path.join(dir, 'Pretendard-Regular.otf'), 'PretendardR');
  canvasLib.GlobalFonts.registerFromPath(path.join(dir, 'Pretendard-Bold.otf'), 'PretendardB');
} catch (err) {
  console.warn('[profileCard] 캔버스를 사용할 수 없어 임베드 프로필로 대체합니다:', err.message);
  canvasLib = null;
}

const W = 1000;
const H = 640;
const R = (px) => `${px}px PretendardR`;
const B = (px) => `${px}px PretendardB`;

/** 색상 아이템 → 배경 팔레트 */
const PALETTES = {
  default: { from: '#1f2b3d', to: '#0c121c', accent: '#7289ff', soft: 'rgba(114,137,255,0.16)' },
  crimson: { from: '#5a1022', to: '#16040a', accent: '#ff4d6d', soft: 'rgba(255,77,109,0.16)' },
  ocean: { from: '#0b4a80', to: '#051526', accent: '#4cc3ff', soft: 'rgba(76,195,255,0.16)' },
  gold: { from: '#5c4506', to: '#181102', accent: '#ffd23f', soft: 'rgba(255,210,63,0.16)' },
  violet: { from: '#4b1a69', to: '#12061b', accent: '#c77dff', soft: 'rgba(199,125,255,0.16)' },
};

const available = () => !!canvasLib;
const palette = (id) => PALETTES[id] ?? PALETTES.default;

// ───────────────────────── 도형 ─────────────────────────

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 카드 무늬 (중심 cx, cy, 크기 s) */
function suit(ctx, kind, cx, cy, s, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.translate(cx, cy);
  ctx.scale(s / 100, s / 100);
  ctx.beginPath();
  if (kind === '♥') {
    ctx.moveTo(0, 35);
    ctx.bezierCurveTo(-60, -5, -45, -55, 0, -25);
    ctx.bezierCurveTo(45, -55, 60, -5, 0, 35);
  } else if (kind === '♦') {
    ctx.moveTo(0, -45);
    ctx.lineTo(35, 0);
    ctx.lineTo(0, 45);
    ctx.lineTo(-35, 0);
  } else if (kind === '♠') {
    ctx.moveTo(0, -45);
    ctx.bezierCurveTo(-55, 0, -45, 40, 0, 15);
    ctx.bezierCurveTo(45, 40, 55, 0, 0, -45);
    ctx.moveTo(0, 5);
    ctx.lineTo(-14, 42);
    ctx.lineTo(14, 42);
  } else {
    ctx.arc(0, -20, 18, 0, Math.PI * 2);
    ctx.moveTo(-20, 8);
    ctx.arc(-20, 8, 18, 0, Math.PI * 2);
    ctx.moveTo(20, 8);
    ctx.arc(20, 8, 18, 0, Math.PI * 2);
    ctx.moveTo(0, 0);
    ctx.lineTo(-12, 42);
    ctx.lineTo(12, 42);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function star(ctx, cx, cy, r, color, points = 4) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let k = 0; k < points * 2; k++) {
    const a = (Math.PI * k) / points - Math.PI / 2;
    const rr = k % 2 ? r * 0.38 : r;
    ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function crown(ctx, cx, cy, w, color) {
  const h = w * 0.62;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx - w / 2, cy + h / 2);
  ctx.lineTo(cx - w / 2, cy - h / 4);
  ctx.lineTo(cx - w / 4, cy + h / 8);
  ctx.lineTo(cx, cy - h / 2);
  ctx.lineTo(cx + w / 4, cy + h / 8);
  ctx.lineTo(cx + w / 2, cy - h / 4);
  ctx.lineTo(cx + w / 2, cy + h / 2);
  ctx.closePath();
  ctx.fill();
  for (const dx of [-w / 2, 0, w / 2]) {
    ctx.beginPath();
    ctx.arc(cx + dx, cy + (dx ? -h / 4 : -h / 2), w * 0.07, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function gem(ctx, cx, cy, s, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy - s);
  ctx.lineTo(cx + s * 0.7, cy);
  ctx.lineTo(cx, cy + s);
  ctx.lineTo(cx - s * 0.7, cy);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.moveTo(cx, cy - s);
  ctx.lineTo(cx + s * 0.25, cy - s * 0.1);
  ctx.lineTo(cx - s * 0.3, cy);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** 글자가 칸을 넘으면 줄여서 맞춘다 */
function fitText(ctx, text, maxW, font, size, min = 12) {
  let s = size;
  ctx.font = font(s);
  while (s > min && ctx.measureText(text).width > maxW) {
    s -= 1;
    ctx.font = font(s);
  }
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

// ───────────────────────── 구성 요소 ─────────────────────────

function background(ctx, pal) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, pal.from);
  g.addColorStop(1, pal.to);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // 은은한 무늬 패턴
  const kinds = ['♠', '♥', '♦', '♣'];
  ctx.globalAlpha = 0.05;
  for (let y = 30, row = 0; y < H + 40; y += 70, row++) {
    for (let x = (row % 2) * 35 + 20; x < W + 40; x += 70) suit(ctx, kinds[(row + Math.floor(x / 70)) % 4], x, y, 26, '#ffffff');
  }
  ctx.globalAlpha = 1;
  // 강조색 빛 번짐
  const glow = ctx.createRadialGradient(150, 130, 10, 150, 130, 420);
  glow.addColorStop(0, pal.soft);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
}

function frame(ctx, id, pal) {
  const inset = 14;
  const x = inset;
  const y = inset;
  const w = W - inset * 2;
  const h = H - inset * 2;
  ctx.save();
  if (id === 'fire') {
    const g = ctx.createLinearGradient(0, H, W, 0);
    g.addColorStop(0, '#ff3d00');
    g.addColorStop(0.5, '#ff9100');
    g.addColorStop(1, '#ffea00');
    ctx.strokeStyle = g;
    ctx.lineWidth = 8;
    roundRect(ctx, x, y, w, h, 26);
    ctx.stroke();
    // 아래쪽 불꽃
    ctx.fillStyle = g;
    for (let fx = 40; fx < W - 30; fx += 46) {
      const fh = 12 + ((fx * 7) % 13); // 패널(아래 끝 y 596)에 닿지 않는 높이
      ctx.beginPath();
      ctx.moveTo(fx - 12, H - inset);
      ctx.quadraticCurveTo(fx - 8, H - inset - fh * 0.6, fx, H - inset - fh);
      ctx.quadraticCurveTo(fx + 8, H - inset - fh * 0.6, fx + 12, H - inset);
      ctx.closePath();
      ctx.fill();
    }
  } else if (id === 'legend') {
    // 스토리 최종 보상: 무지개빛 이중 테두리 + 네 귀퉁이 왕관
    const g = ctx.createLinearGradient(0, 0, W, H);
    ['#ff3d6e', '#ffb300', '#ffe66d', '#3ddc97', '#4cc3ff', '#9b4dff'].forEach((c, k, a) => g.addColorStop(k / (a.length - 1), c));
    ctx.strokeStyle = g;
    ctx.lineWidth = 7;
    ctx.shadowColor = 'rgba(255,214,90,0.6)';
    ctx.shadowBlur = 16;
    roundRect(ctx, x, y, w, h, 26);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    roundRect(ctx, x + 9, y + 9, w - 18, h - 18, 20);
    ctx.stroke();
    for (const [cx, cy] of [[x + 4, y + 4], [x + w - 4, y + 4], [x + 4, y + h - 4], [x + w - 4, y + h - 4]]) crown(ctx, cx, cy, 26, '#ffd54a');
  } else if (id === 'diamond') {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#b9f6ff');
    g.addColorStop(0.5, '#4dd0e1');
    g.addColorStop(1, '#e0f7fa');
    ctx.strokeStyle = g;
    ctx.lineWidth = 6;
    roundRect(ctx, x, y, w, h, 26);
    ctx.stroke();
    for (const [cx, cy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) gem(ctx, cx, cy, 20, '#80deea');
  } else if (id === 'crown') {
    ctx.strokeStyle = '#ffcf40';
    ctx.lineWidth = 5;
    roundRect(ctx, x, y, w, h, 26);
    ctx.stroke();
    ctx.lineWidth = 2;
    roundRect(ctx, x + 10, y + 10, w - 20, h - 20, 20);
    ctx.stroke();
  } else if (id === 'star') {
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 3;
    ctx.setLineDash([2, 10]);
    ctx.lineCap = 'round';
    roundRect(ctx, x, y, w, h, 26);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [cx, cy, r] of [[x + 10, y + 10, 18], [x + w - 10, y + 10, 14], [x + 10, y + h - 10, 14], [x + w - 10, y + h - 10, 18], [W / 2, y, 10], [W / 2, y + h, 10]]) star(ctx, cx, cy, r, '#fff8c4');
  } else {
    ctx.strokeStyle = pal.accent;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2;
    roundRect(ctx, x, y, w, h, 26);
    ctx.stroke();
  }
  ctx.restore();
}

function panel(ctx, x, y, w, h) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.30)';
  roundRect(ctx, x, y, w, h, 16);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

async function loadAvatar(url) {
  if (!url || typeof fetch !== 'function') return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return await canvasLib.loadImage(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

function avatar(ctx, img, name, cx, cy, r, pal, frameId) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
  ctx.fillStyle = frameId === 'crown' || frameId === 'legend' ? '#ffcf40' : pal.accent;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  if (img) ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
  else {
    ctx.fillStyle = pal.from;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = '#ffffff';
    ctx.font = B(r);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText([...(name || '?')][0], cx, cy + 4);
  }
  ctx.restore();
  if (frameId === 'crown' || frameId === 'legend') crown(ctx, cx, cy - r - 6, 54, '#ffcf40'); // 아바타 테두리에 얹힌 왕관 (카드 외곽선과 겹치지 않게)
}

/** 카드 한 장 (테마 색·표기 반영) */
function playingCard(ctx, c, themeId, x, y, w, h) {
  const th = cosmetics.cardTheme(themeId);
  const art = th.art;
  const color = art.suits[c.suit];
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = art.bg;
  roundRect(ctx, x, y, w, h, 8);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = art.edge;
  ctx.lineWidth = themeId === 'outline' ? 3 : 2;
  ctx.stroke();
  if (themeId === 'outline') {
    ctx.lineWidth = 1;
    roundRect(ctx, x + 5, y + 5, w - 10, h - 10, 5);
    ctx.stroke();
  }
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  if (themeId === 'letters') {
    ctx.font = B(30);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(cosmetics.card(c, themeId), x + w / 2, y + h / 2 + 2);
  } else {
    ctx.font = B(20);
    ctx.fillText(c.rank, x + 8, y + 7);
    suit(ctx, c.suit, x + 8 + 8, y + 42, 18, color);
    if (themeId === 'outline' && ['J', 'Q', 'K'].includes(c.rank)) crown(ctx, x + w / 2, y + h / 2 + 4, 38, color);
    else suit(ctx, c.suit, x + w / 2 + 4, y + h / 2 + 8, 44, color);
  }
  ctx.restore();
}

const PIPS = { 1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]], 4: [[-1, -1], [1, -1], [-1, 1], [1, 1]], 5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]], 6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]] };
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];

function die(ctx, n, skin, x, y, s) {
  ctx.save();
  ctx.fillStyle = '#fafafa';
  roundRect(ctx, x, y, s, s, 10);
  ctx.fill();
  ctx.strokeStyle = '#bdbdbd';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#222';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (skin === 'numbers') {
    ctx.fillStyle = '#1565c0';
    ctx.font = B(s * 0.6);
    ctx.fillText(String(n), x + s / 2, y + s / 2 + 2);
  } else if (skin === 'roman') {
    ctx.fillStyle = '#6d4c41';
    ctx.font = B(s * (n >= 3 ? 0.36 : 0.48));
    ctx.fillText(ROMAN[n - 1], x + s / 2, y + s / 2 + 2);
  } else {
    for (const [dx, dy] of PIPS[n]) {
      ctx.beginPath();
      ctx.fillStyle = n === 1 ? '#d32f2f' : '#222';
      ctx.arc(x + s / 2 + dx * s * 0.26, y + s / 2 + dy * s * 0.26, s * 0.08, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

const fmt = (n) => Math.floor(n).toLocaleString('en-US');
const signed = (n) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `-${fmt(-n)}` : '±0');
const MUTED = 'rgba(255,255,255,0.62)';
const DIM = 'rgba(255,255,255,0.42)';

function text(ctx, str, x, y, { font = R(16), color = '#ffffff', align = 'left', maxW = null, fitFont = null, size = null, min = 11 } = {}) {
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  let t = str;
  if (maxW && fitFont) t = fitText(ctx, str, maxW, fitFont, size, min);
  else ctx.font = font;
  ctx.fillText(t, x, y);
  return ctx.measureText(t).width;
}

function gradientFill(ctx, x, y, w, h, [a, b]) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  return g;
}

/** 업적 등급 배지 (칭호·대표 업적). 영웅 이상은 별·왕관 장식과 빛 */
function tierPill(ctx, label, tier, x, y, h, { font = B(14), maxW = 220, accent = null } = {}) {
  ctx.font = font;
  const deco = tier ? tier.rank : -1;
  const iconW = deco >= 2 ? 18 : 0;
  let t = label;
  while (t.length > 1 && ctx.measureText(t).width + iconW * (deco >= 3 ? 2 : 1) + 28 > maxW) t = t.slice(0, -1);
  if (t !== label) t = `${t.slice(0, -1)}…`;
  const tw = ctx.measureText(t).width;
  const w = tw + 28 + (deco >= 2 ? iconW : 0) + (deco >= 3 ? iconW + 4 : 0);
  ctx.save();
  if (deco >= 3) {
    ctx.shadowColor = tier.color[0];
    ctx.shadowBlur = 14;
  }
  ctx.fillStyle = tier ? gradientFill(ctx, x, y, w, h, tier.color) : accent;
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fill();
  ctx.restore();
  if (deco >= 3) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, x + 1, y + 1, w - 2, h - 2, h / 2 - 1);
    ctx.stroke();
    ctx.restore();
  }
  const fg = tier ? tier.text : '#0b0f17';
  let cx = x + 14;
  if (deco >= 4) crown(ctx, cx + 7, y + h / 2 + 1, 15, fg);
  else if (deco >= 2) star(ctx, cx + 7, y + h / 2, 7, fg);
  if (deco >= 2) cx += iconW;
  ctx.font = font;
  ctx.fillStyle = fg;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(t, cx, y + h / 2 + 1);
  if (deco >= 3) star(ctx, cx + tw + 13, y + h / 2, 7, fg);
  return w;
}

function statTile(ctx, x, y, w, h, label, value, pal) {
  panel(ctx, x, y, w, h);
  ctx.fillStyle = pal.accent;
  roundRect(ctx, x, y + 16, 4, h - 32, 2);
  ctx.fill();
  text(ctx, label, x + 18, y + 28, { font: R(14), color: MUTED });
  text(ctx, value, x + 18, y + h - 18, { maxW: w - 34, fitFont: B, size: 26, min: 14 });
}

/**
 * @param d { name, avatarURL, equipped, money, rewardPoints, totals, winStreak, maxWinStreak, biggestWin,
 *            achievements: [{id}], games: [{_id, rounds, wins, net}], rank? }
 * @returns PNG Buffer
 *
 * 레이아웃 (1000×640, 콘텐츠 영역 x 40~960):
 *   머리 y 40~200  | 아바타 · 칭호/이름/대표 업적 · 잔고 패널
 *   스탯 y 216~296 | 4칸 (승률 · 최대 연승 · 최대 순이익 · 누적 베팅)
 *   업적 y 312~372 | 진행 바 + 등급별 개수
 *   하단 y 388~596 | 게임별 전적 · 장착 꾸미기
 */
async function render(d) {
  if (!canvasLib) throw new Error('canvas unavailable');
  const eq = { ...cosmetics.DEFAULTS, ...(d.equipped || {}) };
  const pal = palette(eq.color);
  const canvas = canvasLib.createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const L = 40;
  const RT = 960;
  const total = d.totals || {};
  const owned = d.achievements || [];

  background(ctx, pal);
  frame(ctx, eq.frame, pal);

  // ── 머리: 아바타
  const img = await loadAvatar(d.avatarURL);
  avatar(ctx, img, d.name, 116, 122, 70, pal, eq.frame);

  // ── 머리: 칭호 · 이름 · 대표 업적 (아바타 중심에 맞춰 세로 가운데 정렬)
  const TX = 212;
  const TW = 444;
  const best = achievements.showcase(owned, 3);
  const titleAch = eq.title ? achievements.byTitle[eq.title] : null;
  const blocks = [eq.title ? 30 : 0, 44, best.length ? 28 : 0];
  const gaps = blocks.filter(Boolean).length - 1;
  let y = 122 - (blocks.reduce((a, b) => a + b, 0) + gaps * 12) / 2;
  if (eq.title) {
    tierPill(ctx, eq.title, titleAch ? achievements.tierOf(titleAch) : null, TX, y, 30, { font: B(15), maxW: TW, accent: pal.accent });
    y += 30 + 12;
  }
  text(ctx, d.name, TX, y + 38, { maxW: TW, fitFont: B, size: 42, min: 20 });
  y += 44 + 12;
  if (best.length) {
    let bx = TX;
    for (const a of best) {
      const room = TX + TW - bx;
      if (room < 90) break;
      bx += tierPill(ctx, a.name, achievements.tierOf(a), bx, y, 28, { font: B(13), maxW: Math.min(room, 200) }) + 8;
    }
  }

  // ── 머리: 잔고 패널 (라벨 왼쪽 · 값 오른쪽 정렬)
  const PX = 676;
  const PW = RT - PX;
  panel(ctx, PX, 48, PW, 148);
  text(ctx, '잔고', PX + 20, 78, { font: R(14), color: MUTED });
  text(ctx, fmt(d.money ?? 0), RT - 20, 118, { align: 'right', color: '#ffd54f', maxW: PW - 40, fitFont: B, size: 34, min: 16 });
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(PX + 20, 134, PW - 40, 1);
  text(ctx, '보상 포인트', PX + 20, 158, { font: R(14), color: MUTED });
  text(ctx, `${fmt(d.rewardPoints ?? 0)}P`, RT - 20, 158, { font: B(15), align: 'right' });
  text(ctx, '서버 잔고 순위', PX + 20, 182, { font: R(14), color: MUTED });
  text(ctx, d.rank ? `#${fmt(d.rank)}` : '-', RT - 20, 182, { font: B(15), align: 'right' });

  // ── 스탯 4칸
  const winRate = total.games ? `${((total.wins / total.games) * 100).toFixed(1)}%` : '-';
  const tiles = [
    ['승률', total.games ? `${winRate}  (${fmt(total.wins ?? 0)}/${fmt(total.games)})` : '-'],
    ['최대 연승', `${fmt(d.maxWinStreak ?? 0)}연승${d.winStreak ? `  · 현재 ${d.winStreak}` : ''}`],
    ['한 판 최대 순이익', fmt(d.biggestWin ?? 0)],
    ['누적 베팅', fmt(total.wagered ?? 0)],
  ];
  const tw = (RT - L - 16 * 3) / 4;
  tiles.forEach(([label, value], k) => statTile(ctx, L + k * (tw + 16), 216, tw, 80, label, value, pal));

  // ── 업적 띠: 진행 바 + 등급별 개수
  panel(ctx, L, 312, RT - L, 60);
  const have = owned.length;
  const all = achievements.ACHIEVEMENTS.length;
  text(ctx, '업적', L + 20, 338, { font: R(14), color: MUTED });
  text(ctx, `${have} / ${all}`, L + 60, 338, { font: B(16) });
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(ctx, L + 20, 350, 280, 8, 4);
  ctx.fill();
  if (have) {
    ctx.fillStyle = pal.accent;
    roundRect(ctx, L + 20, 350, Math.max(8, (280 * have) / all), 8, 4);
    ctx.fill();
  }
  const counts = achievements.tierCounts(owned);
  const chipX = L + 330;
  const chipW = (RT - 20 - chipX) / achievements.TIER_ORDER.length;
  achievements.TIER_ORDER.forEach((t, k) => {
    const tier = achievements.TIERS[t];
    const cx = chipX + k * chipW;
    const c = counts[t];
    ctx.save();
    if (c.have && tier.rank >= 3) {
      ctx.shadowColor = tier.color[0];
      ctx.shadowBlur = 10;
    }
    ctx.fillStyle = gradientFill(ctx, cx, 334, 16, 16, tier.color);
    ctx.beginPath();
    ctx.arc(cx + 8, 342, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    if (!c.have) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath();
      ctx.arc(cx + 8, 342, 8, 0, Math.PI * 2);
      ctx.fill();
    }
    const lw = text(ctx, tier.label, cx + 24, 348, { font: R(14), color: c.have ? MUTED : DIM });
    text(ctx, `${c.have}/${c.total}`, cx + 24 + lw + 6, 348, { font: B(15), color: c.have ? '#ffffff' : DIM });
  });

  // ── 좌하단: 게임별 전적 (열 고정: 게임 · 판수 · 승률 바 · 승률 · 손익)
  const GX = L;
  const GW = 500;
  const GY = 388;
  panel(ctx, GX, GY, GW, 208);
  text(ctx, '게임별 전적', GX + 20, GY + 32, { font: B(17) });
  text(ctx, '이 서버', GX + 120, GY + 32, { font: R(13), color: DIM });
  const col = { name: GX + 20, rounds: GX + 182, bar: GX + 200, barW: 120, pct: GX + 372, net: GX + GW - 20 };
  text(ctx, '게임', col.name, GY + 58, { font: R(12), color: DIM });
  text(ctx, '판수', col.rounds, GY + 58, { font: R(12), color: DIM, align: 'right' });
  text(ctx, '승률', col.bar, GY + 58, { font: R(12), color: DIM });
  text(ctx, '손익', col.net, GY + 58, { font: R(12), color: DIM, align: 'right' });
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(GX + 20, GY + 66, GW - 40, 1);
  const games = (d.games || []).slice(0, 4);
  if (!games.length) text(ctx, '아직 기록이 없어요. 첫 게임을 시작해 보세요!', GX + 20, GY + 104, { font: R(15), color: MUTED });
  games.forEach((g, k) => {
    const ry = GY + 96 + k * 30;
    const rate = g.rounds ? (g.wins / g.rounds) * 100 : 0;
    text(ctx, registry.GAMES[g._id]?.label ?? g._id, col.name, ry, { maxW: 110, fitFont: B, size: 15, min: 11 });
    text(ctx, fmt(g.rounds), col.rounds, ry, { font: R(14), color: MUTED, align: 'right' });
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    roundRect(ctx, col.bar, ry - 10, col.barW, 8, 4);
    ctx.fill();
    ctx.fillStyle = pal.accent;
    roundRect(ctx, col.bar, ry - 10, Math.max(8, (col.barW * rate) / 100), 8, 4);
    ctx.fill();
    text(ctx, `${rate.toFixed(0)}%`, col.pct, ry, { font: R(14), color: MUTED, align: 'right' });
    text(ctx, signed(g.net), col.net, ry, { align: 'right', color: g.net > 0 ? '#69f0ae' : g.net < 0 ? '#ff8a80' : '#cfd8dc', maxW: 100, fitFont: B, size: 15, min: 11 });
  });

  // ── 우하단: 장착 꾸미기 (실제 모습)
  const EX = GX + GW + 16;
  const EW = RT - EX;
  panel(ctx, EX, GY, EW, 208);
  text(ctx, '장착 중', EX + 20, GY + 32, { font: B(17) });
  const nameOf = (type) => cosmetics.CATALOG[type][eq[type]]?.name ?? eq[type];
  const sample = [{ rank: 'A', suit: '♠' }, { rank: 'K', suit: '♥' }, { rank: 'Q', suit: '♦' }, { rank: 'J', suit: '♣' }];
  const cardW = 50;
  const cardH = 72;
  sample.forEach((c, k) => playingCard(ctx, c, eq.cardTheme, EX + 20 + k * (cardW + 8), GY + 48, cardW, cardH));
  const dX = EX + 20 + 4 * (cardW + 8) + 16;
  const dS = 40;
  die(ctx, 6, eq.diceSkin, dX, GY + 64, dS);
  die(ctx, 3, eq.diceSkin, dX + dS + 8, GY + 64, dS);
  text(ctx, '카드 테마', EX + 20, GY + 140, { font: R(12), color: DIM });
  text(ctx, nameOf('cardTheme'), EX + 20, GY + 158, { maxW: dX - EX - 36, fitFont: B, size: 14, min: 11 });
  text(ctx, '주사위', dX, GY + 140, { font: R(12), color: DIM });
  text(ctx, nameOf('diceSkin'), dX, GY + 158, { maxW: RT - 20 - dX, fitFont: B, size: 14, min: 11 });
  // 하단 3칸: 색상 · 테두리 · 슬롯
  const pills = [
    ['색상', nameOf('color'), true],
    ['테두리', nameOf('frame'), false],
    ['슬롯', nameOf('slotTheme'), false],
  ];
  const pw = (EW - 40 - 16) / 3;
  pills.forEach(([label, value, swatch], k) => {
    const px = EX + 20 + k * (pw + 8);
    const py = GY + 170;
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    roundRect(ctx, px, py, pw, 26, 8);
    ctx.fill();
    let tx = px + 10;
    if (swatch) {
      ctx.fillStyle = pal.accent;
      roundRect(ctx, tx, py + 7, 12, 12, 3);
      ctx.fill();
      tx += 18;
    }
    const lw = text(ctx, label, tx, py + 18, { font: R(12), color: DIM });
    text(ctx, value, tx + lw + 6, py + 18, { maxW: px + pw - 8 - (tx + lw + 6), fitFont: B, size: 13, min: 10 });
  });

  return canvas.encode('png');
}

module.exports = { available, render, PALETTES };
