/**
 * 테스트용 인메모리 Mongoose 모델 (wallet.js가 쓰는 연산자만 MongoDB 의미대로 구현).
 * 실제 DB 없이 에스크로 정산 로직을 검증하기 위한 것 — 운영 코드에서는 쓰지 않는다.
 */
const clone = (v) => (v === undefined ? v : structuredClone(v));

function getPath(doc, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
}

const isOpObj = (c) => c && typeof c === 'object' && !(c instanceof Date) && !Array.isArray(c) && Object.keys(c).some((k) => k.startsWith('$'));
const eq = (a, b) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

function matchValue(value, cond) {
  // 배열 필드 vs 단일 값: 원소 포함 여부 (Mongo 규칙)
  if (Array.isArray(value) && !isOpObj(cond) && (typeof cond !== 'object' || cond === null)) return value.some((el) => eq(el, cond));
  if (Array.isArray(value) && isOpObj(cond) && '$ne' in cond && Object.keys(cond).length === 1) return !value.some((el) => eq(el, cond.$ne));
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && Object.keys(cond).some((k) => k.startsWith('$'))) {
    return Object.entries(cond).every(([op, v]) => {
      if (op === '$gte') return value >= v;
      if (op === '$gt') return value > v;
      if (op === '$lt') return value < v;
      if (op === '$lte') return value <= v;
      if (op === '$ne') return value !== v;
      if (op === '$exists') return (value !== undefined) === v;
      if (op === '$in') return v.some((x) => eq(x, value));
      if (op === '$nin') return !v.some((x) => eq(x, value));
      if (op === '$regex') return new RegExp(v).test(value);
      if (op === '$elemMatch') return Array.isArray(value) && value.some((el) => matches(el, v));
      throw new Error(`fake: 미지원 연산자 ${op}`);
    });
  }
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  return value === cond;
}

/** dotted path가 배열을 지나면 원소 중 하나라도 맞으면 매치 (Mongo 규칙) */
function matchPath(doc, path, cond) {
  const [head, ...rest] = path.split('.');
  const v = doc?.[head];
  if (!rest.length) return matchValue(v, cond);
  if (Array.isArray(v) && !/^\d+$/.test(rest[0])) {
    if (isOpObj(cond) && '$ne' in cond) return v.every((el) => matchPath(el, rest.join('.'), cond)); // $ne: 모든 원소가 아니어야
    return v.some((el) => matchPath(el, rest.join('.'), cond));
  }
  return matchPath(v, rest.join('.'), cond);
}

function matches(doc, filter) {
  return Object.entries(filter).every(([k, cond]) => {
    if (k === '$or') return cond.some((f) => matches(doc, f));
    return matchPath(doc, k, cond);
  });
}

/** 위치 연산자 $ 대상 인덱스: 필터에서 배열 필드 조건을 만족하는 첫 원소 */
function positional(doc, filter, arrayField) {
  const arr = doc[arrayField];
  return arr.findIndex((el) =>
    Object.entries(filter).every(([k, cond]) => {
      if (k === arrayField && cond.$elemMatch) return matches(el, cond.$elemMatch);
      if (k.startsWith(`${arrayField}.`)) return matchPath(el, k.slice(arrayField.length + 1), cond);
      return true;
    }),
  );
}

function setPath(doc, path, filter, fn) {
  const parts = path.split('.');
  let o = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    let k = parts[i + 1] === '$' ? parts[i] : parts[i];
    if (parts[i] === '$') continue;
    if (parts[i + 1] === '$') {
      const idx = positional(doc, filter, k);
      if (idx < 0) throw new Error('fake: 위치 연산자 대상 없음');
      o = o[k][idx];
      i++;
      continue;
    }
    o[k] ??= {};
    o = o[k];
  }
  const last = parts[parts.length - 1];
  o[last] = fn(o[last]);
}

function applyUpdate(doc, update, filter, inserting) {
  for (const [op, fields] of Object.entries(update)) {
    for (const [path, v] of Object.entries(fields)) {
      if (op === '$inc') setPath(doc, path, filter, (cur) => (cur ?? 0) + v);
      else if (op === '$set') setPath(doc, path, filter, () => clone(v));
      else if (op === '$setOnInsert') {
        if (inserting) setPath(doc, path, filter, () => clone(v));
      } else if (op === '$max') setPath(doc, path, filter, (cur) => (cur === undefined || v > cur ? v : cur));
      else if (op === '$push')
        setPath(doc, path, filter, (cur) => {
          if (v && typeof v === 'object' && '$each' in v) {
            const arr = [...(cur ?? []), ...clone(v.$each)];
            return v.$slice !== undefined ? arr.slice(v.$slice) : arr;
          }
          return [...(cur ?? []), clone(v)];
        });
      else if (op === '$addToSet') setPath(doc, path, filter, (cur) => ((cur ?? []).some((el) => eq(el, v)) ? cur ?? [] : [...(cur ?? []), clone(v)]));
      else if (op === '$pull') setPath(doc, path, filter, (cur) => (cur ?? []).filter((el) => (v && typeof v === 'object' ? !matches(el, v) : !eq(el, v))));
      else throw new Error(`fake: 미지원 업데이트 ${op}`);
    }
  }
}

