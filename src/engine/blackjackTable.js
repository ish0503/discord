/**
 * 다인 블랙잭 라운드 (한 슈 공유) — 스플릿·더블·보험·딜러 피크 지원.
 *
 * 딜링: 플레이어 전원 1장 → 딜러 업카드 → 전원 1장 → 딜러 홀카드(비공개, 카운트 보류)
 * 단계(phase):
 *   'insurance' 딜러 업카드가 A → 각자 보험(베팅의 1/2) 여부 결정 → 피크
 *   'play'      손패 순서대로 히트/스탠드/더블/스플릿
 *   'dealer'    모든 손패 종료 → 딜러 플레이 → results()
 * 규칙: S17(설정), 블랙잭 3:2, 보험 2:1, 스플릿 최대 maxHands손, 스플릿 에이스는 1장만(재스플릿 불가),
 *       스플릿 후 A+10은 21(블랙잭 아님), 스플릿 후 더블 허용(설정)
 */
const bj = require('./blackjack');

class BlackjackRound {
  constructor(shoe, entries, { blackjackPays = 1.5, hitSoft17 = false, maxHands = 4, doubleAfterSplit = true } = {}) {
    this.shoe = shoe;
    this.rules = { blackjackPays, hitSoft17, maxHands, doubleAfterSplit };
    this.players = entries.map((e) => ({ ...e, baseBet: e.bet, insurance: 0, insuranceDecided: false }));
    this.hands = entries.map((e) => ({ owner: e.id, name: e.name, bet: e.bet, cards: [], status: 'playing', doubled: false, fromSplit: false, splitAces: false }));
    this.dealer = [];
    this.hole = null;
    this.holeHidden = true;
    this.dealerBlackjack = false;
    this.phase = 'deal';
  }

  player(id) {
    return this.players.find((p) => p.id === id);
  }

  deal() {
    for (const h of this.hands) h.cards.push(this.shoe.draw());
    this.dealer.push(this.shoe.draw());
    for (const h of this.hands) h.cards.push(this.shoe.draw());
    this.hole = this.shoe.draw({ counted: false });
    this.dealer.push(this.hole);
    for (const h of this.hands) if (bj.isBlackjack(h.cards)) h.status = 'blackjack';

    if (this.dealer[0].rank === 'A') this.phase = 'insurance';
    else this.#peek();
  }

  /** 보험 결정. 전원 결정하면 피크 후 true 반환 */
  decideInsurance(playerId, take) {
    if (this.phase !== 'insurance') throw new Error('보험 단계가 아닙니다.');
    const p = this.player(playerId);
    if (!p || p.insuranceDecided) return false;
    p.insuranceDecided = true;
    p.insurance = take ? Math.floor(p.baseBet / 2) : 0;
    if (this.players.every((x) => x.insuranceDecided)) {
      this.#peek();
      return true;
    }
    return false;
  }

  /** 시간 초과 등: 미결정자는 보험 안 듦으로 처리하고 피크 */
  closeInsurance() {
    if (this.phase !== 'insurance') return;
    for (const p of this.players) if (!p.insuranceDecided) p.insuranceDecided = true;
    this.#peek();
  }

