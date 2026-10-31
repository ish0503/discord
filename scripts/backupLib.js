/**
 * 백업 파일 형식 & 무결성 검사 (DB와 무관 → 단위 테스트 가능)
 *   <dir>/manifest.json            { createdAt, database, collections: [{ name, file, count, sha256 }] }
 *   <dir>/<collection>.jsonl.gz    한 줄에 문서 하나 (Extended JSON — ObjectId·Date 타입 보존)
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/** docs(비동기 반복자)를 gzip jsonl로 기록 → { name, file, count, sha256 } */
async function writeCollection(dir, name, docs, serialize = JSON.stringify) {
  const file = `${name}.jsonl.gz`;
  let count = 0;
  async function* lines() {
    for await (const d of docs) {
      count += 1;
      yield `${serialize(d)}\n`;
    }
  }
  await pipeline(Readable.from(lines()), zlib.createGzip(), fs.createWriteStream(path.join(dir, file)));
  return { name, file, count, sha256: await sha256File(path.join(dir, file)) };
}

/** 한 컬렉션 파일의 문서를 순회 */
async function* readCollection(dir, entry, parse = JSON.parse) {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, entry.file)).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) yield parse(line);
}

/** 무결성 검사: 체크섬 + 모든 줄 파싱 + 문서 수 */
async function verify(dir, parse = JSON.parse) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const problems = [];
  for (const c of manifest.collections) {
    const file = path.join(dir, c.file);
    if (!fs.existsSync(file)) {
      problems.push(`${c.name}: 파일 없음`);
      continue;
    }
    if ((await sha256File(file)) !== c.sha256) {
      problems.push(`${c.name}: 체크섬 불일치`);
      continue;
    }
    let n = 0;
    try {
      for await (const _ of readCollection(dir, c, parse)) n += 1; // eslint-disable-line no-unused-vars
    } catch (err) {
      problems.push(`${c.name}: 파싱 실패 (${err.message})`);
      continue;
    }
    if (n !== c.count) problems.push(`${c.name}: 문서 수 불일치 (manifest ${c.count}, 실제 ${n})`);
  }
  return { ok: problems.length === 0, problems, manifest };
}

module.exports = { writeCollection, readCollection, verify, sha256File };
