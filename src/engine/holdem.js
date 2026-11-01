/**
 * 노리밋 텍사스 홀덤 한 핸드 (순수 로직).
 *
 * - 스택·블라인드·앤티, 프리플랍 → 플롭 → 턴 → 리버
 * - 올인, 사이드팟, 언콜드 벳 반환
 * - 최소 레이즈 규칙: 레이즈는 직전 레이즈 크기 이상. 그보다 작은 올인 레이즈는
 *   이미 행동한 플레이어에게 재레이즈 권한을 다시 열어 주지 않는다 (콜/폴드만)
 * - 헤즈업: 버튼이 스몰 블라인드, 프리플랍 선행동 / 포스트플랍 후행동
 */
const { evaluate } = require('./poker');

const STREET_NAMES = ['프리플랍', '플롭', '턴', '리버'];
const REVEAL_BY_STREET = [0, 3, 4, 5];

class HoldemHand {
  /**
   * @param seats [{ id, name, stack, ... }] — 스택 > 0 인 좌석만
   * @param opts { button, sb, bb, ante }
   */
  constructor(seats, { button = 0, sb, bb, ante = 0 }) {
    if (seats.length < 2) throw new Error('최소 2좌석이 필요합니다.');
    this.seats = seats.map((s) => ({ ...s, hole: [], folded: false, allIn: false, totalIn: 0, streetIn: 0, acted: false, mayRaise: true }));
    this.button = button % seats.length;
    this.sb = sb;
    this.bb = bb;
    this.ante = ante;
    this.street = 0;
    this.finished = false;
    this.results = null;
    this.log = [];
  }

  get n() {
    return this.seats.length;
  }

  get streetName() {
    return STREET_NAMES[this.street];
  }

  get revealed() {
    return this.finished && this.endReason === 'showdown' ? 5 : REVEAL_BY_STREET[this.street];
  }

  get visibleBoard() {
    return this.board.slice(0, this.revealed);
  }

  get pot() {
    return this.seats.reduce((s, x) => s + x.totalIn, 0);
  }

  get actor() {
    return this.finished ? null : this.pending[0] ?? null;
  }

  get liveIndexes() {
    return this.seats.map((s, i) => (s.folded ? -1 : i)).filter((i) => i >= 0);
  }

  /** from 다음부터 한 바퀴 (from 제외), 조건을 만족하는 좌석 */
  orderAfter(from, pred = (s) => !s.folded && !s.allIn) {
    const out = [];
    for (let k = 1; k <= this.n; k++) {
      const i = (from + k) % this.n;
      if (i !== from && pred(this.seats[i])) out.push(i);
    }
    return out;
  }

