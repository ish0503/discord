/**
 * 업적 정의 & 판정 (순수 로직).
 * 보상은 칭호와 보상 포인트 (칩 발행 없음). hidden=true는 달성 전까지 목록에 ??? 로 표시.
 *
 * check(ctx): ctx = { ev(정산 이벤트 또는 null), profile(갱신 후), wallet(지갑, 선택), trigger }
 */
const A = [
  { id: 'first_win', name: '첫 승리', desc: '아무 게임에서 처음으로 이기기', rarity: 'common', title: '새내기 승부사', points: 50, check: (c) => c.profile.totals.wins >= 1 },
  { id: 'games_100', name: '카지노 단골', desc: '총 100판 플레이', rarity: 'common', title: '카지노 단골', points: 100, check: (c) => c.profile.totals.games >= 100 },
  { id: 'games_1000', name: 'VIP', desc: '총 1,000판 플레이', rarity: 'rare', title: 'VIP', points: 500, check: (c) => c.profile.totals.games >= 1000 },
  { id: 'streak_5', name: '연승의 달인', desc: '5연승 달성', rarity: 'rare', title: '연승의 달인', points: 150, check: (c) => c.profile.maxWinStreak >= 5 },
  { id: 'streak_10', name: '멈추지 않는 자', desc: '10연승 달성', rarity: 'epic', hidden: true, title: '전설의 연승', points: 400, check: (c) => c.profile.maxWinStreak >= 10 },
  { id: 'lucky_10x', name: '행운의 시작', desc: '한 판에서 건 금액의 10배 이상 받기', rarity: 'rare', title: '행운아', points: 100, check: (c) => c.ev && c.ev.staked > 0 && c.ev.payout >= c.ev.staked * 10 },
  { id: 'high_roller', name: '하이롤러', desc: '누적 베팅 1,000,000칩', rarity: 'rare', title: '하이롤러', points: 300, check: (c) => c.profile.totals.wagered >= 1_000_000 },
  { id: 'bj_natural', name: '내추럴', desc: '블랙잭으로 승리', rarity: 'common', title: '내추럴', points: 50, check: (c) => c.ev?.game === 'blackjack' && c.ev.detail?.outcomes?.includes('blackjack') },
  { id: 'bj_split_sweep', name: '갈라서 다 먹기', desc: '스플릿한 손을 모두 이기기', rarity: 'rare', title: '분할 정복', points: 150, check: (c) => c.ev?.game === 'blackjack' && c.ev.detail?.outcomes?.length >= 2 && c.ev.detail.outcomes.every((o) => ['win', 'dealer_bust'].includes(o)) },
  { id: 'insurance_hit', name: '보험왕', desc: '딜러 블랙잭에 보험 적중', rarity: 'common', title: '보험왕', points: 60, check: (c) => c.ev?.game === 'blackjack' && c.ev.detail?.insurancePaid > 0 },
  { id: 'poker_master', name: '포커 마스터', desc: '포커에서 플러시 이상으로 승리', rarity: 'rare', title: '포커 마스터', points: 200, check: (c) => c.ev?.game === 'poker' && c.ev.net > 0 && c.ev.detail?.handCategory >= 5 },
  { id: 'poker_royal', name: '로열 로드', desc: '로열 스트레이트 플러시로 승리', rarity: 'epic', hidden: true, title: '로열 로드', points: 1000, check: (c) => c.ev?.game === 'poker' && c.ev.net > 0 && c.ev.detail?.hand === '로열 스트레이트 플러시' },
  { id: 'poker_allin', name: '올인 생존자', desc: '포커에서 올인하고 이기기', rarity: 'common', title: '배짱', points: 80, check: (c) => c.ev?.game === 'poker' && c.ev.net > 0 && c.ev.detail?.wentAllIn },
  { id: 'slot_jackpot', name: '슬롯의 전설', desc: '슬롯 잭팟 당첨', rarity: 'epic', title: '슬롯의 전설', points: 500, check: (c) => c.ev?.game === 'slot' && c.ev.detail?.jackpot > 0 },
  { id: 'crash_10x', name: '로켓 탑승', desc: '그래프 10배 이상에서 탈출', rarity: 'rare', title: '로켓맨', points: 150, check: (c) => c.ev?.game === 'crash' && c.ev.detail?.cashedAt >= 10 },
  { id: 'crash_100x', name: '달까지', desc: '그래프 100배 이상에서 탈출', rarity: 'epic', hidden: true, title: '문워커', points: 600, check: (c) => c.ev?.game === 'crash' && c.ev.detail?.cashedAt >= 100 },
  { id: 'dice_seven', name: '럭키 세븐', desc: '주사위 7 적중', rarity: 'common', title: '럭키 세븐', points: 50, check: (c) => c.ev?.game === 'dice' && c.ev.net > 0 && c.ev.detail?.choice === 'seven' },
  { id: 'bac_tie', name: '무승부의 미학', desc: '바카라 타이 적중', rarity: 'rare', title: '균형주의자', points: 120, check: (c) => c.ev?.game === 'baccarat' && c.ev.net > 0 && c.ev.detail?.side === 'tie' },
  { id: 'tourney_win', name: '챔피언', desc: '토너먼트 우승', rarity: 'epic', title: '챔피언', points: 500, check: (c) => c.ev?.game === 'tournament' && c.ev.detail?.place === 1 },
  { id: 'daily_7', name: '개근상', desc: '7일 연속 출석', rarity: 'common', title: '개근상', points: 150, check: (c) => c.trigger === 'daily' && c.dailyStreak >= 7 },
  { id: 'season_top', name: '시즌 정상', desc: '시즌 랭킹 3위 이내 마감', rarity: 'epic', title: '시즌 챔피언', points: 800, check: (c) => c.trigger === 'season' && c.seasonRank <= 3 },
];

const RARITY = { common: '⚪', rare: '🔵', epic: '🟣' };
const byId = Object.fromEntries(A.map((a) => [a.id, a]));

/** 아직 못 받은 업적 중 이번 컨텍스트로 달성한 것 */
function evaluate(ctx, unlockedIds) {
  const have = new Set(unlockedIds);
  return A.filter((a) => !have.has(a.id)).filter((a) => {
    try {
      return Boolean(a.check(ctx));
    } catch {
      return false;
    }
  });
}

module.exports = { ACHIEVEMENTS: A, RARITY, byId, evaluate };
