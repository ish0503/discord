/**
 * 업적 정의 & 판정 (순수 로직).
 * 보상은 칭호와 보상 포인트 (칩 발행 없음). hidden=true는 달성 전까지 목록에 ??? 로 표시.
 *
 * 등급 (TIERS): 일반 → 희귀 → 영웅 → 전설 → 신화
 *  - 영웅 이상은 이름에 특수기호 장식 (display), 프로필 이미지 카드에서는 등급별 배지로 그려짐
 *  - id는 저장 데이터와 연결되므로 바꾸지 말 것 (등급·이름·설명은 바꿔도 됨)
 *
 * check(ctx): ctx = { ev(정산 이벤트 또는 null), profile(갱신 후), trigger, dailyStreak?, seasonRank? }
 */

/** 등급 정의 (낮은 → 높은 순) — deco: 이름 장식, color/glow: 프로필 이미지 배지 색 */
const TIERS = {
  common: { rank: 0, label: '일반', emoji: '⚪', deco: (n) => n, color: ['#5f6b7a', '#4a5462'], text: '#eef1f5' },
  rare: { rank: 1, label: '희귀', emoji: '🔵', deco: (n) => n, color: ['#1e6fd9', '#1552a3'], text: '#ffffff' },
  epic: { rank: 2, label: '영웅', emoji: '🟣', deco: (n) => `✧ ${n} ✧`, color: ['#9b4dff', '#6a1fd1'], text: '#ffffff' },
  legendary: { rank: 3, label: '전설', emoji: '🟡', deco: (n) => `『✦ ${n} ✦』`, color: ['#ffd54a', '#e09b00'], text: '#2b1d00' },
  mythic: { rank: 4, label: '신화', emoji: '🔴', deco: (n) => `⟪♛ ${n} ♛⟫`, color: ['#ff3d6e', '#7a2cff'], text: '#ffffff' },
};
const TIER_ORDER = ['mythic', 'legendary', 'epic', 'rare', 'common'];

const won = (c, game) => c.ev?.game === game && c.ev.net > 0;

