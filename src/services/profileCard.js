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
const H = 600;
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
      const fh = 18 + ((fx * 7) % 17);
      ctx.beginPath();
      ctx.moveTo(fx - 12, H - inset);
      ctx.quadraticCurveTo(fx - 8, H - inset - fh * 0.6, fx, H - inset - fh);
      ctx.quadraticCurveTo(fx + 8, H - inset - fh * 0.6, fx + 12, H - inset);
      ctx.closePath();
      ctx.fill();
    }
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
  ctx.fillStyle = frameId === 'crown' ? '#ffcf40' : pal.accent;
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
  if (frameId === 'crown') crown(ctx, cx, cy - r - 14, 64, '#ffcf40');
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

function statTile(ctx, x, y, w, label, value, pal) {
  panel(ctx, x, y, w, 76);
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = R(15);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(label, x + 14, y + 12);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(fitText(ctx, value, w - 28, B, 26), x + 14, y + 36);
  ctx.fillStyle = pal.accent;
  ctx.fillRect(x, y + 14, 3, 48);
}

const fmt = (n) => Math.floor(n).toLocaleString('en-US');
const signed = (n) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `-${fmt(-n)}` : '±0');

/**
 * @param d { name, avatarURL, equipped, money, rewardPoints, totals, winStreak, maxWinStreak, biggestWin, achievementCount, games: [{_id, rounds, wins, net}], rank? }
 * @returns PNG Buffer
 */
async function render(d) {
  if (!canvasLib) throw new Error('canvas unavailable');
  const eq = { ...cosmetics.DEFAULTS, ...(d.equipped || {}) };
  const pal = palette(eq.color);
  const canvas = canvasLib.createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  background(ctx, pal);
  frame(ctx, eq.frame, pal);

  // ── 머리: 아바타 · 이름 · 칭호
  const img = await loadAvatar(d.avatarURL);
  avatar(ctx, img, d.name, 130, 140, 74, pal, eq.frame);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  let ty = 104;
  if (eq.title) {
    ctx.font = B(17);
    const label = `「${eq.title}」`;
    const tw = ctx.measureText(label).width + 26;
    ctx.fillStyle = pal.accent;
    roundRect(ctx, 236, ty - 26, tw, 34, 17);
    ctx.fill();
    ctx.fillStyle = '#0b0f17';
    ctx.fillText(label, 249, ty - 3);
    ty += 50;
  } else ty += 30;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(fitText(ctx, d.name, 450, B, 46, 22), 236, ty);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = R(18);
  const total = d.totals || {};
  const winRate = total.games ? `${((total.wins / total.games) * 100).toFixed(1)}%` : '-';
  ctx.fillText(`총 ${fmt(total.games ?? 0)}판 · ${fmt(total.wins ?? 0)}승 · 누적 베팅 ${fmt(total.wagered ?? 0)}`, 238, ty + 34);

  // ── 우상단: 잔고 · 포인트
  panel(ctx, 700, 46, 256, 132);
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = R(15);
  ctx.fillText('잔고', 936, 76);
  ctx.fillStyle = '#ffd54f';
  ctx.fillText(fitText(ctx, fmt(d.money ?? 0), 210, B, 34), 936, 114);
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = R(15);
  ctx.fillText(`보상 포인트 ${fmt(d.rewardPoints ?? 0)}P`, 936, 146);
  if (d.rank) ctx.fillText(`서버 잔고 순위 #${d.rank}`, 936, 166);
  ctx.textAlign = 'left';

  // ── 스탯 타일
  const tiles = [
    ['승률', winRate],
    ['최대 연승', `${fmt(d.maxWinStreak ?? 0)}연승${d.winStreak ? ` (현재 ${d.winStreak})` : ''}`],
    ['한 판 최대 순이익', fmt(d.biggestWin ?? 0)],
    ['업적', `${d.achievementCount ?? 0} / ${achievements.ACHIEVEMENTS.length}`],
  ];
  tiles.forEach(([label, value], k) => statTile(ctx, 44 + k * 230, 246, 216, label, value, pal));
  // 업적 진행 바
  const ratio = Math.min(1, (d.achievementCount ?? 0) / Math.max(1, achievements.ACHIEVEMENTS.length));
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(ctx, 44, 334, 906, 8, 4);
  ctx.fill();
  if (ratio > 0) {
    ctx.fillStyle = pal.accent;
    roundRect(ctx, 44, 334, Math.max(8, 906 * ratio), 8, 4);
    ctx.fill();
  }

  // ── 좌하단: 게임별 전적
  panel(ctx, 44, 362, 520, 194);
  ctx.fillStyle = '#ffffff';
  ctx.font = B(18);
  ctx.fillText('게임별 전적 (이 서버)', 64, 392);
  const games = (d.games || []).slice(0, 4);
  if (!games.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = R(16);
    ctx.fillText('아직 기록이 없어요. 첫 게임을 시작해 보세요!', 64, 430);
  }
  games.forEach((g, k) => {
    const y = 428 + k * 32;
    const rate = g.rounds ? (g.wins / g.rounds) * 100 : 0;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = B(16);
    ctx.fillText(registry.GAMES[g._id]?.label ?? g._id, 64, y);
    ctx.font = R(15);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(`${fmt(g.rounds)}판`, 170, y);
    // 승률 바
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    roundRect(ctx, 240, y - 12, 150, 10, 5);
    ctx.fill();
    ctx.fillStyle = pal.accent;
    roundRect(ctx, 240, y - 12, Math.max(6, 1.5 * rate), 10, 5);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(`${rate.toFixed(0)}%`, 398, y);
    ctx.textAlign = 'right';
    ctx.fillStyle = g.net > 0 ? '#69f0ae' : g.net < 0 ? '#ff8a80' : '#cfd8dc';
    ctx.font = B(16);
    ctx.fillText(signed(g.net), 544, y);
    ctx.textAlign = 'left';
  });

  // ── 우하단: 장착 꾸미기 (실제 모습으로)
  panel(ctx, 580, 362, 376, 194);
  ctx.fillStyle = '#ffffff';
  ctx.font = B(18);
  ctx.fillText('장착 중', 600, 392);
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = R(14);
  const nameOf = (type) => cosmetics.CATALOG[type][eq[type]]?.name ?? eq[type];
  ctx.fillText(`카드 · ${nameOf('cardTheme')}`, 600, 418);
  const sample = [{ rank: 'A', suit: '♠' }, { rank: 'K', suit: '♥' }, { rank: 'Q', suit: '♦' }, { rank: 'J', suit: '♣' }];
  sample.forEach((c, k) => playingCard(ctx, c, eq.cardTheme, 600 + k * 62, 430, 54, 78));
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText(`주사위 · ${nameOf('diceSkin')}`, 852, 418);
  die(ctx, 6, eq.diceSkin, 852, 430, 38);
  die(ctx, 3, eq.diceSkin, 896, 430, 38);
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = R(14);
  ctx.fillText(`슬롯 · ${nameOf('slotTheme')}`, 852, 486);
  ctx.fillText(`테두리 · ${nameOf('frame')}`, 852, 506);
  ctx.fillText('색상 · ', 600, 536);
  const cw = ctx.measureText('색상 · ').width;
  ctx.fillStyle = pal.accent;
  roundRect(ctx, 600 + cw, 523, 16, 16, 4);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText(nameOf('color'), 600 + cw + 22, 536);

  return canvas.encode('png');
}

module.exports = { available, render, PALETTES };
