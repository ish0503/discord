const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeCollection, verify, readCollection } = require('../scripts/backupLib');

test('백업 파일: 기록 → 검증 통과 → 손상 감지', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  async function* docs(n) {
    for (let i = 0; i < n; i++) yield { _id: `u${i}`, money: i * 100, note: '한글 ✓' };
  }
  const users = await writeCollection(dir, 'users', docs(2500));
  const empty = await writeCollection(dir, 'events', docs(0));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), database: 't', collections: [users, empty] }));
  assert.equal(users.count, 2500);
  assert.equal((await verify(dir)).ok, true);

  let n = 0;
  for await (const d of readCollection(dir, users)) if (d.note === '한글 ✓') n++;
  assert.equal(n, 2500, '내용 보존');

  const f = path.join(dir, users.file);
  const buf = fs.readFileSync(f);
  buf[buf.length - 5] ^= 0xff; // 1바이트 손상
  fs.writeFileSync(f, buf);
  const bad = await verify(dir);
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0], /체크섬/);
});
