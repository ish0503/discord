const { Schema, model } = require('mongoose');

/**
 * 정산 이벤트 Outbox.
 * 정산(지갑 갱신)과 같은 원자적 업데이트로 지갑 문서(User.outbox)에 먼저 기록된 뒤 이 컬렉션으로 옮겨진다.
 * 처리기는 등록된 핸들러(전적·미션·업적·기록 등)를 하나씩 실행하고, 완료한 핸들러를 done에 남긴다.
 *   → 재시작·재시도 시 끝난 핸들러는 다시 실행하지 않고, 각 핸들러도 eventId로 멱등하게 동작한다.
 * status: pending → processing → done  (실패: failed → 재시도, 한도 초과: dead → 관리자 확인)
 * 경제 기록이므로 TTL로 지우지 않는다.
 */
const outboxSchema = new Schema({
  eventId: { type: String, required: true, unique: true },
  type: { type: String, required: true }, // round.settled | round.refunded
  guildId: String, // 디스코드 서버 ID
  economyKey: String,
  userId: String,
  aggregateId: String, // roundId
  gameId: String,
  payload: { type: Schema.Types.Mixed, default: {} },
  status: { type: String, default: 'pending', index: true },
  attempts: { type: Number, default: 0 },
  done: { type: [String], default: [] },
  lastError: { type: String, default: null },
  nextAttemptAt: { type: Date, default: Date.now },
  leaseBy: { type: String, default: null },
  leaseUntil: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  processedAt: { type: Date, default: null },
});
outboxSchema.index({ status: 1, nextAttemptAt: 1 });
outboxSchema.index({ guildId: 1, createdAt: -1 });

module.exports = model('OutboxEvent', outboxSchema);
