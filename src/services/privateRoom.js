/**
 * 비공개 게임방 & 초대전.
 * - 초대 코드: 무작위 10자(약 50비트). DB에는 sha256(salt+code)만 저장, 비교는 상수 시간.
 *   유저당 10분에 5번 틀리면 잠금 + 감사 로그(room.code-bruteforce). 코드는 방장이 언제든 새로 발급 가능.
 * - 방장: 초대·승인·추방·설정·게임 시작·닫기. 결과·잔액은 바꿀 수 없다 (게임은 기존 로비·에스크로 정산 그대로).
 * - 방 판은 GameLog.detail.roomId 로 구분 → 전적에 🔒 표시, 랭크 리그·명예의 전당에서 제외.
 * - 관전 비허용 방은 비공개 스레드(멤버만)에서 진행.
 * - 관리자: 방 정보(멤버·게임 기록)를 /방 정보 로 볼 수 있고 모든 판은 감사 가능한 GameLog에 남는다.
 */
const crypto = require('node:crypto');
const PrivateRoom = require('../db/PrivateRoom');
const AuditLog = require('../db/AuditLog');
const GameLog = require('../db/GameLog');
const config = require('../config');

const R = config.ROOM;
const fail = (reason) => ({ ok: false, reason });
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O/1/I 제외
const failures = new Map(); // userId → { count, first }

function newCode() {
  const bytes = crypto.randomBytes(R.CODE_LENGTH);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}
