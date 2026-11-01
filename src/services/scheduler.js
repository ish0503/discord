/**
 * 주기 작업 스케줄러. 작업 등록(정의)과 실행(리더만)을 분리해 둔다.
 * 현재는 단일 인스턴스 + 리더 임대(instanceLock)를 전제로 하며, 다중 인스턴스로 확장할 때는
 * isLeader()를 분산 락/리더 선출 결과로 바꾸기만 하면 된다.
 * 같은 작업이 아직 실행 중이면 다음 주기는 건너뛴다 (겹침 방지).
 */
const jobs = [];
let started = false;
let leaderCheck = () => true;

function register(name, everyMs, fn, { runOnStart = false } = {}) {
  if (jobs.some((j) => j.name === name)) return;
  jobs.push({ name, everyMs, fn, runOnStart, running: false, timer: null, lastRun: null, lastError: null });
  if (started) arm(jobs.at(-1));
}

async function run(job) {
  if (job.running || !leaderCheck()) return;
  job.running = true;
  try {
    await job.fn();
    job.lastRun = new Date();
    job.lastError = null;
  } catch (err) {
    job.lastError = err.message;
    console.error(`[scheduler:${job.name}]`, err);
  } finally {
    job.running = false;
  }
}

function arm(job) {
  job.timer = setInterval(() => run(job), job.everyMs);
  job.timer.unref?.();
  if (job.runOnStart) run(job);
}

/** @param isLeader 이 인스턴스가 작업을 맡아도 되는지 */
function start({ isLeader = () => true } = {}) {
  leaderCheck = isLeader;
  started = true;
  jobs.forEach(arm);
}

function stop() {
  started = false;
  for (const j of jobs) clearInterval(j.timer);
}

const status = () => jobs.map(({ name, everyMs, running, lastRun, lastError }) => ({ name, everyMs, running, lastRun, lastError }));

module.exports = { register, start, stop, status, runNow: (name) => run(jobs.find((j) => j.name === name)) };
