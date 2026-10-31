/**
 * 미션 정의 & 선택 (순수 로직).
 * 같은 날짜(주)에는 모든 유저가 같은 미션을 받는다 (날짜 키 해시로 결정).
 * 보상은 칩이 아닌 보상 포인트 → 게임 경제 인플레이션 없음.
 */
const crypto = require('node:crypto');

const POOL = {
  daily: [
    { id: 'd_bj5', text: '블랙잭 5판 플레이', game: 'blackjack', metric: 'plays', goal: 5, points: 100 },
    { id: 'd_slot10', text: '슬롯 10회 스핀', game: 'slot', metric: 'plays', goal: 10, points: 100 },
    { id: 'd_dice8', text: '주사위 8회 굴리기', game: 'dice', metric: 'plays', goal: 8, points: 90 },
    { id: 'd_crash5', text: '그래프 5판 플레이', game: 'crash', metric: 'plays', goal: 5, points: 100 },
    { id: 'd_bac5', text: '바카라 5판 플레이', game: 'baccarat', metric: 'plays', goal: 5, points: 100 },
    { id: 'd_poker3', text: '포커페이스 3판 플레이', game: 'poker', metric: 'plays', goal: 3, points: 150 },
    { id: 'd_any15', text: '아무 게임 15판 플레이', metric: 'plays', goal: 15, points: 120 },
    { id: 'd_win5', text: '아무 게임 5번 승리', metric: 'wins', goal: 5, points: 130 },
    { id: 'd_wager20k', text: '하루 누적 20,000칩 베팅', metric: 'wagered', goal: 20_000, points: 150 },
  ],
  weekly: [
    { id: 'w_any100', text: '이번 주 100판 플레이', metric: 'plays', goal: 100, points: 600 },
    { id: 'w_win40', text: '이번 주 40번 승리', metric: 'wins', goal: 40, points: 600 },
    { id: 'w_poker15', text: '포커페이스 15판 플레이', game: 'poker', metric: 'plays', goal: 15, points: 700 },
    { id: 'w_bj30', text: '블랙잭 30판 플레이', game: 'blackjack', metric: 'plays', goal: 30, points: 500 },
    { id: 'w_wager300k', text: '이번 주 누적 300,000칩 베팅', metric: 'wagered', goal: 300_000, points: 700 },
    { id: 'w_tourney1', text: '토너먼트 1회 참가', game: 'tournament', metric: 'plays', goal: 1, points: 500 },
  ],
};

/** 날짜 키로 결정되는 미션 선택 (해시 정렬 후 앞에서 n개) */
function select(kind, periodKey, count) {
  return [...POOL[kind]]
    .map((m) => ({ m, h: crypto.createHash('sha256').update(`${periodKey}:${m.id}`).digest('hex') }))
    .sort((a, b) => (a.h < b.h ? -1 : 1))
    .slice(0, count)
    .map((x) => x.m);
}

/** 정산 이벤트가 이 미션 진행도를 얼마나 올리는지 */
function increment(mission, ev) {
  if (mission.game && mission.game !== ev.game) return 0;
  if (mission.metric === 'plays') return 1;
  if (mission.metric === 'wins') return ev.net > 0 ? 1 : 0;
  if (mission.metric === 'wagered') return ev.staked;
  return 0;
}

module.exports = { POOL, select, increment };
