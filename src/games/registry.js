/**
 * 게임 레지스트리 (플러그인형 구조의 중심).
 * 새 게임은 여기에 메타데이터를 등록하고 src/commands/에 명령어 파일을 두면
 * 관리자 활성/비활성, 베팅 한도, 통계(설계 RTP 대비 실제 RTP), 리플레이가 자동으로 연동된다.
 *
 * designRTP(detail): 그 판의 베팅 종류에 따른 이론 환수율. null이면 전략·상대 의존(비교 제외).
 */
const config = require('../config');
const { theoreticalRTP } = require('../engine/slot');

const SLOT_RTP = theoreticalRTP(config.SLOT.SYMBOLS, config.SLOT.PAYTABLE);
const DICE_P = { lo: 15 / 36, seven: 6 / 36, hi: 15 / 36 };
const BACCARAT_RTP = { player: 0.9876, banker: 0.9894, tie: 0.8564 }; // 8덱 표준값 (배당 기본값 기준)

const GAMES = {
  blackjack: { label: '블랙잭', emoji: '🃏', command: '블랙잭', designRTP: () => null },
  baccarat: { label: '바카라', emoji: '🎴', command: '바카라', designRTP: (d) => BACCARAT_RTP[d?.side] ?? null },
  slot: { label: '슬롯', emoji: '🎰', command: '슬롯', designRTP: () => SLOT_RTP },
  crash: { label: '그래프', emoji: '📈', command: '그래프', designRTP: () => 1 - config.CRASH.HOUSE_EDGE },
  dice: {
    label: '주사위',
    emoji: '🎲',
    command: '주사위',
    designRTP: (d) => (d?.choice ? DICE_P[d.choice] * config.DICE.PAYOUT[d.choice] : null),
  },
  poker: { label: '포커페이스', emoji: '🎭', command: '포커페이스', designRTP: () => null },
  tournament: { label: '토너먼트', emoji: '🏆', command: '토너먼트', designRTP: () => null },
  // 메타 항목: 게임이 아니라 관전자 예측 정산 (전적·미션·연승·클랜·스토리·랭크에는 넣지 않음)
  prediction: { label: '예측', emoji: '🔮', command: null, meta: true, designRTP: () => null },
};

const ids = () => Object.keys(GAMES).filter((id) => !GAMES[id].meta);
/** 게임이 아닌 정산 항목 (예측 등) */
const isMeta = (id) => !!GAMES[id]?.meta;
const label = (id) => (GAMES[id] ? `${GAMES[id].emoji} ${GAMES[id].label}` : id);
const byCommand = (name) => Object.entries(GAMES).find(([, g]) => g.command === name)?.[0] ?? null;

module.exports = { GAMES, ids, isMeta, label, byCommand, SLOT_RTP };
