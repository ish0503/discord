/**
 * 백업 검증 / 복원
 *   node scripts/restore.js <백업폴더> --verify
 *       체크섬·파싱·문서 수만 확인 (DB 접속 없음)
 *   node scripts/restore.js <백업폴더> --apply --uri <대상 URI> --yes [--drop]
 *       대상 DB에 복원 후 컬렉션별 문서 수를 manifest와 대조
 *       --drop 이 없으면 비어 있지 않은 컬렉션이 있을 때 중단 (실수로 운영 DB를 덮어쓰지 않도록)
 */
const mongoose = require('mongoose');
const { verify, readCollection } = require('./backupLib');

const args = process.argv.slice(2);
const dir = args[0];
const has = (f) => args.includes(f);
const val = (f) => (args.indexOf(f) > -1 ? args[args.indexOf(f) + 1] : null);

async function main() {
  if (!dir || dir.startsWith('--')) throw new Error('사용법: node scripts/restore.js <백업폴더> --verify | --apply --uri <URI> --yes [--drop]');
  const { EJSON } = mongoose.mongo.BSON;
  const parse = (l) => EJSON.parse(l, { relaxed: false });

  const v = await verify(dir, parse);
  if (!v.ok) throw new Error(`무결성 검사 실패: ${v.problems.join('; ')}`);
  console.log(`✅ 무결성 검사 통과 (${v.manifest.collections.length}개 컬렉션, 원본 DB ${v.manifest.database}, ${v.manifest.createdAt})`);
  if (!has('--apply')) return;

  const uri = val('--uri');
  if (!uri) throw new Error('--uri 가 필요합니다.');
  if (!has('--yes')) throw new Error('복원은 되돌릴 수 없습니다. 확인했다면 --yes 를 붙이세요.');
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  if (!has('--drop')) {
    for (const c of v.manifest.collections) {
      if ((await db.collection(c.name).estimatedDocumentCount()) > 0) throw new Error(`대상 DB의 ${c.name} 컬렉션이 비어 있지 않습니다. 덮어쓰려면 --drop`);
    }
  }
  const mismatches = [];
  for (const c of v.manifest.collections) {
    const col = db.collection(c.name);
    if (has('--drop')) await col.drop().catch(() => {});
    let batch = [];
    for await (const doc of readCollection(dir, c, parse)) {
      batch.push(doc);
      if (batch.length >= 1000) {
        await col.insertMany(batch, { ordered: false });
        batch = [];
      }
    }
    if (batch.length) await col.insertMany(batch, { ordered: false });
    const n = await col.countDocuments();
    console.log(`  ${c.name}: ${n}/${c.count}`);
    if (n !== c.count) mismatches.push(c.name);
  }
  await mongoose.disconnect();
  if (mismatches.length) throw new Error(`복원 후 문서 수 불일치: ${mismatches.join(', ')}`);
  console.log('✅ 복원 완료 & 문서 수 일치');
}

main().catch(async (err) => {
  console.error('❌', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
