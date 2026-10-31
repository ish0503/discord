/**
 * MongoDB 전체 백업:  npm run backup  (또는 node scripts/backup.js --out ./backups)
 * 컬렉션별 gzip jsonl + manifest(문서 수·SHA-256). 끝나면 바로 무결성 검사까지 수행.
 */
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const { writeCollection, verify } = require('./backupLib');

const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1 ? process.argv[outArg + 1] : 'backups';

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI 환경 변수가 필요합니다.');
  await mongoose.connect(uri);
  const { EJSON } = mongoose.mongo.BSON;
  const db = mongoose.connection.db;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(OUT, `backup-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });

  const cols = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.'));
  const collections = [];
  for (const name of cols.sort()) {
    const entry = await writeCollection(dir, name, db.collection(name).find({}), (d) => EJSON.stringify(d, { relaxed: false }));
    collections.push(entry);
    console.log(`  ${name}: ${entry.count}건`);
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), database: db.databaseName, collections }, null, 2));
  await mongoose.disconnect();

  const v = await verify(dir, (l) => EJSON.parse(l, { relaxed: false }));
  if (!v.ok) throw new Error(`백업 검증 실패: ${v.problems.join('; ')}`);
  console.log(`✅ 백업 완료 & 검증 통과: ${dir}`);
  // GitHub Actions 등에서 다음 단계가 경로를 쓸 수 있도록
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `dir=${dir}\n`);
}

main().catch(async (err) => {
  console.error('❌', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