const hashCode = (salt, code) => crypto.createHash('sha256').update(`${salt}:${String(code).trim().toUpperCase()}`).digest('hex');
function codeMatches(room, code) {
  const a = Buffer.from(hashCode(room.codeSalt, code), 'hex');
  const b = Buffer.from(room.inviteCodeHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validateSettings(gameType, s) {
  const amount = Number(s.amount);
  if (!['poker', 'tournament'].includes(gameType)) return fail('포커페이스 또는 토너먼트만 열 수 있어요.');
  if (!Number.isSafeInteger(amount) || amount < config.MIN_BET * 10 || amount > config.MAX_BET) return fail(`금액은 ${config.MIN_BET * 10} ~ ${config.MAX_BET} 사이예요.`);
  const cap = gameType === 'poker' ? config.POKER : config.TOURNAMENT;
  const bots = s.bots ?? 0;
  const maxHumans = s.maxHumans ?? 4;
  if (!Number.isInteger(bots) || bots < 0 || bots > cap.MAX_BOTS) return fail(`봇은 0~${cap.MAX_BOTS}명이에요.`);
  if (!Number.isInteger(maxHumans) || maxHumans < 2 || bots + maxHumans > cap.MAX_SEATS) return fail(`사람은 2명 이상, 봇+사람 ${cap.MAX_SEATS}명 이하예요.`);
  return { ok: true, settings: { amount, bots, maxHumans, stack: s.stack ?? config.TOURNAMENT.START_STACK } };
}

async function create({ guildId, ownerId, name, gameType, settings, spectators = true, approval = false, channelId = null }) {
  const n = String(name ?? '').trim();
  if (n.length < 2 || n.length > 30 || /@everyone|@here|<@/.test(n)) return fail('방 이름은 2~30자, 멘션 없이 적어 주세요.');
  const v = validateSettings(gameType, settings);
  if (!v.ok) return v;
  const openCount = await PrivateRoom.countDocuments({ guildId, ownerId, status: { $in: ['open', 'locked'] } });
  if (openCount >= R.MAX_OPEN_PER_OWNER) return fail(`방은 동시에 ${R.MAX_OPEN_PER_OWNER}개까지 열 수 있어요. \`/방 닫기\``);
  const code = newCode();
  const salt = crypto.randomBytes(8).toString('hex');
  const room = await PrivateRoom.create({
    roomId: crypto.randomUUID(),
    guildId,
    ownerId,
    name: n,
    gameType,
    inviteCodeHash: hashCode(salt, code),
    codeSalt: salt,
    approval,
    spectators,
    settings: v.settings,
    members: [ownerId],
    channelId,
    status: 'open',
    expiresAt: new Date(Date.now() + R.TTL_MS),
  });
  return { ok: true, room: room.toObject?.() ?? room, code }; // 코드 원문은 이때 방장에게 한 번만 보여 줌
}

const byId = (roomId) => PrivateRoom.findOne({ roomId }).lean();
const ownedOpen = (guildId, ownerId) => PrivateRoom.findOne({ guildId, ownerId, status: { $in: ['open', 'locked'] } }).sort({ createdAt: -1 }).lean();
const memberOf = (guildId, userId) => PrivateRoom.findOne({ guildId, members: userId, status: { $in: ['open', 'locked'] } }).sort({ createdAt: -1 }).lean();

function tooMany(userId, now = Date.now()) {
  const f = failures.get(userId);
  if (!f) return false;
  if (now - f.first > R.JOIN_FAIL_WINDOW_MS) {
    failures.delete(userId);
    return false;
  }
  return f.count >= R.JOIN_FAIL_LIMIT;
}

async function noteFailure(guildId, userId) {
  const now = Date.now();
  const f = failures.get(userId);
  if (!f || now - f.first > R.JOIN_FAIL_WINDOW_MS) failures.set(userId, { count: 1, first: now });
  else f.count += 1;
  if (failures.get(userId).count === R.JOIN_FAIL_LIMIT) {
    await AuditLog.create({ guildId, actorId: 'system', action: 'room.code-bruteforce', targetId: userId, reason: `비공개 방 초대 코드 ${R.JOIN_FAIL_LIMIT}회 연속 실패 — ${Math.round(R.JOIN_FAIL_WINDOW_MS / 60000)}분 잠금` }).catch(() => {});
  }
}

/** 코드로 참가 (코드 없이 부르면 초대받은 방으로) */
async function join({ guildId, userId, code = null }) {
  if (tooMany(userId)) return fail('초대 코드를 너무 많이 틀렸어요. 잠시 후 다시 시도해 주세요.');
  let room = null;
  if (code) {
    const rooms = await PrivateRoom.find({ guildId, status: 'open', expiresAt: { $gt: new Date() } }).lean();
    room = rooms.find((r) => codeMatches(r, code)) ?? null;
    if (!room) {
      await noteFailure(guildId, userId);
      return fail('맞는 방이 없어요. 코드를 확인해 주세요.');
    }
  } else {
    room = await PrivateRoom.findOne({ guildId, invited: userId, status: 'open', expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean();
    if (!room) return fail('초대받은 방이 없어요. 초대 코드를 입력해 주세요.');
  }
  if (room.members.includes(userId)) return { ok: true, room, already: true };
  const invited = room.invited.includes(userId);
  if (room.approval && !invited) {
    await PrivateRoom.updateOne({ roomId: room.roomId, status: 'open' }, { $addToSet: { pending: userId } });
    return { ok: true, room, pending: true };
  }
  const res = await PrivateRoom.updateOne({ roomId: room.roomId, status: 'open' }, { $addToSet: { members: userId }, $pull: { invited: userId, pending: userId } });
  if (!res.modifiedCount) return fail('방이 닫혔거나 잠겼어요.');
  return { ok: true, room: await byId(room.roomId) };
}

async function ownerOp(guildId, ownerId) {
  const room = await ownedOpen(guildId, ownerId);
  return room ?? null;
}

async function invite({ guildId, ownerId, targetId }) {
  const room = await ownerOp(guildId, ownerId);
  if (!room) return fail('내가 연 방이 없어요.');
  await PrivateRoom.updateOne({ roomId: room.roomId }, { $addToSet: { invited: targetId } });
  return { ok: true, room };
}

async function approve({ guildId, ownerId, targetId }) {
  const room = await ownerOp(guildId, ownerId);
  if (!room) return fail('내가 연 방이 없어요.');
  const res = await PrivateRoom.updateOne({ roomId: room.roomId, pending: targetId }, { $addToSet: { members: targetId }, $pull: { pending: targetId } });
  return res.modifiedCount ? { ok: true, room } : fail('대기 중인 참가 요청이 아니에요.');
}

async function kick({ guildId, ownerId, targetId }) {
  if (ownerId === targetId) return fail('방장은 `/방 닫기`를 쓰세요.');
  const room = await ownerOp(guildId, ownerId);
  if (!room) return fail('내가 연 방이 없어요.');
  const res = await PrivateRoom.updateOne({ roomId: room.roomId, members: targetId }, { $pull: { members: targetId, invited: targetId } });
  return res.modifiedCount ? { ok: true, room } : fail('방 멤버가 아니에요.');
}

async function leave({ guildId, userId }) {
  const room = await memberOf(guildId, userId);
  if (!room) return fail('참가한 방이 없어요.');
  if (room.ownerId === userId) return fail('방장은 `/방 닫기`를 쓰세요.');
  await PrivateRoom.updateOne({ roomId: room.roomId }, { $pull: { members: userId } });
  return { ok: true, room };
}

async function settings({ guildId, ownerId, spectators = null, approval = null, regenerate = false }) {
  const room = await ownerOp(guildId, ownerId);
  if (!room) return fail('내가 연 방이 없어요.');
  const set = {};
  if (spectators !== null) set.spectators = spectators;
  if (approval !== null) set.approval = approval;
  let code = null;
  if (regenerate) {
    code = newCode();
    set.codeSalt = crypto.randomBytes(8).toString('hex');
    set.inviteCodeHash = hashCode(set.codeSalt, code);
  }
  if (!Object.keys(set).length) return fail('바꿀 항목을 하나 이상 고르세요.');
  await PrivateRoom.updateOne({ roomId: room.roomId }, { $set: set });
  return { ok: true, room: await byId(room.roomId), code };
}

async function close({ guildId, ownerId }) {
  const room = await ownerOp(guildId, ownerId);
  if (!room) return fail('내가 연 방이 없어요.');
  await PrivateRoom.updateOne({ roomId: room.roomId }, { $set: { status: 'closed' } });
  return { ok: true, room };
}

/** 로비 참가 허용 검사 (멤버만) */
async function allowFor(roomId, userId) {
  const room = await byId(roomId);
  if (!room || room.status === 'closed') return '닫힌 비공개 방이에요.';
  return room.members.includes(userId) ? null : '🔒 비공개 방 멤버만 참가할 수 있어요. `/방 참가` 로 먼저 들어가세요.';
}

const recordGame = (roomId, gameId) => PrivateRoom.updateOne({ roomId }, { $addToSet: { games: gameId } });

/** 방 정보 + 방에서 한 판 기록 (분쟁 확인용) */
async function info(roomId) {
  const room = await byId(roomId);
  if (!room) return null;
  const logs = await GameLog.find({ 'detail.roomId': roomId }).sort({ createdAt: -1 }).limit(15).lean();
  return { room, logs };
}

/** 만료된 방 닫기 (주기 작업) */
async function sweep() {
  const res = await PrivateRoom.updateMany({ status: { $in: ['open', 'locked'] }, expiresAt: { $lt: new Date() } }, { $set: { status: 'closed' } });
  return res.modifiedCount;
}

module.exports = { create, join, invite, approve, kick, leave, settings, close, allowFor, recordGame, info, sweep, byId, ownedOpen, memberOf, hashCode, codeMatches, newCode, _failures: failures };
