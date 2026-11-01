const { Schema, model } = require('mongoose');

/**
 * 시스템 상태 문서 (_id로 구분)
 *   'main'   프로세스 생존 신호 — 이전 프로세스가 정상 종료했는지 판단 (비정상 종료 알림)
 *   'leader' 단일 인스턴스 리더 임대 (services/instanceLock.js)
 * ⚠️ Mongoose는 스키마에 없는 필드를 저장·조회 조건에서 조용히 버린다 → 쓰는 필드는 반드시 여기 선언할 것
 */
const systemStateSchema = new Schema({
  _id: { type: String, default: 'main' },
  instance: String,
  bootedAt: Date,
  lastHeartbeat: Date,
  cleanShutdown: Boolean,
  // 리더 임대
  leaseUntil: Date,
  renewedAt: Date,
  releasedAt: Date,
});

module.exports = model('SystemState', systemStateSchema);
