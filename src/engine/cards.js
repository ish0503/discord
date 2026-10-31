const { shuffle } = require('../utils/rng');

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function createDecks(count = 1) {
  const cards = [];
  for (let d = 0; d < count; d++) {
    for (const suit of SUITS) for (const rank of RANKS) cards.push({ rank, suit });
  }
  return cards;
}

/** 하이-로우 카운팅 값: 2~6 = +1, 7~9 = 0, 10·J·Q·K·A = -1 */
function hiLoValue(card) {
  if (['2', '3', '4', '5', '6'].includes(card.rank)) return 1;
  if (['7', '8', '9'].includes(card.rank)) return 0;
  return -1;
}

/**
 * 멀티 덱 딜링 슈.
 * - draw() 시 배열 끝에서 pop
 * - 러닝 카운트는 "공개된" 카드만 반영 (딜러 홀카드는 공개 시점에 count())
 * - 재셔플은 라운드 시작 전 prepareRound()에서만 수행 (실제 컷 카드 방식)
 */
class Shoe {
  constructor({ decks, reshuffleAt }) {
    this.decks = decks;
    this.reshuffleAt = reshuffleAt;
    this.shoeNumber = 0;
    this.history = []; // 바카라 등에서 쓰는 이번 슈의 결과 기록
    this.shuffle();
  }

  get total() {
    return this.decks * 52;
  }

  get remaining() {
    return this.cards.length;
  }

  get decksRemaining() {
    return this.remaining / 52;
  }

  /** True Count = Running Count / (남은 카드 / 52) */
  get trueCount() {
    return this.decksRemaining > 0 ? this.runningCount / this.decksRemaining : 0;
  }

  shuffle() {
    this.cards = shuffle(createDecks(this.decks));
    this.runningCount = 0;
    this.history = [];
    this.shoeNumber += 1;
  }

  /** 라운드 시작 전 호출. 재셔플했다면 true */
  prepareRound() {
    if (this.remaining <= this.reshuffleAt) {
      this.shuffle();
      return true;
    }
    return false;
  }

  draw({ counted = true } = {}) {
    if (this.cards.length === 0) this.shuffle(); // 안전장치 (정상 흐름에선 발생하지 않음)
    const card = this.cards.pop();
    if (counted) this.count(card);
    return card;
  }

  count(card) {
    this.runningCount += hiLoValue(card);
  }
}

module.exports = { SUITS, RANKS, createDecks, hiLoValue, Shoe };
