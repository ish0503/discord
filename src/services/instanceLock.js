/**
 * 단일 인스턴스 리더 임대 (MongoDB SystemState 'leader' 문서).
 *
 * 이 봇은 "디스코드 연결 + 게임 진행 상태(메모리) + 주기 작업"을 한 프로세스가 맡는 단일 인스턴스 구조다.
 * 같은 토큰으로 두 프로세스가 동시에 돌면 버튼 이벤트가 양쪽으로 들어가고, 부팅 복구가 살아 있는
 * 다른 인스턴스의 판을 환불할 수 있다. 그래서:
 *   - 부팅 시 임대를 얻을 때까지 기다린다 (재배포 시 이전 인스턴스가 종료하며 임대를 반납하면 즉시 획득,
 *     이전 인스턴스가 죽었다면 TTL이 지나면 획득).
 *   - 임대를 가진 동안에만 디스코드 로그인·부팅 복구·스케줄 작업을 한다.
 *   - 임대를 다른 인스턴스에 빼앗기면(중복 실행 감지) 알림 후 스스로 종료한다.
 * ⚠️ 이것은 "중복 실행 감지·차단" 장치다. 여러 인스턴스가 일을 나눠 맡는 수평 확장은 지원하지 않는다.
 */
const SystemState = require('../db/SystemState');
const config = require('../config');

const ID = 'leader';

function create(instance, { ttlMs = config.INSTANCE.LEASE_TTL_MS } = {}) {
  let held = false;
  let timer = null;

  async function ensureDoc() {
    try {
      await SystemState.updateOne({ _id: ID }, { $setOnInsert: { instance: null, leaseUntil: new Date(0) } }, { upsert: true });
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }

  /** 임대 획득/갱신. 성공하면 true */
  async function tryAcquire() {
    await ensureDoc();
    const now = new Date();
    const res = await SystemState.updateOne(
      { _id: ID, $or: [{ leaseUntil: { $lt: now } }, { instance }] },
      { $set: { instance, leaseUntil: new Date(now.getTime() + ttlMs), renewedAt: now } },
    );
    held = res.modifiedCount === 1 || res.matchedCount === 1;
    return held;
  }

  /** 현재 임대 보유자 정보 */
  const holder = () => SystemState.findById(ID).lean();

  /** 획득할 때까지 대기 (로그·콜백으로 상황 알림) */
  async function acquire({ pollMs = 3_000, onWait = null, logEveryMs = config.INSTANCE.WAIT_LOG_MS } = {}) {
    let lastLog = 0;
    for (;;) {
      if (await tryAcquire()) return true;
      if (Date.now() - lastLog >= logEveryMs) {
        lastLog = Date.now();
        const h = await holder().catch(() => null);
        onWait?.(h);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /** 주기 갱신. 다른 인스턴스가 임대를 가져가면 onLost 호출 */
  function keep({ renewMs = config.INSTANCE.RENEW_MS, onLost }) {
    clearInterval(timer);
    timer = setInterval(async () => {
      try {
        if (!(await tryAcquire())) {
          clearInterval(timer);
          onLost?.(await holder().catch(() => null));
        }
      } catch (err) {
        console.error('[instanceLock] 갱신 실패:', err.message); // DB 일시 장애: 다음 주기에 재시도 (TTL 안에 복구되면 유지)
      }
    }, renewMs);
    timer.unref?.();
  }

  async function release() {
    clearInterval(timer);
    if (!held) return;
    await SystemState.updateOne({ _id: ID, instance }, { $set: { leaseUntil: new Date(0), releasedAt: new Date() } }).catch(() => {});
    held = false;
  }

  return { tryAcquire, acquire, keep, release, holder, isLeader: () => held };
}

module.exports = { create };
