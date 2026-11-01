/**
 * 랭크 리그 (순수 로직) — 칩 보유량과 무관한 실력 점수.
 * 대상: 실력 비중이 큰 게임(포커페이스·토너먼트)만, 게임 종류별로 따로. 운 게임(슬롯·그래프 등)은 제외.
 * 점수: Elo — 상대 평균 점수와 결과(S)로 기대값(E) 대비 변화. 경기 수가 적을수록 K가 큼.
 *   포커 한 핸드: 이기면 1, 지면 0, 본전 0.5 / 토너먼트: (참가자 − 순위) ÷ (참가자 − 1)
 *   봇은 고정 점수 BOT_RATING.
 * 등급: 브론즈 < 실버 < 골드 < 플래티넘 < 다이아몬드. 강등은 하한보다 DEMOTE_BUFFER 더 떨어져야 (승급 직후 보호).
 * 부스팅 방지: 같은 상대와 하루에 반복한 판은 점수 변화가 줄고(3판 이후 25%, 6판 이후 0), 비공개 방 판은 제외.
 */
const RANKED_GAMES = ['poker', 'tournament'];
const START = 1000;
const BOT_RATING = 1000;
const DEMOTE_BUFFER = 50;
const TIERS = [
  { id: 'bronze', name: '브론즈', emoji: '🥉', min: -Infinity, color: '#b08d57' },
  { id: 'silver', name: '실버', emoji: '🥈', min: 1100, color: '#c0c7d1' },
  { id: 'gold', name: '골드', emoji: '🥇', min: 1300, color: '#ffd54a' },
  { id: 'platinum', name: '플래티넘', emoji: '💎', min: 1500, color: '#5fe3d0' },
  { id: 'diamond', name: '다이아몬드', emoji: '💠', min: 1700, color: '#7cb8ff' },
];
const tierIndex = (id) => TIERS.findIndex((t) => t.id === id);

/** 점수 → 등급 (현재 등급이 있으면 강등 보호 적용) */
function tierFor(rating, current = null) {
  let k = TIERS.length - 1;
  while (k > 0 && rating < TIERS[k].min) k -= 1;
  const cur = current ? tierIndex(current) : -1;
  if (cur > k && rating >= TIERS[cur].min - DEMOTE_BUFFER) return TIERS[cur].id; // 강등 보호 구간
  return TIERS[k].id;
}

const kFactor = (games) => (games < 10 ? 40 : games < 30 ? 24 : 16);

/** 같은 상대와 오늘 반복한 판 수 → 점수 반영 비율 */
function repeatFactor(maxPairGamesToday) {
  if (maxPairGamesToday >= 6) return 0;
  if (maxPairGamesToday >= 3) return 0.25;
  return 1;
}

/** 이 정산 이벤트의 결과 점수 S (0~1) · 대상 아니면 null */
function scoreOf(ev) {
  if (!RANKED_GAMES.includes(ev.game) || ev.status !== 'settled' || ev.detail?.roomId) return null;
  if (ev.game === 'poker') return ev.net > 0 ? 1 : ev.net < 0 ? 0 : 0.5;
  const n = ev.detail?.entrants ?? 0;
  const place = ev.detail?.place;
  if (!n || n < 2 || !place) return null;
  return (n - place) / (n - 1);
}

/** 상대 수(봇 포함) */
function fieldSize(ev) {
  return ev.game === 'poker' ? Math.max(1, (ev.detail?.seats ?? 2) - 1) : Math.max(1, (ev.detail?.entrants ?? 2) - 1);
}

/**
 * 점수 변화 (순수)
 * @param rating 내 점수, games 내 경기 수, opponents [사람 상대 점수], bots 봇 수, S 결과, repeat 반복 비율
 */
function delta({ rating, games, opponents = [], bots = 0, S, repeat = 1 }) {
  const all = [...opponents, ...Array(Math.max(0, bots)).fill(BOT_RATING)];
  const avg = all.length ? all.reduce((a, b) => a + b, 0) / all.length : BOT_RATING;
  const E = 1 / (1 + 10 ** ((avg - rating) / 400));
  return Math.round(kFactor(games) * (S - E) * repeat);
}

/** 새 시즌 시작 점수: 지난 시즌 최종 점수를 기준점 쪽으로 절반 당김 */
const seasonSeed = (lastRating) => (lastRating ? Math.round(START + (lastRating - START) / 2) : START);

module.exports = { RANKED_GAMES, START, BOT_RATING, DEMOTE_BUFFER, TIERS, tierIndex, tierFor, kFactor, repeatFactor, scoreOf, fieldSize, delta, seasonSeed };
