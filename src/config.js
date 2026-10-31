/**
 * 게임 밸런스 & 시스템 상수 모음.
 * 수치를 바꿀 때는 `npm test`로 RTP(환수율) 검증 테스트를 함께 돌려 보세요.
 *
 * PAYOUT 값은 모두 "원금 포함 총 지급 배수"입니다. (2 = 1:1 배당)
 */
module.exports = {
  START_MONEY: 10_000,
  MIN_BET: 100,
  MAX_BET: 1_000_000,
  SESSION_IDLE_MS: 60_000, // 버튼 무반응 시 자동 처리까지의 시간
  SESSION_HARD_LIMIT_MS: 14 * 60_000, // 인터랙션 토큰(15분) 만료 전 강제 종료 (테이블 참가 마커는 제외)

  ECONOMY: {
    // 에스크로(게임에 묶인 칩)가 이 시간 넘게 정산되지 않으면 자동 환불 (서버 다운·크래시 복구)
    ESCROW_TTL_MS: 20 * 60_000,
    ESCROW_SWEEP_MS: 60_000,
    LOG_RETENTION_DAYS: 90, // GameLog 자동 삭제 (TTL 인덱스)
  },

  BAILOUT: {
    AMOUNT: 5_000,
    THRESHOLD: 1_000, // 잔고가 이 값 미만일 때만 신청 가능
    COOLDOWN_MS: 24 * 60 * 60 * 1000,
  },

  BLACKJACK: {
    DECKS: 6, // 312장
    RESHUFFLE_AT: 60, // 남은 카드가 이 값 이하이면 다음 판 시작 전에 재셔플
    BET_OPTIONS: [1_000, 5_000, 10_000, 50_000],
    BLACKJACK_PAYS: 1.5, // 3:2
    DEALER_HITS_SOFT_17: false, // false = S17 (소프트 17 스탠드)
    DEALER_STEP_MS: 700,
    MAX_PLAYERS: 5,
    LOBBY_MS: 60_000, // 모집 시간 (끝나면 첫 베팅 라운드 자동 시작)
    BET_MS: 20_000, // 베팅 시간 (전원 베팅 시 즉시 딜)
    TURN_MS: 30_000, // 플레이어 차례 제한 (초과 시 자동 스탠드)
    IDLE_ROUNDS_TO_CLOSE: 2, // 연속으로 아무도 베팅하지 않으면 테이블 종료
  },

  SLOT: {
    REEL_DELAY_MS: 400,
    // 사양서: 🍒40 🍋30 💎8 7️⃣2 = 80% → 나머지 20%를 🔔로 채움
    SYMBOLS: [
      { emoji: '🍒', weight: 40 },
      { emoji: '🍋', weight: 30 },
      { emoji: '🔔', weight: 20 },
      { emoji: '💎', weight: 8 },
      { emoji: '7️⃣', weight: 2 },
    ],
    PAYTABLE: {
      triple: { '🍒': 3, '🍋': 8, '🔔': 15, '💎': 100, '7️⃣': 777 },
      twoCherry: 1.25, // 아무 위치든 🍒 정확히 2개
    }, // 이론 RTP ≈ 94.5%
  },

  CRASH: {
    HOUSE_EDGE: 0.03,
    GROWTH_PER_MS: 0.0001, // m(t) = e^(k·t) → 2배 ≈ 6.9초, 10배 ≈ 23초
    TICK_MS: 200, // 화면 갱신 시도 주기 (실제 편집은 in-flight 가드로 자동 스로틀링)
    MAX_MULTIPLIER: 1000,
    GRAPH_POINTS: 24,
    GRAPH_HEIGHT: 6,
  },

  DICE: {
    PAYOUT: { lo: 2, seven: 5, hi: 2 }, // 이론 RTP: Hi/Lo 83.3%, 7 83.3%
    FRAME_MS: 300,
    ROLL_FRAMES: 2,
    ASSIST: {
      ENABLED: true,
      STREAK: 4, // 이 횟수 이상 연패 중일 때
      REROLL_CHANCE: 0.15, // 패배 결과를 1회 재굴림할 확률 (승률 약 +3.6%p)
      SHOW_TO_USER: true, // 보정 활성 상태와 보정 후 확률을 화면에 공개 (false면 내부 처리)
    },
  },

  POKER: {
    MAX_BOTS: 5,
    MAX_HUMANS: 6, // 호스트 포함
    MAX_SEATS: 8, // 봇 + 사람 합계 상한
    MAX_BETS_PER_STREET: 3, // 베팅 1 + 레이즈 2
    RIVER_MULTIPLIER: 2, // 리버 베팅 단위 = 앤티 × 2
    // 최대 손실 = 앤티 × (1 + 3 × (1 + 1 + 2)) = 앤티 × 13 → 참가 시 이만큼 잔고 필요
    SIMULATIONS: 300, // 봇 몬테카를로 반복 횟수
    LOBBY_MS: 120_000, // 모집 시간 (끝나면 2좌석 이상일 때 자동 시작)
    TURN_MS: 45_000, // 사람 차례 제한 시간 (초과 시 체크 가능하면 체크, 아니면 다이)
    BOT_THINK_MS: 1_100,
    STREET_PAUSE_MS: 900,
    REVEAL_FOLDED_BOTS: true, // 종료 후 폴드한 봇의 패도 공개 (판독 학습용)
    BOT_NAMES: ['알파', '브라보', '찰리', '델타', '에코'],
  },

  BACCARAT: {
    DECKS: 8,
    RESHUFFLE_AT: 52,
    PAYOUT: { player: 2, banker: 1.95, tie: 9 }, // 뱅커 5% 커미션, 타이 8:1
    HISTORY_SIZE: 5,
    DEAL_MS: 500,
    BET_OPTIONS: [1_000, 5_000, 10_000, 50_000],
    MAX_PLAYERS: 6,
    LOBBY_MS: 60_000,
    BET_MS: 20_000,
    IDLE_ROUNDS_TO_CLOSE: 2,
  },
};
