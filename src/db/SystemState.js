const { Schema, model } = require('mongoose');

/** 프로세스 생존 신호 — 이전 프로세스가 정상 종료했는지 판단 (비정상 종료 알림) */
const systemStateSchema = new Schema({
  _id: { type: String, default: 'main' },
  instance: String,
  bootedAt: Date,
  lastHeartbeat: Date,
  cleanShutdown: Boolean,
});

module.exports = model('SystemState', systemStateSchema);
