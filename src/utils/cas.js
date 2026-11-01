/**
 * 낙관적 동시성 업데이트 (compare-and-swap).
 * 문서를 읽어 새 값을 계산한 뒤 "버전이 그대로일 때만" 쓴다. 다른 처리기가 먼저 바꿨으면 다시 읽어 재계산.
 * → 같은 유저의 정산 이벤트가 동시에 처리돼도 진행도가 덮어써져 사라지지 않는다.
 *
 * @param compute(doc) → { update } (몽고 업데이트, 버전 증가는 자동) | null (바꿀 것 없음)
 */
const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

async function casUpdate(Model, filter, compute, { versionPath = 'v', tries = 8 } = {}) {
  for (let i = 0; i < tries; i++) {
    const doc = await Model.findOne(filter).lean();
    if (!doc) return { ok: false, missing: true };
    const r = compute(doc);
    if (!r) return { ok: true, noop: true, doc };
    const ver = getPath(doc, versionPath);
    const update = { ...r.update, $inc: { ...(r.update.$inc || {}), [versionPath]: 1 } };
    const res = await Model.updateOne({ ...filter, [versionPath]: ver === undefined ? { $exists: false } : ver }, update);
    if (res.modifiedCount === 1) return { ok: true, doc, ...r };
  }
  throw new Error('동시 갱신 경합이 계속됨 (재시도 예정)');
}

module.exports = { casUpdate };
