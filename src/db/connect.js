const mongoose = require('mongoose');

async function connectDB(uri) {
  mongoose.set('strictQuery', true);
  mongoose.connection.on('disconnected', () => console.warn('🍃 MongoDB 연결 끊김 — 자동 재연결 대기'));
  mongoose.connection.on('reconnected', () => console.log('🍃 MongoDB 재연결'));
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });
  console.log('🍃 MongoDB 연결 완료');
}

module.exports = { connectDB };
