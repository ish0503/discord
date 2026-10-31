/** 바카라 카드 점수: A=1, 2~9=액면, 10·J·Q·K=0 */
function point(card) {
  if (card.rank === 'A') return 1;
  const n = Number(card.rank);
  return Number.isNaN(n) || n === 10 ? 0 : n;
}

function total(cards) {
  return cards.reduce((s, c) => s + point(c), 0) % 10;
}

/** 뱅커 서드 카드 규칙 (playerThird = null 이면 플레이어가 스탠드한 경우) */
function bankerDraws(bankerTotal, playerThird) {
  if (playerThird === null) return bankerTotal <= 5;
  const p = point(playerThird);
  switch (bankerTotal) {
    case 0:
    case 1:
    case 2:
      return true;
    case 3:
      return p !== 8;
    case 4:
      return p >= 2 && p <= 7;
    case 5:
      return p >= 4 && p <= 7;
    case 6:
      return p === 6 || p === 7;
    default:
      return false;
  }
}

/**
 * 한 판 진행. draw = () => card
 * order: 연출용 딜링 순서 [{ side, card }]
 */
function playRound(draw) {
  const order = [];
  const deal = (side, hand) => {
    const card = draw();
    hand.push(card);
    order.push({ side, card });
    return card;
  };
  const player = [];
  const banker = [];
  deal('player', player);
  deal('banker', banker);
  deal('player', player);
  deal('banker', banker);

  const natural = total(player) >= 8 || total(banker) >= 8;
  let playerThird = null;
  if (!natural) {
    if (total(player) <= 5) playerThird = deal('player', player);
    if (bankerDraws(total(banker), playerThird)) deal('banker', banker);
  }

  const pt = total(player);
  const bt = total(banker);
  const winner = pt > bt ? 'player' : bt > pt ? 'banker' : 'tie';
  return { player, banker, playerTotal: pt, bankerTotal: bt, winner, natural, order };
}

/** 정산: 타이일 때 플레이어/뱅커 베팅은 푸시 */
function settle(betSide, winner, bet, payout) {
  if (winner === 'tie' && betSide !== 'tie') return { net: 0, push: true };
  if (betSide === winner) return { net: Math.floor(bet * payout[betSide]) - bet, push: false };
  return { net: -bet, push: false };
}

module.exports = { point, total, bankerDraws, playRound, settle };
