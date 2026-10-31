/**
 * 게임 밸런스 & 시스템 상수 모음.
 * 수치를 바꿀 때는 `npm test`로 RTP(환수율) 검증 테스트를 함께 돌려 보세요.
 *
 * PAYOUT 값은 모두 "원금 포함 총 지급 배수"입니다. (2 = 1:1 배당)
 * RTP 정의(이 프로젝트 전체 공통): 총 지급액(원금 포함) ÷ 총 베팅액(더블·스플릿·보험 포함)
 */
const env = process.env;

module.exports = {
  START_MONEY: 10_000,
  MIN_BET: 100,
  MAX_BET: 1_000_000,
  TIMEZONE: 'Asia/Seoul', // 출석·미션·시즌의 날짜 기준
  SESSION_IDLE_MS: 60_000,
  SESSION_HARD_LIMIT_MS: 14 * 60_000,

  ECONOMY: {
    // 'guild' = 서버마다 독립 지갑 / 'global' = 모든 서버에서 하나의 지갑
    SCOPE: env.ECONOMY_SCOPE === 'global' ? 'global' : 'guild',
    ESCROW_TTL_MS: 20 * 60_000, // 이 시간 넘게 결과가 없는 판은 환불
    ESCROW_TTL_BY_GAME: { tournament: 3 * 60 * 60_000, poker: 60 * 60_000 }, // 오래 걸리는 게임은 따로
    ESCROW_SWEEP_MS: 60_000,
    // 단일 인스턴스 운영 전제: 부팅 시 이전 프로세스의 판을 즉시 복구 (결과 확정 → 정산, 미확정 → 환불)
    RECOVER_ON_BOOT: env.RECOVER_ON_BOOT !== 'false',
    LOG_RETENTION_DAYS: 90,
  },

  RATE_LIMIT: { WINDOW_MS: 5_000, MAX_ACTIONS: 10 }, // 유저당 5초에 10회

  ADMIN: {
    OWNER_IDS: (env.BOT_OWNER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    MAX_ADJUST: 100_000_000,
  },

  ALERTS: { WEBHOOK_URL: env.ALERT_WEBHOOK_URL || '', THROTTLE_MS: 60_000 },
  DASHBOARD: { TOKEN: env.DASHBOARD_TOKEN || '' },

  BAILOUT: { AMOUNT: 5_000, THRESHOLD: 1_000, COOLDOWN_MS: 24 * 60 * 60 * 1000 },

  DAILY: {
    CHIPS: 2_000,
    STREAK_BONUS: 200, // 연속 출석 1일당 추가 칩
    MAX_STREAK_BONUS: 2_000,
    POINTS: 10, // 보상 포인트
  },

  MISSIONS: { DAILY_COUNT: 3, WEEKLY_COUNT: 2 },

  SEASON: { DAYS: 30, TOP_TITLES: 3 },

  JACKPOT: { SEED: 100_000, CONTRIBUTION: 0.01 }, // 슬롯 베팅의 1%가 잭팟 풀로 (하우스 부담)

  BLACKJACK: {
    DECKS: 6,
    RESHUFFLE_AT: 60,
    BET_OPTIONS: [1_000, 5_000, 10_000, 50_000],
    BLACKJACK_PAYS: 1.5,
    DEALER_HITS_SOFT_17: false,
    DEALER_STEP_MS: 700,
    MAX_PLAYERS: 5,
    MAX_HANDS_PER_PLAYER: 4, // 스플릿 최대 3회
    DOUBLE_AFTER_SPLIT: true,
    INSURANCE_MS: 12_000,
    LOBBY_MS: 60_000,
    BET_MS: 20_000,
    TURN_MS: 30_000,
    IDLE_ROUNDS_TO_CLOSE: 2,
  },

  SLOT: {
    REEL_DELAY_MS: 400,
    AUTO_SPIN_OPTIONS: [5, 10, 25],
    AUTO_SPIN_GAP_MS: 700,
    SYMBOLS: [
      { emoji: '🍒', weight: 40 },
      { emoji: '🍋', weight: 30 },
      { emoji: '🔔', weight: 20 },
      { emoji: '💎', weight: 8 },
      { emoji: '7️⃣', weight: 2 },
    ],
    PAYTABLE: {
      triple: { '🍒': 3, '🍋': 8, '🔔': 15, '💎': 100, '7️⃣': 777 },
      twoCherry: 1.25,
    }, // 이론 RTP ≈ 94.5% (+ 잭팟 풀 기여 약 1%)
    JACKPOT_SYMBOL: '7️⃣',
  },

  CRASH: {
    HOUSE_EDGE: 0.03,
    GROWTH_PER_MS: 0.0001,
    TICK_MS: 200,
    MAX_MULTIPLIER: 1000,
    GRAPH_POINTS: 24,
    GRAPH_HEIGHT: 6,
    RECENT_HISTORY: 15,
  },

  DICE: {
    PAYOUT: { lo: 2, seven: 5, hi: 2 },
    FRAME_MS: 300,
    ROLL_FRAMES: 2,
    ASSIST: { ENABLED: true, STREAK: 4, REROLL_CHANCE: 0.15, SHOW_TO_USER: true },
  },

  POKER: {
    // 현금 테이블: /포커페이스 금액 = 바이인(스택). 노리밋, 올인·사이드팟 지원
    BB_PER_BUYIN: 50, // 빅블라인드 = 바이인 / 50 (50BB 딥)
    MAX_BOTS: 5,
    MAX_HUMANS: 6,
    MAX_SEATS: 8,
    SIMULATIONS: 250,
    LOBBY_MS: 120_000,
    TURN_MS: 45_000,
    BOT_THINK_MS: 1_100,
    STREET_PAUSE_MS: 900,
    REVEAL_FOLDED_BOTS: true,
    BOT_NAMES: ['알파', '브라보', '찰리', '델타', '에코', '폭스', '골프'],
  },

  TOURNAMENT: {
    START_STACK: 1_500, // 토너먼트 칩 (카지노 칩과 별개)
    START_BB: 20,
    BLIND_GROWTH: 1.5, // 레벨마다 블라인드 1.5배
    HANDS_PER_LEVEL: 6,
    MAX_HANDS: 80, // 초과 시 칩 순위로 종료
    MAX_SEATS: 8,
    MAX_BOTS: 6,
    LOBBY_MS: 180_000,
    TURN_MS: 40_000,
    HAND_PAUSE_MS: 2_500,
    RAKE: 0, // 참가비 중 운영 수수료 비율 (0 = 전액 상금)
    // 사람 참가자 수별 상금 비율 (사람 참가자 순위 기준)
    PAYOUTS: [
      { minHumans: 1, split: [1] },
      { minHumans: 3, split: [0.65, 0.35] },
      { minHumans: 5, split: [0.5, 0.3, 0.2] },
    ],
  },

  BACCARAT: {
    DECKS: 8,
    RESHUFFLE_AT: 52,
    PAYOUT: { player: 2, banker: 1.95, tie: 9 },
    HISTORY_SIZE: 5,
    DEAL_MS: 500,
    BET_OPTIONS: [1_000, 5_000, 10_000, 50_000],
    MAX_PLAYERS: 6,
    LOBBY_MS: 60_000,
    BET_MS: 20_000,
    IDLE_ROUNDS_TO_CLOSE: 2,
  },
};