/** 고유 인덱스 (실제 스키마와 같게) — create 시 중복이면 code 11000 */
const UNIQUE = {
  GameLog: [['roundId']],
  Tournament: [['tournamentId']],
  GameState: [['gameId']],
  OutboxEvent: [['eventId']],
  Transfer: [['transferId']],
  SettlementRecord: [['settlementId']],
  TransferQuota: [['economyKey', 'userId', 'day']],
  Ledger: [['refId', 'userId']],
  HallOfFameRecord: [['recordId']],
  HallOfFameBest: [['guildId', 'category']],
  StoryProgress: [['guildId', 'userId']],
  Clan: [['clanId'], { keys: ['guildId', 'nameKey'], where: { status: 'active' } }],
  ClanMember: [['guildId', 'userId']],
  ClanApplication: [{ keys: ['clanId', 'userId'], where: { status: 'pending' } }],
  ClanPlayer: [['guildId', 'userId']],
  WorldBoss: [['bossId'], { keys: ['guildId', 'status'], where: { status: 'active' } }],
  BossContribution: [['bossId', 'userId']],
  UserCollection: [['userId', 'itemId']],
  RankProfile: [['guildId', 'userId', 'gameType', 'seasonKey']],
  PrivateRoom: [['roomId']],
  Prediction: [['tournamentId', 'userId', 'predictionType']],
};

let seq = 0;
function makeModel(name, defaults = () => ({})) {
  const docs = [];
  // 체이닝 가능한 쿼리 (sort/skip/limit/lean)
  const q = (v, single = false) => {
    let rows = Array.isArray(v) ? v : v ? [v] : [];
    const api = {
      sort(spec) {
        const [[k, dir]] = Object.entries(spec);
        rows = [...rows].sort((a, b) => ((getPath(a, k) ?? 0) > (getPath(b, k) ?? 0) ? dir : -dir));
        return api;
      },
      skip(n) {
        rows = rows.slice(n);
        return api;
      },
      limit(n) {
        rows = rows.slice(0, n);
        return api;
      },
      lean: async () => clone(single ? rows[0] ?? null : rows),
      then: (r, j) => Promise.resolve(clone(single ? rows[0] ?? null : rows)).then(r, j),
    };
    return api;
  };
  const model = {
    name,
    docs,
    reset: () => docs.splice(0),
    create: async (d) => {
      for (const spec of UNIQUE[name] ?? []) {
        const keys = Array.isArray(spec) ? spec : spec.keys;
        const where = Array.isArray(spec) ? null : spec.where; // 부분 고유 인덱스 (partialFilterExpression)
        if (where && !matches(d, where)) continue;
        if (docs.some((x) => (!where || matches(x, where)) && keys.every((k) => getPath(x, k) !== undefined && eq(getPath(x, k), getPath(d, k))))) {
          const e = new Error(`dup ${name} ${keys}`);
          e.code = 11000;
          throw e;
        }
      }
      const doc = { _id: `oid${++seq}`, ...defaults(), createdAt: new Date(), ...clone(d) };
      docs.push(doc);
      return { ...clone(doc), toObject: () => clone(doc) };
    },
    findOne: (filter) => q(docs.filter((d) => matches(d, filter)), true),
    findById: (id) => q(docs.filter((d) => d._id === id), true),
    find: (filter) => q(docs.filter((d) => matches(d, filter))),
    countDocuments: async (filter) => docs.filter((d) => matches(d, filter)).length,
    distinct: async (field, filter) => [...new Set(docs.filter((d) => matches(d, filter)).map((d) => getPath(d, field)))],
    aggregate: async () => [],
    deleteOne: async (filter) => {
      const k = docs.findIndex((x) => matches(x, filter));
      if (k < 0) return { deletedCount: 0 };
      docs.splice(k, 1);
      return { deletedCount: 1 };
    },
    deleteMany: async (filter) => {
      let n = 0;
      for (let k = docs.length - 1; k >= 0; k--) if (matches(docs[k], filter)) (docs.splice(k, 1), n++);
      return { deletedCount: n };
    },
    updateMany: async (filter, update) => {
      const hit = docs.filter((x) => matches(x, filter));
      hit.forEach((d) => applyUpdate(d, update, filter, false));
      return { matchedCount: hit.length, modifiedCount: hit.length };
    },
    updateOne: async (filter, update, opts = {}) => {
      const d = docs.find((x) => matches(x, filter));
      if (!d) {
        if (opts.upsert) {
          const nd = { ...defaults(), ...Object.fromEntries(Object.entries(filter).filter(([k, v]) => !k.startsWith('$') && typeof v !== 'object')) };
          applyUpdate(nd, update, filter, true);
          docs.push(nd);
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        }
        return { matchedCount: 0, modifiedCount: 0 };
      }
      applyUpdate(d, update, filter, false);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    findOneAndUpdate: (filter, update, opts = {}) => {
      let d = docs.find((x) => matches(x, filter));
      let before = d ? clone(d) : null;
      if (!d && opts.upsert) {
        const base = Object.fromEntries(Object.entries(filter).filter(([k, v]) => !k.startsWith('$') && (typeof v !== 'object' || v === null)));
        d = { _id: `oid${++seq}`, ...defaults(), ...base };
        applyUpdate(d, update, filter, true);
        docs.push(d);
        before = null;
        return q(opts.new ? d : null, true);
      }
      if (!d) return q(null, true);
      applyUpdate(d, update, filter, false);
      return q(opts.new ? d : before, true);
    },
  };
  return model;
}

module.exports = { makeModel };
