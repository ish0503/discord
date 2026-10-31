/**
 * 인메모리 게임 세션 관리자.
 * - 유저당 동시에 1개 게임만 허용 (잔고 이중 사용 방지)
 * - run(): 버튼 연타로 같은 세션이 동시에 처리되는 것을 막는 락
 * - idle 타이머: 무반응 시 onTimeout 실행 (자동 스탠드/다이 등)
 */
const config = require('../config');

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.sweeper = setInterval(() => this.#sweep(), 60_000);
    this.sweeper.unref();
  }

  get(userId) {
    return this.sessions.get(userId);
  }

  /** 새 세션. 이미 진행 중인 게임이 있으면 null */
  start(userId, game, data = {}, { idleMs = config.SESSION_IDLE_MS, onTimeout = null } = {}) {
    if (this.sessions.has(userId)) return null;
    const session = {
      userId,
      game,
      startedAt: Date.now(),
      busy: false,
      ended: false,
      timer: null,
      idleMs,
      onTimeout,
      cleanup: null,
      ...data,
    };
    this.sessions.set(userId, session);
    this.touch(session);
    return session;
  }

  touch(session) {
    clearTimeout(session.timer);
    if (!session.onTimeout || session.ended) return;
    session.timer = setTimeout(() => {
      this.run(session, () => session.onTimeout(session)).catch((e) => console.error('[session timeout]', e));
    }, session.idleMs);
  }

  /** 세션 락 안에서 fn 실행. 이미 처리 중이면 false */
  async run(session, fn) {
    if (session.busy || session.ended) return false;
    session.busy = true;
    try {
      await fn();
      return true;
    } finally {
      session.busy = false;
      if (!session.ended) this.touch(session);
    }
  }

  end(session) {
    session.ended = true;
    clearTimeout(session.timer);
    try {
      session.cleanup?.();
    } catch (e) {
      console.error('[session cleanup]', e);
    }
    if (this.sessions.get(session.userId) === session) this.sessions.delete(session.userId);
  }

  #sweep() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (now - s.startedAt > config.SESSION_HARD_LIMIT_MS) {
        console.warn(`[session] 장기 세션 강제 종료: ${s.userId} (${s.game})`);
        this.end(s);
      }
    }
  }

  shutdown() {
    for (const s of [...this.sessions.values()]) this.end(s);
    clearInterval(this.sweeper);
  }

  get size() {
    return this.sessions.size;
  }
}

module.exports = new SessionManager();
