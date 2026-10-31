/**
 * v1 → v2 마이그레이션 (서버별 경제·에스크로·게임 기록 확장)
 *
 *   node scripts/migrate-v2.js            # 드라이런: 바뀔 내용만 출력
 *   node scripts/migrate-v2.js --apply    # 실제 적용
 *
 * 하는 일
 *  1. 지갑(users)의 경제 키(guildId) 정리
 *     - ECONOMY_SCOPE=global  → 모든 지갑 guildId = 'global'
 *     - ECONOMY_SCOPE=guild   → v1에서 마지막으로 쓴 서버 ID를 그 지갑의 서버로 사용
 *                               (guildId가 없는 지갑은 'unassigned'로 표시 — 관리자가 확인)
 *  2. 에스크로 항목에 discordGuildId 채움 (복구 로그용)
 *  3. 기존 게임 기록(gamelogs)에 economyKey 채움 (랭킹·시즌 집계용)
 *  4. 인덱스 동기화: v1의 users.userId 고유 인덱스 삭제 → {userId, guildId} 고유 인덱스 생성
 *
 * 반드시 백업 후 실행하세요:  npm run backup
 */
require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');

const APPLY = process.argv.includes('--apply');
const MODELS = ['User', 'Profile', 'GameLog', 'GameState', 'Ledger', 'AuditLog', 'GuildConfig', 'Season', 'Tournament', 'Jackpot', 'Event', 'SystemState'];

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI 환경 변수가 필요합니다.');
  await mongoose.connect(process.env.MONGODB_URI);
  for (const m of MODELS) require(`../src/db/${m}`);
  const db = mongoose.connection.db;
  const global = config.ECONOMY.SCOPE === 'global';
  console.log(`\n🔧 v2 마이그레이션 ${APPLY ? '(적용)' : '(드라이런 — 변경 없음)'} · 경제 범위: ${config.ECONOMY.SCOPE}\n`);

  const users = db.collection('users');
  const total = await users.countDocuments();

  // 1. 경제 키
  const wrongKey = global ? { guildId: { $ne: 'global' } } : { $or: [{ guildId: { $exists: false } }, { guildId: null }, { guildId: '' }] };
  const n1 = await users.countDocuments(wrongKey);
  console.log(`1) 지갑 ${total}개 중 경제 키 정리 대상 ${n1}개 → ${global ? "'global'" : "'unassigned' (서버 정보 없는 v1 지갑)"}`);
  if (APPLY && n1) await users.updateMany(wrongKey, { $set: { guildId: global ? 'global' : 'unassigned' } });

  // 2. 에스크로 discordGuildId
  const n2 = await users.countDocuments({ escrow: { $elemMatch: { discordGuildId: { $exists: false } } } });
  console.log(`2) discordGuildId 없는 에스크로를 가진 지갑 ${n2}개`);
  if (APPLY && n2) {
    const cursor = users.find({ escrow: { $elemMatch: { discordGuildId: { $exists: false } } } });
    for await (const u of cursor) {
      const escrow = u.escrow.map((e) => ({ discordGuildId: u.guildId === 'global' ? null : u.guildId, ...e }));
      await users.updateOne({ _id: u._id }, { $set: { escrow } });
    }
  }

  // 3. 게임 기록 economyKey
  const logs = db.collection('gamelogs');
  const n3 = await logs.countDocuments({ economyKey: { $exists: false } });
  console.log(`3) economyKey 없는 게임 기록 ${n3}개`);
  if (APPLY && n3) {
    if (global) await logs.updateMany({ economyKey: { $exists: false } }, { $set: { economyKey: 'global' } });
    else await logs.updateMany({ economyKey: { $exists: false } }, [{ $set: { economyKey: '$guildId' } }]);
  }

  // 4. 인덱스
  const idx = await users.indexes().catch(() => []);
  const old = idx.find((i) => i.name === 'userId_1');
  console.log(`4) users 인덱스: ${idx.map((i) => i.name).join(', ') || '(없음)'}${old ? ' → userId_1 삭제 후 {userId, guildId} 고유 인덱스 생성' : ''}`);
  if (APPLY) {
    for (const m of MODELS) {
      const res = await mongoose.model(m).syncIndexes();
      if (res?.length) console.log(`   ${m}: 삭제된 인덱스 ${res.join(', ')}`);
    }
    // 중복 확인
    const dup = await users.aggregate([{ $group: { _id: { u: '$userId', g: '$guildId' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray();
    if (dup.length) console.warn(`   ⚠️ (userId, guildId) 중복 ${dup.length}건 — 고유 인덱스가 만들어지지 않았을 수 있습니다.`);
  }

  console.log(`\n${APPLY ? '✅ 완료' : 'ℹ️ 적용하려면 --apply 를 붙여 다시 실행하세요 (먼저 npm run backup 권장)'}\n`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('❌', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