  #peek() {
    if (bj.isBlackjack(this.dealer)) {
      this.dealerBlackjack = true;
      this.revealHole();
      for (const h of this.hands) if (h.status === 'playing') h.status = 'stand';
    }
    this.phase = this.hands.some((h) => h.status === 'playing') ? 'play' : 'dealer';
  }

  /** 지금 행동할 손패 인덱스 ('play' 단계에서만, 아니면 null) */
  get actor() {
    if (this.phase !== 'play') return null;
    const i = this.hands.findIndex((h) => h.status === 'playing');
    return i < 0 ? null : i;
  }

  handCount(owner) {
    return this.hands.filter((h) => h.owner === owner).length;
  }

  canDouble(i) {
    const h = this.hands[i];
    return h.status === 'playing' && h.cards.length === 2 && !h.splitAces && (!h.fromSplit || this.rules.doubleAfterSplit);
  }

  canSplit(i) {
    const h = this.hands[i];
    return (
      h.status === 'playing' &&
      h.cards.length === 2 &&
      !h.splitAces &&
      bj.cardPoints(h.cards[0]) === bj.cardPoints(h.cards[1]) &&
      this.handCount(h.owner) < this.rules.maxHands
    );
  }

  /** 추가 베팅이 필요한 액션의 금액 (호출 측이 지갑에서 먼저 확보) */
  extraStake(i, action) {
    if (action === 'double' || action === 'split') return this.hands[i].bet;
    return 0;
  }

  #afterCard(h) {
    const { total } = bj.handValue(h.cards);
    if (total > 21) h.status = 'bust';
    else if (total === 21) h.status = 'stand';
  }

  act(i, action) {
    if (this.phase !== 'play' || i !== this.actor) throw new Error('행동 순서가 아닙니다.');
    const h = this.hands[i];
    if (action === 'hit') {
      h.cards.push(this.shoe.draw());
      this.#afterCard(h);
    } else if (action === 'stand') {
      h.status = 'stand';
    } else if (action === 'double') {
      if (!this.canDouble(i)) throw new Error('더블할 수 없습니다.');
      h.bet *= 2;
      h.doubled = true;
      h.cards.push(this.shoe.draw());
      h.status = bj.handValue(h.cards).total > 21 ? 'bust' : 'stand';
    } else if (action === 'split') {
      if (!this.canSplit(i)) throw new Error('스플릿할 수 없습니다.');
      const aces = h.cards[0].rank === 'A';
      const second = { owner: h.owner, name: h.name, bet: h.bet, cards: [h.cards.pop()], status: 'playing', doubled: false, fromSplit: true, splitAces: aces };
      h.fromSplit = true;
      h.splitAces = aces;
      this.hands.splice(i + 1, 0, second);
      for (const x of [h, second]) {
        x.cards.push(this.shoe.draw());
        if (aces) x.status = 'stand'; // 스플릿 에이스는 한 장만
        else this.#afterCard(x);
      }
    } else {
      throw new Error(`알 수 없는 액션: ${action}`);
    }
    if (this.actor === null) this.phase = 'dealer';
  }

  revealHole() {
    if (!this.holeHidden) return;
    this.holeHidden = false;
    this.shoe.count(this.hole);
  }

  get dealerShouldDraw() {
    if (this.dealerBlackjack || this.holeHidden) return false;
    return this.hands.some((h) => h.status === 'stand') && bj.dealerShouldHit(this.dealer, this.rules.hitSoft17);
  }

  dealerDraw() {
    this.dealer.push(this.shoe.draw());
  }

  /**
   * 판정. hands[k] = { outcome, net, label, payout, bet }
   * players[k] = { id, staked(손패 베팅 + 보험), payout, net, insurancePayout }
   */
  results() {
    this.revealHole();
    const hands = this.hands.map((h) => {
      const r = bj.settle(h.cards, this.dealer, h.bet, this.rules.blackjackPays, { noBlackjack: h.fromSplit });
      return { ...r, payout: h.bet + r.net, bet: h.bet };
    });
    const players = this.players.map((p) => {
      const mine = this.hands.map((h, k) => (h.owner === p.id ? hands[k] : null)).filter(Boolean);
      const insurancePayout = p.insurance && this.dealerBlackjack ? p.insurance * 3 : 0; // 2:1 + 원금
      const staked = mine.reduce((s, x) => s + x.bet, 0) + p.insurance;
      const payout = mine.reduce((s, x) => s + x.payout, 0) + insurancePayout;
      return { id: p.id, staked, payout, net: payout - staked, insurance: p.insurance, insurancePayout, hands: mine.length };
    });
    return { hands, players };
  }
}

module.exports = { BlackjackRound };