const A = [
  // ───────── ⚪ 일반 ─────────
  { id: 'first_game', name: '첫 발걸음', desc: '아무 게임이나 1판 플레이', rarity: 'common', title: '카지노 입문자', points: 20, check: (c) => c.profile.totals.games >= 1 },
  { id: 'first_win', name: '첫 승리', desc: '아무 게임에서 처음으로 이기기', rarity: 'common', title: '새내기 승부사', points: 50, check: (c) => c.profile.totals.wins >= 1 },
  { id: 'games_100', name: '카지노 단골', desc: '총 100판 플레이', rarity: 'common', title: '카지노 단골', points: 100, check: (c) => c.profile.totals.games >= 100 },
  { id: 'wins_50', name: '승리의 맛', desc: '총 50승', rarity: 'common', title: '승리의 맛', points: 80, check: (c) => c.profile.totals.wins >= 50 },
  { id: 'bj_natural', name: '내추럴', desc: '블랙잭으로 승리', rarity: 'common', title: '내추럴', points: 50, check: (c) => c.ev?.game === 'blackjack' && c.ev.detail?.outcomes?.includes('blackjack') },
  { id: 'insurance_hit', name: '보험왕', desc: '딜러 블랙잭에 보험 적중', rarity: 'common', title: '보험왕', points: 60, check: (c) => c.ev?.game === 'blackjack' && c.ev.detail?.insurancePaid > 0 },
  { id: 'poker_allin', name: '올인 생존자', desc: '포커에서 올인하고 이기기', rarity: 'common', title: '배짱', points: 80, check: (c) => won(c, 'poker') && c.ev.detail?.wentAllIn },
  { id: 'dice_seven', name: '럭키 세븐', desc: '주사위 7 적중', rarity: 'common', title: '럭키 세븐', points: 50, check: (c) => won(c, 'dice') && c.ev.detail?.choice === 'seven' },
  { id: 'slot_triple', name: '트리플', desc: '슬롯에서 같은 그림 3개', rarity: 'common', title: '트리플', points: 50, check: (c) => c.ev?.game === 'slot' && c.ev.detail?.multiplier >= 3 },
  { id: 'crash_2x', name: '이륙', desc: '그래프 2배 이상에서 탈출', rarity: 'common', title: '파일럿', points: 40, check: (c) => c.ev?.game === 'crash' && c.ev.detail?.cashedAt >= 2 },
  { id: 'bac_natural', name: '내추럴 나인', desc: '바카라 내추럴 판에서 이기기', rarity: 'common', title: '내추럴 나인', points: 50, check: (c) => won(c, 'baccarat') && c.ev.detail?.natural },
  { id: 'tourney_play', name: '토너먼트 데뷔', desc: '토너먼트 완주', rarity: 'common', title: '도전자', points: 50, check: (c) => c.ev?.game === 'tournament' },
  { id: 'rule_1', name: '규칙 수호자', desc: '오늘의 특별 규칙 처음 완수', rarity: 'common', title: '규칙 수호자', points: 60, check: (c) => (c.profile.ruleCompletions ?? 0) >= 1 },
  { id: 'story_1', name: '이야기의 시작', desc: '스토리 1장 완료', rarity: 'common', title: '이야기꾼', points: 80, check: (c) => (c.profile.storyRewards?.length ?? 0) >= 1 },
  { id: 'clan_join', name: '소속감', desc: '클랜에 가입하거나 창설', rarity: 'common', title: '클랜원', points: 50, check: (c) => c.trigger === 'clan' },
  { id: 'boss_join', name: '토벌대 합류', desc: '월드 보스 토벌에 참여', rarity: 'common', title: '토벌대원', points: 80, check: (c) => c.trigger === 'boss' },
  { id: 'predict_1', name: '예언자의 첫걸음', desc: '토너먼트 우승자 예측 첫 적중', rarity: 'common', title: '예언가 지망생', points: 60, check: (c) => (c.profile.predict?.correct ?? 0) >= 1 },
  { id: 'rival_first', name: '숙명의 상대', desc: '라이벌 맺기', rarity: 'common', title: '라이벌', points: 50, check: (c) => c.trigger === 'rival' },
  { id: 'daily_7', name: '개근상', desc: '7일 연속 출석', rarity: 'common', title: '개근상', points: 150, check: (c) => c.trigger === 'daily' && c.dailyStreak >= 7 },

  // ───────── 🔵 희귀 ─────────
  { id: 'games_1000', name: 'VIP', desc: '총 1,000판 플레이', rarity: 'rare', title: 'VIP', points: 500, check: (c) => c.profile.totals.games >= 1000 },
  { id: 'wins_500', name: '백전노장', desc: '총 500승', rarity: 'rare', title: '백전노장', points: 300, check: (c) => c.profile.totals.wins >= 500 },
  { id: 'streak_5', name: '연승의 달인', desc: '5연승 달성', rarity: 'rare', title: '연승의 달인', points: 150, check: (c) => c.profile.maxWinStreak >= 5 },
  { id: 'lucky_10x', name: '행운의 시작', desc: '한 판에서 건 금액의 10배 이상 받기', rarity: 'rare', title: '행운아', points: 100, check: (c) => c.ev && c.ev.staked > 0 && c.ev.payout >= c.ev.staked * 10 },
  { id: 'high_roller', name: '하이롤러', desc: '누적 베팅 1,000,000칩', rarity: 'rare', title: '하이롤러', points: 300, check: (c) => c.profile.totals.wagered >= 1_000_000 },
  { id: 'bj_split_sweep', name: '갈라서 다 먹기', desc: '스플릿한 손을 모두 이기기', rarity: 'rare', title: '분할 정복', points: 150, check: (c) => c.ev?.game === 'blackjack' && c.ev.detail?.outcomes?.length >= 2 && c.ev.detail.outcomes.every((o) => ['win', 'dealer_bust'].includes(o)) },
  { id: 'bj_five_card', name: '파이브 카드', desc: '블랙잭에서 5장 이상으로 이기기', rarity: 'rare', title: '끈기의 승부사', points: 150, check: (c) => c.ev?.game === 'blackjack' && (c.ev.detail?.hands || []).some((h, k) => h.length >= 5 && ['win', 'dealer_bust'].includes(c.ev.detail.outcomes?.[k])) },
  { id: 'poker_master', name: '포커 마스터', desc: '포커에서 플러시 이상으로 승리', rarity: 'rare', title: '포커 마스터', points: 200, check: (c) => won(c, 'poker') && c.ev.detail?.handCategory >= 5 },
  { id: 'crash_10x', name: '로켓 탑승', desc: '그래프 10배 이상에서 탈출', rarity: 'rare', title: '로켓맨', points: 150, check: (c) => c.ev?.game === 'crash' && c.ev.detail?.cashedAt >= 10 },
  { id: 'bac_tie', name: '무승부의 미학', desc: '바카라 타이 적중', rarity: 'rare', title: '균형주의자', points: 120, check: (c) => won(c, 'baccarat') && c.ev.detail?.side === 'tie' },
  { id: 'tourney_itm', name: '입상', desc: '사람 3명 이상 토너먼트에서 3위 이내', rarity: 'rare', title: '시상대', points: 200, check: (c) => c.ev?.game === 'tournament' && c.ev.detail?.humans >= 3 && c.ev.detail?.place <= 3 },
  { id: 'rule_7', name: '규칙의 달인', desc: '특별 규칙 7번 완수', rarity: 'rare', title: '규칙의 달인', points: 250, check: (c) => (c.profile.ruleCompletions ?? 0) >= 7 },
  { id: 'hof_entry', name: '전당 입성', desc: '이 서버 명예의 전당에 기록 남기기', rarity: 'rare', title: '전당의 얼굴', points: 200, check: (c) => c.trigger === 'hof' },
  { id: 'clan_found', name: '창립자', desc: '클랜 창설', rarity: 'rare', title: '클랜 창립자', points: 200, check: (c) => c.trigger === 'clan' && c.clanRole === 'owner' },
  { id: 'boss_slay', name: '보스 슬레이어', desc: '월드 보스 처치 성공에 참여', rarity: 'rare', title: '보스 슬레이어', points: 300, check: (c) => c.trigger === 'boss' && c.bossDefeated === true },
  { id: 'collect_set', name: '수집가', desc: '수집 세트 하나 완성', rarity: 'rare', title: '세트 완성가', points: 250, check: (c) => (c.profile.collectionSets?.length ?? 0) >= 1 },
  { id: 'rank_gold', name: '골드 리그', desc: '랭크 골드 등급 달성', rarity: 'rare', title: '골드 리거', points: 300, check: (c) => c.trigger === 'rank' && ['gold', 'platinum', 'diamond'].includes(c.rankTier) },
  { id: 'predict_streak3', name: '꿰뚫어 보는 눈', desc: '예측 3연속 적중', rarity: 'rare', title: '통찰가', points: 300, check: (c) => (c.profile.predict?.bestStreak ?? 0) >= 3 },
  { id: 'rival_10', name: '라이벌 킬러', desc: '라이벌과의 맞대결 10승', rarity: 'rare', title: '라이벌 킬러', points: 300, check: (c) => c.trigger === 'rival' && (c.rivalWins ?? 0) >= 10 },
  { id: 'points_5000', name: '포인트 수집가', desc: '보상 포인트 5,000P 보유', rarity: 'rare', title: '수집가', points: 200, check: (c) => c.profile.rewardPoints >= 5000 },

  // ───────── 🟣 영웅 ─────────
  { id: 'games_3000', name: '카지노 터줏대감', desc: '총 3,000판 플레이', rarity: 'epic', title: '터줏대감', points: 800, check: (c) => c.profile.totals.games >= 3000 },
  { id: 'streak_7', name: '칠전칠승', desc: '7연승 달성', rarity: 'epic', title: '칠전칠승', points: 300, check: (c) => c.profile.maxWinStreak >= 7 },
  { id: 'slot_diamond', name: '다이아몬드 핸즈', desc: '슬롯 💎💎💎 (×100)', rarity: 'epic', title: '다이아몬드 핸즈', points: 400, check: (c) => c.ev?.game === 'slot' && c.ev.detail?.multiplier === 100 },
  { id: 'poker_quads', name: '포카드', desc: '포커에서 포카드 이상으로 승리', rarity: 'epic', title: '사천왕', points: 500, check: (c) => won(c, 'poker') && c.ev.detail?.handCategory >= 7 },
  { id: 'crash_50x', name: '성층권', desc: '그래프 50배 이상에서 탈출', rarity: 'epic', title: '성층권 비행사', points: 400, check: (c) => c.ev?.game === 'crash' && c.ev.detail?.cashedAt >= 50 },
  { id: 'tourney_win', name: '챔피언', desc: '토너먼트 우승', rarity: 'epic', title: '챔피언', points: 500, check: (c) => c.ev?.game === 'tournament' && c.ev.detail?.place === 1 },
  { id: 'high_roller_10m', name: '큰손 중의 큰손', desc: '누적 베팅 10,000,000칩', rarity: 'epic', title: '큰손 중의 큰손', points: 700, check: (c) => c.profile.totals.wagered >= 10_000_000 },
  { id: 'rule_30', name: '규칙의 지배자', desc: '특별 규칙 30번 완수', rarity: 'epic', title: '규칙의 지배자', points: 700, check: (c) => (c.profile.ruleCompletions ?? 0) >= 30 },
  { id: 'story_all', name: '왕좌의 주인공', desc: '스토리 모든 챕터 완료', rarity: 'epic', title: '전설의 주인공', points: 800, check: (c) => (c.profile.storyRewards?.length ?? 0) >= 4 },
  { id: 'clan_lv5', name: '명문 클랜', desc: '레벨 5 이상 클랜의 멤버', rarity: 'epic', title: '명문가', points: 500, check: (c) => c.trigger === 'clan' && c.clanLevel >= 5 },
  { id: 'boss_mvp', name: '토벌 MVP', desc: '월드 보스 기여도 1위', rarity: 'epic', title: '토벌 영웅', points: 700, check: (c) => c.trigger === 'boss' && c.bossTop === true },
  { id: 'rank_plat_season', name: '플래티넘 시즌', desc: '시즌을 플래티넘 이상으로 마감', rarity: 'epic', title: '플래티넘 시즌', points: 800, check: (c) => c.trigger === 'rankSeason' && ['platinum', 'diamond'].includes(c.rankTier) },
  { id: 'predict_10', name: '예언자', desc: '예측 10번 적중', rarity: 'epic', title: '카지노 예언자', points: 700, check: (c) => (c.profile.predict?.correct ?? 0) >= 10 },
  { id: 'rival_streak5', name: '압도', desc: '한 라이벌에게 5연승', rarity: 'epic', title: '천적', points: 600, check: (c) => c.trigger === 'rival' && (c.rivalStreak ?? 0) >= 5 },
  { id: 'daily_30', name: '한 달 개근', desc: '30일 연속 출석', rarity: 'epic', title: '성실의 아이콘', points: 600, check: (c) => c.trigger === 'daily' && c.dailyStreak >= 30 },

  // ───────── 🟡 전설 ─────────
  { id: 'streak_10', name: '멈추지 않는 자', desc: '10연승 달성', rarity: 'legendary', hidden: true, title: '전설의 연승', points: 800, check: (c) => c.profile.maxWinStreak >= 10 },
  { id: 'slot_jackpot', name: '슬롯의 전설', desc: '슬롯 잭팟 당첨 (7️⃣7️⃣7️⃣)', rarity: 'legendary', title: '슬롯의 전설', points: 1000, check: (c) => c.ev?.game === 'slot' && c.ev.detail?.jackpot > 0 },
  { id: 'crash_100x', name: '달까지', desc: '그래프 100배 이상에서 탈출', rarity: 'legendary', hidden: true, title: '문워커', points: 1000, check: (c) => c.ev?.game === 'crash' && c.ev.detail?.cashedAt >= 100 },
  { id: 'lucky_100x', name: '기적', desc: '한 판에서 건 금액의 100배 이상 받기', rarity: 'legendary', hidden: true, title: '기적의 사나이', points: 1000, check: (c) => c.ev && c.ev.staked > 0 && c.ev.payout >= c.ev.staked * 100 },
  { id: 'tourney_crown', name: '왕좌', desc: '사람 4명 이상 토너먼트 우승', rarity: 'legendary', title: '왕좌의 주인', points: 1200, check: (c) => c.ev?.game === 'tournament' && c.ev.detail?.place === 1 && c.ev.detail?.humans >= 4 },
  { id: 'clan_season', name: '시즌 최강 클랜', desc: '시즌 1위 클랜의 멤버 (3일 이상 소속)', rarity: 'legendary', title: '최강 클랜의 일원', points: 1500, check: (c) => c.trigger === 'clanSeason' },
  { id: 'collect_all', name: '박물관장', desc: '수집 세트 4개 완성', rarity: 'legendary', title: '박물관장', points: 2000, check: (c) => (c.profile.collectionSets?.length ?? 0) >= 4 },
  { id: 'rank_diamond', name: '다이아몬드 리그', desc: '랭크 다이아몬드 등급 달성', rarity: 'legendary', title: '다이아몬드', points: 2000, check: (c) => c.trigger === 'rank' && c.rankTier === 'diamond' },
  { id: 'season_top', name: '시즌 정상', desc: '시즌 랭킹 3위 이내 마감', rarity: 'legendary', title: '시즌 챔피언', points: 1200, check: (c) => c.trigger === 'season' && c.seasonRank <= 3 },
  { id: 'games_10000', name: '카지노의 주인', desc: '총 10,000판 플레이', rarity: 'legendary', title: '카지노의 주인', points: 2000, check: (c) => c.profile.totals.games >= 10000 },

  // ───────── 🔴 신화 ─────────
  { id: 'poker_royal', name: '로열 로드', desc: '로열 스트레이트 플러시로 승리', rarity: 'mythic', hidden: true, title: '로열 로드', points: 3000, check: (c) => won(c, 'poker') && c.ev.detail?.hand === '로열 스트레이트 플러시' },
  { id: 'streak_20', name: '불멸', desc: '20연승 달성', rarity: 'mythic', hidden: true, title: '불멸자', points: 3000, check: (c) => c.profile.maxWinStreak >= 20 },
  { id: 'crash_500x', name: '은하 너머', desc: '그래프 500배 이상에서 탈출', rarity: 'mythic', hidden: true, title: '은하수 여행자', points: 3000, check: (c) => c.ev?.game === 'crash' && c.ev.detail?.cashedAt >= 500 },
  { id: 'daily_100', name: '백일의 약속', desc: '100일 연속 출석', rarity: 'mythic', title: '백일의 약속', points: 3000, check: (c) => c.trigger === 'daily' && c.dailyStreak >= 100 },
  { id: 'collector', name: '살아있는 전설', desc: '다른 업적 35개 달성', rarity: 'mythic', title: '살아있는 전설', points: 5000, check: (c) => (c.profile.achievements?.length ?? 0) >= 35 },
];

