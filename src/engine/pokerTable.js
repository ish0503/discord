/**
 * 다자간 홀덤 테이블 상태 머신 (UI·타이밍·DB와 무관한 순수 로직).
 *
 * 룰 요약
 * - 전원 앤티 → 홀카드 2장 → 플롭 3장 공개 후 첫 베팅
 * - 고정 리밋: 플롭·턴 1단위(앤티), 리버 2단위. 스트리트당 베팅+레이즈 최대 maxBetsPerStreet회
 * - 참가 시 maxExposure(앤티 배수) 이상의 잔고를 요구 → 올인·사이드팟이 발생하지 않음
 * - 쇼다운 동점은 팟을 균등 분할, 나머지 칩은 버튼 다음 좌석부터 1칩씩
 */
const { evaluate, STREETS } = require('./poker');

class PokerTable {
  constructor({ ante, maxBetsPerStreet = 3, riverMultiplier = 2 }) {
    this.ante = ante;
    this.maxBets = maxBetsPerStreet;
    this.riverMultiplier = riverMultiplier;
    this.seats = [];
    this.finished = false;
    this.results = null;
  }

  /** 한 판에서 한 좌석이 잃을 수 있는 최대 금액 (앤티 배수) */
  static maxExposure(maxBets = 3, riverMultiplier = 2) {
    return 1 + maxBets * (2 + riverMultiplier);
  }

  addSeat(seat) {
    this.seats.push({ ...seat, hole: [], folded: false, totalIn: 0, streetIn: 0 });
    return this.seats.length - 1;
  }

  get pot() {
    return this.seats.reduce((s, x) => s + x.totalIn, 0);
  }

  get street() {
    return STREETS[this.revealed];
  }

  get unit() {
    return this.revealed === 5 ? this.ante * this.riverMultiplier : this.ante;
  }

  get visibleBoard() {
    return this.board.slice(0, this.revealed);
  }

  /** 지금 행동할 좌석 인덱스 */
  get actor() {
    return this.finished ? null : this.pending[0] ?? null;
  }

  get activeIndexes() {
    return this.seats.map((s, i) => (s.folded ? -1 : i)).filter((i) => i >= 0);
  }

  /** from 다음 좌석부터 한 바퀴, 폴드하지 않은 좌석 (from 자신은 제외) */
  orderAfter(from) {
    const n = this.seats.length;
    const out = [];
    for (let k = 1; k <= n; k++) {
      const i = (from + k) % n;
      if (i !== from && !this.seats[i].folded) out.push(i);
    }
    return out;
  }

  /** deck: 셔플된 카드 배열 (pop으로 사용) */
  start(deck, button = 0) {
    if (this.seats.length < 2) throw new Error('최소 2좌석이 필요합니다.');
    this.button = button % this.seats.length;
    for (const s of this.seats) {
      s.hole = [deck.pop(), deck.pop()];
      s.totalIn = this.ante;
    }
    this.board = [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()];
    this.revealed = 3;
    this.#startStreet();
  }

  #startStreet() {
    this.currentBet = 0;
    this.betsThisStreet = 0;
    for (const s of this.seats) s.streetIn = 0;
    const first = this.orderAfter(this.button);
    // 버튼 자신이 액티브면 마지막 순서로
    this.pending = this.seats[this.button].folded ? first : [...first, this.button];
  }

  legal(idx) {
    const s = this.seats[idx];
    const toCall = this.currentBet - s.streetIn;
    const canRaise = this.betsThisStreet < this.maxBets;
    return { toCall, canRaise, raiseCost: toCall + this.unit, isOpen: this.currentBet === 0 };
  }

  #pay(s, amount) {
    s.streetIn += amount;
    s.totalIn += amount;
  }

  /**
   * @param action 'fold' | 'check' | 'call' | 'raise' (raise는 오픈 베팅 포함)
   * @returns { type: 'continue'|'street'|'end', action, amount, ... }
   */
  act(idx, action) {
    if (this.finished) throw new Error('이미 끝난 게임입니다.');
    if (idx !== this.actor) throw new Error('행동 순서가 아닙니다.');
    const s = this.seats[idx];
    const { toCall, canRaise, isOpen } = this.legal(idx);
    let done;
    let amount = 0;

    if (action === 'fold') {
      s.folded = true;
      this.pending.shift();
      done = 'fold';
      if (this.activeIndexes.length === 1) return { ...this.#finish('fold'), action: done, amount };
    } else if (action === 'raise' && canRaise) {
      this.currentBet += this.unit;
      this.betsThisStreet += 1;
      amount = this.currentBet - s.streetIn;
      this.#pay(s, amount);
      this.pending = this.orderAfter(idx);
      done = isOpen ? 'bet' : 'raise';
    } else {
      amount = toCall;
      this.#pay(s, amount);
      this.pending.shift();
      done = toCall > 0 ? 'call' : 'check';
    }

    if (this.pending.length === 0) {
      if (this.revealed === 5) return { ...this.#finish('showdown'), action: done, amount };
      this.revealed += 1;
      this.#startStreet();
      return { type: 'street', street: this.street, action: done, amount };
    }
    return { type: 'continue', action: done, amount };
  }

  #finish(reason) {
    this.finished = true;
    this.pending = [];
    const hands = this.seats.map((s) => evaluate([...s.hole, ...this.board]));
    const active = this.activeIndexes;

    let winners;
    if (reason === 'fold') {
      winners = active;
    } else {
      const best = Math.max(...active.map((i) => hands[i].score));
      winners = active.filter((i) => hands[i].score === best);
    }

    const pot = this.pot;
    const won = new Array(this.seats.length).fill(0);
    const share = Math.floor(pot / winners.length);
    winners.forEach((i) => (won[i] = share));
    let remainder = pot - share * winners.length;
    for (const i of [...this.orderAfter(this.button), this.button]) {
      if (remainder <= 0) break;
      if (winners.includes(i)) {
        won[i] += 1;
        remainder -= 1;
      }
    }

    this.results = this.seats.map((s, i) => ({
      won: won[i],
      net: won[i] - s.totalIn,
      hand: hands[i],
      winner: winners.includes(i),
    }));
    return { type: 'end', reason, winners };
  }
}

module.exports = { PokerTable };
