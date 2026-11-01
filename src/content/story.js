/**
 * 스토리 챌린지 (순수 로직).
 * 각 단계의 목표는 "기존 게임을 평소처럼 플레이한 정산 결과"로만 달성된다 → 별도 게임 로직·칩 차감 없음.
 * 실패해도 잃는 것은 없고 진행도는 그대로 남는다. 단계는 난이도가 점점 오른다.
 * 보상: 챕터 완료 칭호 + 보상 포인트, 최종 챕터 완료 시 한정 칭호·프로필 테두리.
 *
 * stage.match(ev) → 이 정산이 진행도를 얼마나 올리는지
 * chapter.availableFrom/Until (선택) → 기간 한정 챕터
 */
const won = (ev) => ev.net > 0;

const CHAPTERS = [
  {
    id: 'ch1',
    name: '1장 · 낯선 카지노',
    intro: '🎩 "어서 오세요, 신입. 이 카지노에선 실력이 곧 이름표죠. 기본부터 보여 주시겠어요?"',
    outro: '🎩 "나쁘지 않군요. 위층 VIP 라운지에 자리를 마련해 두죠."',
    reward: { title: '카지노 신입생', points: 200 },
    stages: [
      { id: 's1', text: '아무 게임 3판 플레이', goal: 3, match: () => 1 },
      { id: 's2', text: '아무 게임 2번 승리', goal: 2, match: (ev) => (won(ev) ? 1 : 0) },
      { id: 's3', text: '서로 다른 게임 3종 플레이', goal: 3, distinct: true, match: () => 1 },
    ],
  },
  {
    id: 'ch2',
    name: '2장 · VIP 라운지',
    intro: '🥂 "VIP 라운지의 딜러들은 만만치 않아요. 카드 감각을 증명해 보세요."',
    outro: '🥂 "딜러들이 당신 이름을 수군거리기 시작했어요."',
    reward: { title: 'VIP 손님', points: 300 },
    stages: [
      { id: 's1', text: '블랙잭 3번 승리', goal: 3, match: (ev) => (ev.game === 'blackjack' && won(ev) ? 1 : 0) },
      { id: 's2', text: '바카라 2번 적중', goal: 2, match: (ev) => (ev.game === 'baccarat' && won(ev) ? 1 : 0) },
      { id: 's3', text: '한 판에서 건 금액의 2배 이상 받기', goal: 1, match: (ev) => (ev.staked > 0 && ev.payout >= ev.staked * 2 ? 1 : 0) },
    ],
  },
  {
    id: 'ch3',
    name: '3장 · 하이롤러 테이블',
    intro: '🃏 "포커 테이블의 그림자, \'은빛 손\'이 당신을 지켜보고 있어요."',
    outro: '🃏 은빛 손: "…다음엔 토너먼트에서 보지."',
    reward: { title: '은빛 손의 라이벌', points: 400 },
    stages: [
      { id: 's1', text: '포커페이스 3핸드 플레이', goal: 3, match: (ev) => (ev.game === 'poker' ? 1 : 0) },
      { id: 's2', text: '포커에서 투페어 이상으로 승리', goal: 1, match: (ev) => (ev.game === 'poker' && won(ev) && ev.detail?.handCategory >= 2 ? 1 : 0) },
      { id: 's3', text: '그래프를 3.00x 이상에서 탈출', goal: 1, match: (ev) => (ev.game === 'crash' && ev.detail?.cashedAt >= 3 ? 1 : 0) },
    ],
  },
  {
    id: 'ch4',
    name: '4장 · 왕좌의 밤',
    intro: '👑 "오늘 밤, 이 카지노의 주인이 바뀔지도 모르겠군요."',
    outro: '👑 "카지노의 전설이 탄생했습니다. 이 테두리는 오직 당신만의 것."',
    reward: { title: '왕좌의 밤', points: 800, item: 'reward:frame:legend' },
    stages: [
      { id: 's1', text: '토너먼트 완주 1회', goal: 1, match: (ev) => (ev.game === 'tournament' ? 1 : 0) },
      { id: 's2', text: '토너먼트에서 사람 참가자 중 절반 이상 순위로 마치기', goal: 1, match: (ev) => (ev.game === 'tournament' && ev.detail?.humanPlace && ev.detail.humanPlace <= Math.ceil((ev.detail.humans ?? 1) / 2) ? 1 : 0) },
      { id: 's3', text: '아무 게임 5연승 (도중에 지면 처음부터)', goal: 5, streak: true, match: () => 1 },
    ],
  },
];

const byId = Object.fromEntries(CHAPTERS.map((c) => [c.id, c]));

/** 지금 도전할 수 있는 챕터인지 (기간 한정 챕터 지원) */
function available(ch, now = new Date()) {
  if (ch.availableFrom && now < new Date(ch.availableFrom)) return false;
  if (ch.availableUntil && now > new Date(ch.availableUntil)) return false;
  return true;
}

/** 다음 챕터 (앞 챕터를 모두 끝내야 열림) */
function nextChapter(completed = []) {
  return CHAPTERS.find((c) => !completed.includes(c.id) && available(c)) ?? null;
}

/**
 * 단계 진행 (순수). state = { stage: 인덱스, progress, games: [], streak }
 * @returns { state, stageDone, chapterDone }
 */
function advance(ch, state, ev) {
  const st = { stage: state?.stage ?? 0, progress: state?.progress ?? 0, games: [...(state?.games ?? [])], streak: state?.streak ?? 0 };
  const stage = ch.stages[st.stage];
  if (!stage) return { state: st, stageDone: false, chapterDone: true };
  if (stage.distinct) {
    if (!st.games.includes(ev.game)) st.games.push(ev.game);
    st.progress = st.games.length;
  } else if (stage.streak) {
    st.streak = won(ev) ? st.streak + 1 : ev.net < 0 ? 0 : st.streak;
    st.progress = st.streak;
  } else st.progress += stage.match(ev);
  let stageDone = false;
  if (st.progress >= stage.goal) {
    stageDone = true;
    st.stage += 1;
    st.progress = 0;
    st.games = [];
    st.streak = 0;
  }
  return { state: st, stageDone, chapterDone: st.stage >= ch.stages.length };
}

module.exports = { CHAPTERS, byId, available, nextChapter, advance };
