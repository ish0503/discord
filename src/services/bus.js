/**
 * 내부 이벤트 버스. 정산 같은 핵심 로직과 업적·미션·알림 같은 부가 기능을 분리한다.
 *   'round:settled'  { userId, guildId, economyKey, game, staked, payout, net, detail, recovered }
 *   'alert'          { level, title, message }
 * 리스너의 오류는 정산 흐름에 절대 전파되지 않는다.
 */
const { EventEmitter } = require('node:events');

const bus = new EventEmitter();
bus.setMaxListeners(50);

/** 비동기 리스너 등록 (오류 격리) */
function on(event, handler) {
  bus.on(event, (payload) => {
    Promise.resolve()
      .then(() => handler(payload))
      .catch((err) => console.error(`[bus:${event}]`, err));
  });
}

module.exports = { on, emit: (event, payload) => bus.emit(event, payload), raw: bus };
