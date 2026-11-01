/**
 * 수집품 카탈로그 (순수). 수집품은 장식·기록 용도 — 게임 확률·지급 배율에 영향 없음.
 * rarity: common | rare | epic | legendary  ·  limited: { until, label } 기간 한정 표시
 * source: 획득 경로 설명 (화면에 그대로 공개)
 */
const ITEMS = [
  // 월드 보스 카드 (참여 시 카드, 처치 성공 시 황금 카드)
  { id: 'boss:dragon', name: '그리드의 비늘', emoji: '🐉', rarity: 'rare', set: 'bosses', source: '월드 보스 「그리드」 참여' },
  { id: 'boss:golem', name: '토큰의 핵', emoji: '🗿', rarity: 'rare', set: 'bosses', source: '월드 보스 「토큰」 참여' },
  { id: 'boss:phantom', name: '셔플의 카드', emoji: '👻', rarity: 'rare', set: 'bosses', source: '월드 보스 「셔플」 참여' },
  { id: 'boss:kraken', name: '잭팟의 촉수', emoji: '🦑', rarity: 'rare', set: 'bosses', source: '월드 보스 「잭팟」 참여' },
  { id: 'bossgold:dragon', name: '황금 그리드 카드', emoji: '🐉', rarity: 'epic', set: 'goldbosses', source: '월드 보스 「그리드」 처치 성공' },
  { id: 'bossgold:golem', name: '황금 토큰 카드', emoji: '🗿', rarity: 'epic', set: 'goldbosses', source: '월드 보스 「토큰」 처치 성공' },
  { id: 'bossgold:phantom', name: '황금 셔플 카드', emoji: '👻', rarity: 'epic', set: 'goldbosses', source: '월드 보스 「셔플」 처치 성공' },
  { id: 'bossgold:kraken', name: '황금 잭팟 카드', emoji: '🦑', rarity: 'epic', set: 'goldbosses', source: '월드 보스 「잭팟」 처치 성공' },
  // 스토리
  { id: 'story:ch1', name: '입장권', emoji: '🎟️', rarity: 'common', set: 'story', source: '스토리 1장 완료' },
  { id: 'story:ch2', name: 'VIP 샴페인', emoji: '🥂', rarity: 'common', set: 'story', source: '스토리 2장 완료' },
  { id: 'story:ch3', name: '은빛 손의 칩', emoji: '🪙', rarity: 'rare', set: 'story', source: '스토리 3장 완료' },
  { id: 'story:ch4', name: '왕좌의 왕관', emoji: '👑', rarity: 'legendary', set: 'story', source: '스토리 4장 완료' },
  // 게임 기념품 (기록 달성)
  { id: 'game:jackpot', name: '777 기념 메달', emoji: '🎰', rarity: 'legendary', set: 'games', source: '슬롯 잭팟 당첨' },
  { id: 'game:royal', name: '로열 플러시 액자', emoji: '🖼️', rarity: 'legendary', set: 'games', source: '포커 로열 스트레이트 플러시 승리' },
  { id: 'game:rocket', name: '로켓 모형', emoji: '🚀', rarity: 'epic', set: 'games', source: '그래프 50배 이상 탈출' },
  { id: 'game:trophy', name: '토너먼트 트로피', emoji: '🏆', rarity: 'rare', set: 'games', source: '토너먼트 우승' },
  { id: 'game:lucky7', name: '럭키 세븐 주사위', emoji: '🎲', rarity: 'common', set: 'games', source: '주사위 7 적중' },
  { id: 'game:natural', name: '블랙잭 칩', emoji: '🃏', rarity: 'common', set: 'games', source: '블랙잭(내추럴) 승리' },
  // 랭크 리그
  { id: 'rank:gold', name: '골드 리그 배지', emoji: '🥇', rarity: 'rare', set: 'rank', source: '랭크 골드 달성' },
  { id: 'rank:diamond', name: '다이아몬드 리그 배지', emoji: '💠', rarity: 'legendary', set: 'rank', source: '랭크 다이아몬드 달성' },
  // 시즌 한정 (시즌마다 새 아이템을 추가하고 limited 기간을 공개)
  { id: 'season:2026w', name: '2026 겨울 시즌 눈꽃', emoji: '❄️', rarity: 'epic', set: 'season', source: '2026 겨울 시즌 동안 특별 규칙 3회 완수', limited: { from: '2026-12-01', until: '2027-02-28', label: '2026-27 겨울 한정' } },
];
const byId = Object.fromEntries(ITEMS.map((i) => [i.id, i]));

/** 세트 완성 보상 (칭호, 1회) */
const SETS = {
  bosses: { name: '보스 도감', reward: { title: '보스 수집가', points: 400 } },
  goldbosses: { name: '황금 보스 카드', reward: { title: '황금 사냥꾼', points: 1000 } },
  story: { name: '스토리 기념품', reward: { title: '이야기 수집가', points: 300 } },
  games: { name: '게임 기념품', reward: { title: '기념품 수집가', points: 800 } },
  rank: { name: '리그 배지', reward: { title: '리그의 증인', points: 600 } },
  season: { name: '시즌 한정', reward: null },
};
const setItems = (setId) => ITEMS.filter((i) => i.set === setId);

const RARITY = { common: '⚪ 일반', rare: '🔵 희귀', epic: '🟣 영웅', legendary: '🟡 전설' };

/** 기간 한정 아이템이 지금 획득 가능한지 */
function obtainable(item, now = new Date()) {
  if (!item?.limited) return true;
  if (item.limited.from && now < new Date(item.limited.from)) return false;
  if (item.limited.until && now > new Date(`${item.limited.until}T23:59:59+09:00`)) return false;
  return true;
}

/** 정산 이벤트로 얻는 게임 기념품 */
function fromEvent(ev) {
  if (ev.status !== 'settled' || ev.net <= 0) return [];
  const out = [];
  if (ev.game === 'slot' && ev.detail?.jackpot > 0) out.push('game:jackpot');
  if (ev.game === 'poker' && ev.detail?.hand === '로열 스트레이트 플러시') out.push('game:royal');
  if (ev.game === 'crash' && ev.detail?.cashedAt >= 50) out.push('game:rocket');
  if (ev.game === 'tournament' && ev.detail?.place === 1) out.push('game:trophy');
  if (ev.game === 'dice' && ev.detail?.choice === 'seven') out.push('game:lucky7');
  if (ev.game === 'blackjack' && ev.detail?.outcomes?.includes('blackjack')) out.push('game:natural');
  return out;
}

module.exports = { ITEMS, byId, SETS, setItems, RARITY, obtainable, fromEvent };
