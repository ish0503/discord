/**
 * 백업 파일 포맷 (DB 연결과 무관한 부분 — 단위 테스트 가능).
 *   <dir>/<컬렉션>.jsonl.gz   한 줄 = 문서 1개 (Extended JSON)
 *   <dir>/manifest.json       { createdAt, collections: [{ name, count, sha256, file }] }
 * sha256은 압축 파일 전체의 해시 → 파일 손상·변조 검출.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

/** docs(async iterable) → gzip jsonl. serialize = 문서 → 문자열 (기본 EJSON) */
async function writeCollection(dir, name, docs, serialize) {
  const file = `${name}.jsonl.gz`;
  let count = 0;
  async function* lines() {
    for await (const d of docs) {
      count += 1;
      yield `${serialize(d)}\n`;
    }
  }
  await pipeline(Readable.from(lines()), zlib.createGzip(), fs.createWriteStream(path.join(dir, file)));
  return { name, count, file, sha256: await sha256File(path.join(dir, file)) };
}

/** 컬렉션 파일의 문서를 한 줄씩 읽기 */
async function* readCollection(dir, file, parse) {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, file)).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) yield parse(line);
}

function writeManifest(dir, collections) {
  const manifest = { createdAt: new Date().toISOString(), format: 'casino-backup/1', collections };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * 무결성 검사: 해시 일치 + 모든 줄 파싱 가능 + 문서 수 일치
 * @returns { ok, problems: string[], totals: { name: count } }
 */
async function verifyDir(dir, parse) {
  const problems = [];
  const totals = {};
  const mfile = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mfile)) return { ok: false, problems: ['manifest.json 없음'], totals };
  const manifest = JSON.parse(fs.readFileSync(mfile, 'utf8'));
  for (const c of manifest.collections) {
    const file = path.join(dir, c.file);
    if (!fs.existsSync(file)) {
      problems.push(`${c.name}: 파일 없음`);
      continue;
    }
    if ((await sha256File(file)) !== c.sha256) problems.push(`${c.name}: 해시 불일치 (손상 또는 변조)`);
    let n = 0;
    try {
      for await (const _ of readCollection(dir, c.file, parse)) n += 1; // eslint-disable-line no-unused-vars
    } catch (err) {
      problems.push(`${c.name}: 파싱 실패 (${err.message})`);
    }
    if (n !== c.count) problems.push(`${c.name}: 문서 수 ${n} ≠ manifest ${c.count}`);
    totals[c.name] = n;
  }
  return { ok: problems.length === 0, problems, totals, manifest };
}

module.exports = { writeCollection, readCollection, writeManifest, verifyDir, sha256File };
