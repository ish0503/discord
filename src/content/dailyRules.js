/**
 * 매일 바뀌는 특별 규칙 (순수 로직).
 * - 날짜 키 해시로 하루 1개를 결정 → 모든 서버·유저가 같은 규칙, 자정(KST) 전에 미리 공개 가능
 * - 규칙은 "도전 목표"만 바꾼다. 게임 확률·배당·지급 규칙은 절대 바꾸지 않는다 (정산 이벤트를 읽기만 함).
 * - 보상: 보상 포인트 + 누적 완수 기록 (칩 지급 없음)
 *
 * matches(ev) → 이 정산 이벤트가 진행도를 얼마나 올리는지 (0이면 무관)
 * metric 'streak' 은 규칙 전용 연승 (지면 0으로)
 */
const crypto = require('node:crypto');

const won = (ev) => ev.net > 0;

const RULES = [
  { id: 'streak3', name: '연승 도전', desc: '아무 게임이나 **3연승** (규칙 전용 연승 — 지면 처음부터)', metric: 'streak', goal: 3, points: 150, matches: () => 1 },
  { id: 'lucky7', name: '럭키 세븐 데이', desc: '주사위에서 **7을 2번** 맞히기', goal: 2, points: 150, matches: (ev) => (ev.game === 'dice' && won(ev) && ev.detail?.choice === 'seven' ? 1 : 0) },
  { id: 'precise', name: '정밀 비행', desc: '그래프를 **2.00x ~ 2.30x 사이**에서 탈출 (수동·자동 모두)', goal: 1, points: 120, matches: (ev) => (ev.game === 'crash' && ev.detail?.cashedAt >= 2 && ev.detail.cashedAt <= 2.3 ? 1 : 0) },
  {
    id: 'twocard',
    name: '두 장의 미학',
    desc: '블랙잭에서 **카드 두 장 그대로(히트 없이)** 2번 이기기',
    goal: 2,
    points: 150,
    matches: (ev) => (ev.game === 'blackjack' ? (ev.detail?.hands || []).filter((h, k) => h.length === 2 && ['win', 'blackjack', 'dealer_bust'].includes(ev.detail.outcomes?.[k])).length : 0),
  },
  { id: 'nofold', name: '무혈입성', desc: '포커에서 **쇼다운 없이**(상대 전원 다이) 2번 이기기', goal: 2, points: 160, matches: (ev) => (ev.game === 'poker' && won(ev) && ev.detail?.endReason === 'fold' ? 1 : 0) },
  { id: 'slot20', name: '릴 마라톤', desc: '슬롯 **20회** 스핀', goal: 20, points: 120, matches: (ev) => (ev.game === 'slot' ? 1 : 0) },
  { id: 'bac3', name: '흐름 읽기', desc: '바카라에서 **3번** 적중', goal: 3, points: 130, matches: (ev) => (ev.game === 'baccarat' && won(ev) ? 1 : 0) },
  { id: 'smallwin', name: '작은 고추가 맵다', desc: '**1,000칩 이하** 베팅으로 5번 승리', goal: 5, points: 140, matches: (ev) => (won(ev) && ev.staked <= 1000 ? 1 : 0) },
  { id: 'variety', name: '카지노 투어', desc: '서로 다른 게임 **4종** 플레이', metric: 'distinct', goal: 4, points: 150, matches: () => 1 },
  { id: 'tourney', name: '토너먼트 데이', desc: '토너먼트 **완주 1회**', goal: 1, points: 200, matches: (ev) => (ev.game === 'tournament' ? 1 : 0) },
];

const byId = Object.fromEntries(RULES.map((r) => [r.id, r]));

/** 그날의 규칙 (날짜 키 해시로 결정) */
function forDay(dayKey) {
  const h = crypto.createHash('sha256').update(`rule:${dayKey}`).digest();
  return RULES[h.readUInt32BE(0) % RULES.length];
}

/**
 * 진행 상태 갱신 (순수). state = { progress, streak, games: [] }
 * @returns 새 state
 */
function advance(rule, state, ev) {
  const s = { progress: state?.progress ?? 0, streak: state?.streak ?? 0, games: [...(state?.games ?? [])] };
  if (rule.metric === 'streak') {
    s.streak = won(ev) ? s.streak + 1 : ev.net < 0 ? 0 : s.streak;
    s.progress = Math.max(s.progress, s.streak);
  } else if (rule.metric === 'distinct') {
    if (!s.games.includes(ev.game)) s.games.push(ev.game);
    s.progress = s.games.length;
  } else {
    s.progress += rule.matches(ev);
  }
  s.progress = Math.min(s.progress, rule.goal);
  return s;
}

module.exports = { RULES, byId, forDay, advance };
