E2E 테스트 전용 스텁. `test-support/e2e.js`가 모듈 해석을 가로채 실제 discord.js / mongoose 대신 이 파일들을 쓴다.
- discord.js: 빌더를 기록만 하는 프록시
- mongoose: `../fakeMongo.js`의 인메모리 모델 (wallet이 쓰는 연산자를 MongoDB 의미대로 구현)
운영 코드에서는 절대 사용하지 않는다.
