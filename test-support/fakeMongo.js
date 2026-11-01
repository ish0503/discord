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

/**
 * 스키마 경로 검사 — 실제 Mongoose(strict·strictQuery)는 스키마에 없는 필드를 저장·조회 조건에서
 * "조용히 버린다". 인메모리 가짜 DB가 그걸 그냥 받아 주면 테스트는 통과하는데 운영에서만 고장난다.
 * 그래서 스키마에 없는 경로를 쓰면 테스트에서 바로 실패시킨다.
 */
const ALWAYS = new Set(['_id', '__v', 'createdAt', 'updatedAt']);
const isSchema = (x) => x && typeof x === 'object' && x.__schema;
const isMixed = (x) => x === 'Mixed';
function isFieldDef(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node) || isSchema(node)) return false;
  const t = node.type;
  return t !== undefined && (typeof t === 'function' || Array.isArray(t) || isMixed(t) || isSchema(t));
}

/** defn 아래에 parts 경로가 있는가 */
function pathOk(defn, parts) {
  let cur = defn;
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k];
    if (part === '$' || /^\d+$/.test(part) || part.startsWith('$[')) continue; // 배열 위치
    if (isMixed(cur)) return true;
    if (cur === 'PRIMITIVE') return false;
    if (cur === 'ARRAY_PRIMITIVE') return false;
    if (!cur || typeof cur !== 'object') return false;
    if (isSchema(cur)) cur = cur.d;
    let node = cur[part];
    if (node === undefined) return k === 0 && ALWAYS.has(part);
    // 노드를 다음 탐색 대상으로 정규화
    const descend = (n) => {
      if (isMixed(n)) return 'Mixed';
      if (isSchema(n)) return n.d;
      if (Array.isArray(n)) {
        const el = n[0];
        if (el === undefined || isMixed(el)) return 'Mixed';
        if (isSchema(el)) return el.d;
        if (typeof el === 'function') return 'ARRAY_PRIMITIVE';
        if (isFieldDef(el)) return descend(el.type);
        if (typeof el === 'object') return el;
        return 'ARRAY_PRIMITIVE';
      }
      if (isFieldDef(n)) return descend(n.type);
      if (typeof n === 'function') return 'PRIMITIVE';
      if (n && typeof n === 'object') return n; // 중첩 객체
      return 'PRIMITIVE';
    };
    cur = descend(node);
  }
  return true;
}

function checkPath(name, schema, path, where) {
  if (!schema) return;
  if (!pathOk(schema.d, path.split('.'))) throw new Error(`fake: ${name} 스키마에 없는 필드 "${path}" (${where}) — 실제 Mongoose는 이 값을 조용히 버립니다`);
}

function checkFilter(name, schema, filter, where = '조회 조건') {
  if (!schema || !filter || typeof filter !== 'object') return;
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$or' || k === '$and' || k === '$nor') {
      for (const f of v) checkFilter(name, schema, f, where);
      continue;
    }
    if (k.startsWith('$')) continue;
    checkPath(name, schema, k, where);
  }
}

function checkUpdate(name, schema, update) {
  if (!schema) return;
  for (const [op, fields] of Object.entries(update)) {
    if (!op.startsWith('$')) {
      checkPath(name, schema, op, '업데이트');
      continue;
    }
    for (const path of Object.keys(fields || {})) checkPath(name, schema, path, `업데이트 ${op}`);
  }
}

function checkDoc(name, schema, doc) {
  if (!schema) return;
  for (const k of Object.keys(doc || {})) checkPath(name, schema, k, '생성');
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
  Rivalry: [['guildId', 'pairKey']],
  RivalMatch: [['guildId', 'gameId', 'pairKey']],
};

let seq = 0;
function makeModel(name, defaults = () => ({}), schema = null) {
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
      checkDoc(name, schema, d);
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
    findOne: (filter) => (checkFilter(name, schema, filter), q(docs.filter((d) => matches(d, filter)), true)),
    findById: (id) => q(docs.filter((d) => d._id === id), true),
    find: (filter) => (checkFilter(name, schema, filter), q(docs.filter((d) => matches(d, filter)))),
    countDocuments: async (filter) => (checkFilter(name, schema, filter), docs.filter((d) => matches(d, filter)).length),
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
      checkFilter(name, schema, filter);
      checkUpdate(name, schema, update);
      const hit = docs.filter((x) => matches(x, filter));
      hit.forEach((d) => applyUpdate(d, update, filter, false));
      return { matchedCount: hit.length, modifiedCount: hit.length };
    },
    updateOne: async (filter, update, opts = {}) => {
      checkFilter(name, schema, filter);
      checkUpdate(name, schema, update);
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
      checkFilter(name, schema, filter);
      checkUpdate(name, schema, update);
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
