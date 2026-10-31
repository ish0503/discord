/**
 * 실시간 메시지 편집기 (latest-wins).
 *
 * 디스코드 메시지 편집은 레이트 리밋이 있어 0.2초마다 무조건 edit을 날리면
 * 요청이 큐에 쌓여 화면이 실제보다 점점 늦어진다.
 * 이 클래스는 "편집 중이면 최신 프레임 하나만 보관"하고, 끝나면 그것만 보낸다.
 * → 화면은 API가 허용하는 최대 속도로 항상 '최신' 상태를 따라간다.
 */
class LiveMessage {
  constructor(editFn) {
    this.editFn = editFn;
    this.pending = null;
    this.inFlight = null;
    this.closed = false;
  }

  push(payload) {
    if (this.closed) return;
    this.pending = payload;
    if (!this.inFlight) this.inFlight = this.#flush();
  }

  async #flush() {
    while (this.pending) {
      const payload = this.pending;
      this.pending = null;
      try {
        await this.editFn(payload);
      } catch (err) {
        console.error('[LiveMessage] edit 실패:', err.message);
      }
    }
    this.inFlight = null;
  }

  /** 마지막 프레임: 진행 중인 편집이 끝난 뒤 반드시 이 내용으로 덮어쓴다 */
  async final(payload) {
    this.closed = true;
    this.pending = null;
    if (this.inFlight) await this.inFlight;
    return this.editFn(payload);
  }
}

module.exports = { LiveMessage };
