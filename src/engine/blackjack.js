function cardPoints(card) {
  if (card.rank === 'A') return 11;
  if (['10', 'J', 'Q', 'K'].includes(card.rank)) return 10;
  return Number(card.rank);
}

/** { total, soft } — soft = 에이스를 11로 세고 있는 핸드 */
function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    total += cardPoints(c);
    if (c.rank === 'A') aces += 1;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return { total, soft: aces > 0 };
}

function isBlackjack(cards) {
  return cards.length === 2 && handValue(cards).total === 21;
}

function dealerShouldHit(cards, hitSoft17 = false) {
  const { total, soft } = handValue(cards);
  if (total < 17) return true;
  return total === 17 && soft && hitSoft17;
}

/** 정산: net = 유저 순손익 */
function settle(player, dealer, bet, blackjackPays = 1.5, { noBlackjack = false } = {}) {
  const p = handValue(player).total;
  const d = handValue(dealer).total;
  const pBJ = !noBlackjack && isBlackjack(player); // 스플릿 후 A+10은 블랙잭이 아닌 21
  const dBJ = isBlackjack(dealer);

  if (pBJ && dBJ) return { outcome: 'push', net: 0, label: '🤝 둘 다 블랙잭 — 푸시' };
  if (pBJ) return { outcome: 'blackjack', net: Math.floor(bet * blackjackPays), label: '🂡 블랙잭! (3:2)' };
  if (dBJ) return { outcome: 'dealer_blackjack', net: -bet, label: '💀 딜러 블랙잭' };
  if (p > 21) return { outcome: 'bust', net: -bet, label: '💥 버스트' };
  if (d > 21) return { outcome: 'dealer_bust', net: bet, label: '🎉 딜러 버스트 — 승리' };
  if (p > d) return { outcome: 'win', net: bet, label: '🎉 승리' };
  if (p < d) return { outcome: 'lose', net: -bet, label: '😵 패배' };
  return { outcome: 'push', net: 0, label: '🤝 푸시 (무승부)' };
}

module.exports = { cardPoints, handValue, isBlackjack, dealerShouldHit, settle };
