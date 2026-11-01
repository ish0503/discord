/**
 * v3 마이그레이션 (안정화 + 신규 콘텐츠). 기존 데이터는 바꾸지 않고 "추가"만 한다.
 *
 *   node scripts/migrate-v3.js            # 드라이런: 현재 상태와 할 일만 출력
 *   node scripts/migrate-v3.js --apply    # 인덱스 생성·동기화
 *
 * 하는 일
 *  1. src/db 의 모든 모델 인덱스 동기화 (새 컬렉션: outboxevents, transfers, transferquotas, settlementrecords, 클랜·보스 등)
 *     - 기존 인덱스는 지우지 않는다 (syncIndexes 대신 createIndexes) → 롤백해도 이전 버전이 그대로 동작
 *  2. 상태 점검: 지갑에 남은 Outbox 이벤트, 보류(blocked)된 에스크로, 처리 중 송금 수
 *
 * 스키마 호환성
 *  - 새 필드(users.outbox·txLog, profiles.processedEvents 등)는 모두 기본값이 있어 기존 문서 그대로 동작한다.
 *  - 롤백: 이전 버전을 다시 배포하면 새 필드·컬렉션은 무시된다. 단, 롤백 중에는 지갑에 쌓인 Outbox 이벤트가
 *    처리되지 않으므로(칩은 정상) 다시 v3로 올리면 부팅 스윕이 이어서 처리한다.
 *
 * 반드시 백업 후 실행하세요:  npm run backup
 */
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI 환경 변수가 필요합니다.');
  await mongoose.connect(process.env.MONGODB_URI);
  const dir = path.join(__dirname, '../src/db');
  const models = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js') && f !== 'connect.js')
    .map((f) => require(path.join(dir, f)));
  console.log(`\n🔧 v3 마이그레이션 ${APPLY ? '(적용)' : '(드라이런 — 변경 없음)'} · 모델 ${models.length}개\n`);

  for (const m of models) {
    const existing = await m.collection.indexes().catch(() => []);
    const want = m.schema.indexes();
    const names = existing.map((i) => i.name);
    console.log(`- ${m.modelName.padEnd(18)} 인덱스 ${existing.length}개 (${names.join(', ') || '없음'}) · 스키마 정의 ${want.length + 1}개`);
    if (APPLY) await m.createIndexes();
  }

  const db = mongoose.connection.db;
  const users = db.collection('users');
  const [pendingOutbox, blocked, pendingTx] = await Promise.all([
    users.countDocuments({ 'outbox.0': { $exists: true } }),
    users.countDocuments({ escrow: { $elemMatch: { blocked: { $ne: null, $exists: true } } } }),
    db.collection('transfers').countDocuments({ status: 'pending' }).catch(() => 0),
  ]);
  console.log(`\n점검: 지갑에 남은 Outbox 이벤트 보유 지갑 ${pendingOutbox}개 · 보류된 에스크로 보유 지갑 ${blocked}개 · 처리 중 송금 ${pendingTx}건`);
  console.log('      (봇이 부팅되면 Outbox 스윕·송금 복구가 자동으로 처리합니다. 보류된 판은 /관리자 정산상태 에서 확인)');
  console.log(`\n${APPLY ? '✅ 완료' : 'ℹ️ 적용하려면 --apply 를 붙여 다시 실행하세요 (먼저 npm run backup 권장)'}\n`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('❌', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