  #pay(s, amount) {
    const a = Math.min(amount, s.stack);
    s.stack -= a;
    s.streetIn += a;
    s.totalIn += a;
    if (s.stack === 0) s.allIn = true;
    return a;
  }

  start(deck) {
    for (const s of this.seats) s.hole = [deck.pop(), deck.pop()];
    this.board = [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()];

    if (this.ante > 0) {
      for (const s of this.seats) {
        const a = Math.min(this.ante, s.stack);
        s.stack -= a;
        s.totalIn += a; // 앤티는 데드 머니 (스트리트 베팅액에 포함하지 않음)
        if (s.stack === 0) s.allIn = true;
      }
    }

    const headsUp = this.n === 2;
    this.sbIndex = headsUp ? this.button : (this.button + 1) % this.n;
    this.bbIndex = headsUp ? (this.button + 1) % this.n : (this.button + 2) % this.n;
    this.#pay(this.seats[this.sbIndex], this.sb);
    this.#pay(this.seats[this.bbIndex], this.bb);
    this.currentBet = Math.max(this.seats[this.sbIndex].streetIn, this.seats[this.bbIndex].streetIn);
    this.minRaise = this.bb;
    this.pending = this.orderAfter(this.bbIndex).concat(
      [this.bbIndex].filter((i) => !this.seats[i].allIn && !this.orderAfter(this.bbIndex).includes(i)),
    );
    this.pending = [...new Set(this.pending)];
    this.#checkRoundEnd();
  }

  #startStreet() {
    this.street += 1;
    this.currentBet = 0;
    this.minRaise = this.bb;
    for (const s of this.seats) {
      s.streetIn = 0;
      s.acted = false;
      s.mayRaise = true;
    }
    const first = this.orderAfter(this.button);
    if (!this.seats[this.button].folded && !this.seats[this.button].allIn) first.push(this.button);
    this.pending = first;
  }

  /** 현재 행동자가 할 수 있는 것 */
  legal(idx = this.actor) {
    const s = this.seats[idx];
    const toCall = Math.min(this.currentBet - s.streetIn, s.stack);
    const maxTo = s.streetIn + s.stack;
    const minTo = Math.min(this.currentBet + this.minRaise, maxTo);
    const canRaise = s.mayRaise && maxTo > this.currentBet;
    return { toCall, canCheck: toCall === 0, minTo, maxTo, canRaise, isOpen: this.currentBet === 0, pot: this.pot, stack: s.stack };
  }

  /**
   * @param action { type: 'fold'|'check'|'call'|'raise'|'allin', to?: 레이즈 후 총 스트리트 베팅액 }
   * @returns { type: 'continue'|'street'|'end', ... }
   */
  act(idx, action) {
    if (this.finished) throw new Error('이미 끝난 핸드입니다.');
    if (idx !== this.actor) throw new Error('행동 순서가 아닙니다.');
    const s = this.seats[idx];
    const lg = this.legal(idx);
    let type = action.type;
    let paid = 0;

    if (type === 'allin') type = lg.maxTo > this.currentBet && lg.canRaise ? 'raise' : 'call';
    if (type === 'check' && lg.toCall > 0) type = 'call';
    if (type === 'raise' && !lg.canRaise) type = 'call';

    if (type === 'fold') {
      s.folded = true;
      this.pending.shift();
    } else if (type === 'check' || type === 'call') {
      paid = this.#pay(s, lg.toCall);
      s.acted = true;
      this.pending.shift();
      type = paid > 0 ? (s.allIn ? 'allin-call' : 'call') : 'check';
    } else if (type === 'raise') {
      const want = action.type === 'allin' ? lg.maxTo : action.to ?? lg.minTo;
      const to = Math.max(Math.min(want, lg.maxTo), Math.min(lg.minTo, lg.maxTo));
      const raiseSize = to - this.currentBet;
      paid = this.#pay(s, to - s.streetIn);
      const full = raiseSize >= this.minRaise;
      if (full) this.minRaise = raiseSize;
      this.currentBet = Math.max(this.currentBet, s.streetIn);
      s.acted = true;
      for (const o of this.seats) {
        if (o === s || o.folded || o.allIn) continue;
        if (full) {
          o.acted = false;
          o.mayRaise = true;
        } else if (o.acted) {
          o.mayRaise = false; // 짧은 올인 레이즈는 액션을 다시 열지 않음
        }
      }
      this.pending = this.orderAfter(idx).filter((i) => this.seats[i].streetIn < this.currentBet || !this.seats[i].acted);
      type = s.allIn ? 'allin' : lg.isOpen ? 'bet' : 'raise';
    }

    this.log.push({ street: this.streetName, seat: idx, type, amount: paid, to: s.streetIn });
    const ev = this.#checkRoundEnd();
    return { ...ev, action: type, amount: paid };
  }

  #checkRoundEnd() {
    const live = this.liveIndexes;
    if (live.length === 1) return this.#finish('fold');
    if (this.pending.length > 0) return { type: 'continue' };

    // 베팅 라운드 종료. 더 행동할 수 있는 사람이 1명 이하면 남은 보드를 모두 깐다 (런아웃)
    const canAct = live.filter((i) => !this.seats[i].allIn);
    if (this.street === 3 || canAct.length <= 1) {
      this.street = 3;
      return this.#finish('showdown');
    }
    this.#startStreet();
    if (this.pending.length === 0) return this.#checkRoundEnd();
    return { type: 'street', street: this.streetName };
  }

  /** 사이드팟 계산: [{ amount, eligible: [seatIdx] }] */
  static buildPots(seats) {
    const remaining = seats.map((s) => s.totalIn);
    const pots = [];
    for (;;) {
      const contenders = seats.map((s, i) => i).filter((i) => !seats[i].folded && remaining[i] > 0);
      if (!contenders.length) {
        const rest = remaining.reduce((a, b) => a + b, 0);
        if (rest > 0 && pots.length) pots[pots.length - 1].amount += rest;
        break;
      }
      const level = Math.min(...contenders.map((i) => remaining[i]));
      let amount = 0;
      for (let i = 0; i < seats.length; i++) {
        const take = Math.min(remaining[i], level);
        remaining[i] -= take;
        amount += take;
      }
      const last = pots[pots.length - 1];
      if (last && last.eligible.length === contenders.length && last.eligible.every((x) => contenders.includes(x))) last.amount += amount;
      else pots.push({ amount, eligible: contenders });
    }
    return pots;
  }

  #finish(reason) {
    this.finished = true;
    this.endReason = reason;
    this.pending = [];
    const hands = this.seats.map((s) => (this.board ? evaluate([...s.hole, ...this.board]) : null));
    const won = new Array(this.n).fill(0);
    const pots = HoldemHand.buildPots(this.seats);
    const order = [...this.orderAfter(this.button, () => true), this.button];

    for (const pot of pots) {
      let winners;
      if (pot.eligible.length === 1 || reason === 'fold') winners = pot.eligible.filter((i) => !this.seats[i].folded);
      else {
        const best = Math.max(...pot.eligible.map((i) => hands[i].score));
        winners = pot.eligible.filter((i) => hands[i].score === best);
      }
      const share = Math.floor(pot.amount / winners.length);
      winners.forEach((i) => (won[i] += share));
      let rem = pot.amount - share * winners.length;
      for (const i of order) {
        if (rem <= 0) break;
        if (winners.includes(i)) {
          won[i] += 1;
          rem -= 1;
        }
      }
      pot.winners = winners;
    }

    this.pots = pots;
    this.results = this.seats.map((s, i) => ({
      won: won[i],
      net: won[i] - s.totalIn,
      finalStack: s.stack + won[i],
      hand: hands[i],
      winner: pots.some((p) => p.winners.includes(i) && (p.eligible.length > 1 || reason === 'fold')),
    }));
    return { type: 'end', reason };
  }
}

module.exports = { HoldemHand, STREET_NAMES };
