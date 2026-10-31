/**
 * 채널별 공유 슈. 같은 채널에서 나간 카드는 모두가 보므로
 * 카운팅·흐름 보드가 "그 테이블"의 정보가 된다.
 */
const { Shoe } = require('../engine/cards');
const config = require('../config');

const SPECS = {
  blackjack: { decks: config.BLACKJACK.DECKS, reshuffleAt: config.BLACKJACK.RESHUFFLE_AT },
  baccarat: { decks: config.BACCARAT.DECKS, reshuffleAt: config.BACCARAT.RESHUFFLE_AT },
};

const shoes = new Map();

function getShoe(kind, channelId) {
  const key = `${kind}:${channelId}`;
  if (!shoes.has(key)) shoes.set(key, new Shoe(SPECS[kind]));
  return shoes.get(key);
}

module.exports = { getShoe };