const RARITY = Object.fromEntries(Object.entries(TIERS).map(([k, t]) => [k, t.emoji]));
const byId = Object.fromEntries(A.map((a) => [a.id, a]));
const tierOf = (a) => TIERS[a?.rarity] ?? TIERS.common;
/** 등급 장식이 붙은 이름 (영웅 이상은 특수기호) */
const display = (a) => tierOf(a).deco(a.name);
/** 칭호 → 그 칭호를 주는 업적 (프로필에서 칭호를 등급 색으로 꾸밀 때) */
const byTitle = Object.fromEntries(A.map((a) => [a.title, a]));

/** 보유 업적 id 목록 → 등급 높은 순, 같은 등급은 최근 순 */
function showcase(owned, n = 3) {
  const list = (owned || []).map((x, k) => ({ a: byId[x.id ?? x], k })).filter((x) => x.a);
  list.sort((x, y) => tierOf(y.a).rank - tierOf(x.a).rank || y.k - x.k);
  return list.slice(0, n).map((x) => x.a);
}

/** 등급별 보유 수 { mythic: {have, total}, ... } */
function tierCounts(owned) {
  const have = new Set((owned || []).map((x) => x.id ?? x));
  return Object.fromEntries(
    TIER_ORDER.map((t) => {
      const all = A.filter((a) => a.rarity === t);
      return [t, { have: all.filter((a) => have.has(a.id)).length, total: all.length }];
    }),
  );
}

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

module.exports = { ACHIEVEMENTS: A, TIERS, TIER_ORDER, RARITY, byId, byTitle, tierOf, display, showcase, tierCounts, evaluate };
