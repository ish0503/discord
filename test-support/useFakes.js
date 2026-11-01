/**
 * 단위 테스트용: discord.js · mongoose · dotenv를 test-support/stubs 로 바꿔 끼운다 (모든 모델이 인메모리 fakeMongo).
 * 반드시 src 모듈을 require 하기 전에 불러야 한다.
 *   const { M, reset } = require('../test-support/useFakes');
 */
const Module = require('node:module');
const path = require('node:path');

const STUBS = { 'discord.js': path.join(__dirname, 'stubs/discord.js'), mongoose: path.join(__dirname, 'stubs/mongoose.js'), dotenv: path.join(__dirname, 'stubs/dotenv.js') };
if (!Module._resolveFilename.__fakes) {
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (STUBS[request]) return STUBS[request];
    return orig.call(this, request, ...rest);
  };
  Module._resolveFilename.__fakes = true;
}
const mongoose = require('mongoose');

module.exports = {
  M: mongoose.models,
  /** 모든 인메모리 컬렉션 비우기 */
  reset: () => Object.values(mongoose.models).forEach((m) => m.reset?.()),
  /** 비동기 후속 작업(Outbox kick 등)이 끝나길 잠깐 기다림 */
  settle: (ms = 30) => new Promise((r) => setTimeout(r, ms)),
};
