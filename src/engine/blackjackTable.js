/**
 * 다인 블랙잭 라운드 (한 슈를 여러 플레이어가 공유).
 * UI·DB와 무관한 순수 로직 — 딜링 순서, 차례, 딜러 플레이, 판정만 담당.
 *
 * 딜링 순서: 플레이어 전원 1장 → 딜러 업카드 → 플레이어 전원 1장 → 딜러 홀카드(비공개, 카운트 보류)
 * 딜러 블랙잭이면 즉시 공개 후 라운드 종료 (피크 룰), 플레이어 블랙잭은 차례 없이 확정.
 */
const bj = require('./blackjack');

class BlackjackRound {
  /** entries: [{ id, name, bet, ... }] — 좌석 순서대로 */
  constructor(shoe, entries, { blackjackPays = 1.5, hitSoft17 = false } = {}) {
    this.shoe = shoe;
    this.rules = { blackjackPays, hitSoft17 };
    this.hands = entries.map((e) => ({ ...e, cards: [], status: 'playing', doubled: false }));
    this.dealer = [];
    this.hole = null;
    this.holeHidden = true;
    this.dealerBlackjack = false;
  }

  deal() {
    for (const h of this.hands) h.cards.push(this.shoe.draw());
    this.dealer.push(this.shoe.draw());
    for (const h of this.hands) h.cards.push(this.shoe.draw());
    this.hole = this.shoe.draw({ counted: false });
    this.dealer.push(this.hole);

    for (const h of this.hands) if (bj.isBlackjack(h.cards)) h.status = 'blackjack';
    if (bj.isBlackjack(this.dealer)) {
      this.dealerBlackjack = true;
      this.revealHole();
      for (const h of this.hands) if (h.status === 'playing') h.status = 'stand';
    }
  }

  /** 지금 행동할 핸드 인덱스 (없으면 null → 딜러 차례) */
  get actor() {
    const i = this.hands.findIndex((h) => h.status === 'playing');
    return i < 0 ? null : i;
  }

  canDouble(i) {
    const h = this.hands[i];
    return h.status === 'playing' && h.cards.length === 2;
  }

  /** action: 'hit' | 'stand' | 'double' (더블의 추가 베팅금 확보는 호출 측 책임) */
  act(i, action) {
    if (i !== this.actor) throw new Error('행동 순서가 아닙니다.');
    const h = this.hands[i];
    if (action === 'hit') {
      h.cards.push(this.shoe.draw());
      const { total } = bj.handValue(h.cards);
      if (total > 21) h.status = 'bust';
      else if (total === 21) h.status = 'stand';
    } else if (action === 'stand') {
      h.status = 'stand';
    } else if (action === 'double') {
      if (!this.canDouble(i)) throw new Error('더블은 첫 두 장일 때만 가능합니다.');
      h.bet *= 2;
      h.doubled = true;
      h.cards.push(this.shoe.draw());
      h.status = bj.handValue(h.cards).total > 21 ? 'bust' : 'stand';
    } else {
      throw new Error(`알 수 없는 액션: ${action}`);
    }
  }

  revealHole() {
    if (!this.holeHidden) return;
    this.holeHidden = false;
    this.shoe.count(this.hole); // 홀카드는 공개되는 순간 카운트에 반영
  }

  /** 스탠드한 핸드가 하나라도 있을 때만 딜러가 카드를 받는다 */
  get dealerShouldDraw() {
    if (this.dealerBlackjack || this.holeHidden) return false;
    const live = this.hands.some((h) => h.status === 'stand');
    return live && bj.dealerShouldHit(this.dealer, this.rules.hitSoft17);
  }

  dealerDraw() {
    this.dealer.push(this.shoe.draw());
  }

  /** 핸드별 판정. payout = 돌려줄 총액(원금 포함) */
  results() {
    this.revealHole();
    return this.hands.map((h) => {
      const r = bj.settle(h.cards, this.dealer, h.bet, this.rules.blackjackPays);
      return { ...r, payout: h.bet + r.net, bet: h.bet };
    });
  }
}

module.exports = { BlackjackRound };
