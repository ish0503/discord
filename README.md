# 🎰 Discord Interactive Casino Bot

discord.js v14 + MongoDB(Mongoose) 기반 **가상 칩** 카지노 봇입니다.
모든 게임은 슬래시 명령어 → 인터랙티브 버튼 → 실시간 메시지 수정으로 진행되며,
결과는 `crypto` 기반 CSPRNG로 **선(先) 연산**된 뒤 연출만 순차적으로 공개됩니다.

> ⚠️ 이 봇의 칩은 현금·상품으로 환전할 수 없는 순수 게임 재화로만 운영하세요. 환전이 붙는 순간 사행행위 관련 법령의 적용을 받을 수 있습니다.

---

## 📁 프로젝트 구조

```
discord-casino-bot/
├── index.js                  # 진입점: 클라이언트, 인터랙션 라우터, 헬스 체크 서버
├── deploy-commands.js        # 수동 슬래시 명령어 등록 (npm run deploy)
├── package.json              # start 스크립트 & engines(node >=18)
├── .env.example              # 환경 변수 템플릿 (.env는 커밋 금지)
├── .gitignore
├── src/
│   ├── config.js             # 배당·확률·타이밍 등 모든 밸런스 상수
│   ├── registerCommands.js   # 명령어 로더 + REST 등록
│   ├── db/
│   │   ├── connect.js        # Mongoose 연결
│   │   └── User.js           # 유저 스키마 (userId, guildId, money, stats, updatedAt)
│   ├── services/
│   │   ├── sessions.js       # 인메모리 세션(Map) + 락 + idle 타이머
│   │   ├── wallet.js         # 잔고 조회/정산($inc 원자 연산)/지원금
│   │   └── shoes.js          # 채널별 공유 카드 슈 (블랙잭·바카라)
│   ├── engine/               # ⚙️ 순수 게임 로직 (discord.js 의존성 없음 → 단위 테스트 가능)
│   │   ├── cards.js          # 덱 생성, Shoe 클래스, Hi-Lo 카운팅
│   │   ├── blackjack.js
│   │   ├── slot.js
│   │   ├── crash.js
│   │   ├── dice.js
│   │   ├── poker.js          # 7장 핸드 평가기 + 몬테카를로 딜러 AI
│   │   └── baccarat.js       # 서드 카드 규칙
│   ├── commands/             # 🕹️ 슬래시 명령어 + 버튼 핸들러 (UI 담당)
│   │   ├── blackjack.js      # /블랙잭
│   │   ├── slot.js           # /슬롯
│   │   ├── crash.js          # /그래프
│   │   ├── dice.js           # /주사위
│   │   ├── poker.js          # /포커페이스
│   │   ├── baccarat.js       # /바카라
│   │   └── balance.js        # /잔고 (전적 + 파산 지원금)
│   └── utils/
│       ├── rng.js            # crypto 기반 난수, 셔플, 가중치 추첨
│       ├── liveMessage.js    # 레이트 리밋 대응 실시간 편집기 (latest-wins)
│       └── format.js         # 칩/카드 표기, 공통 응답
└── test/
    └── engine.test.js        # 확률·족보·정산 검증 (npm test)
```

**레이어 원칙:** `engine/`은 숫자만 다루고, `commands/`는 화면만 그리며, DB 접근은 `wallet.js` 한 곳에서만 합니다.

---

## 🧠 아키텍처: 메모리 세션 → 종료 시 1회 정산

```
/명령어 ─▶ sessions.start(userId)       ← 유저당 동시 1게임 (잔고 이중 사용 차단)
            │  덱·그래프·팟 등 진행 상태는 전부 Map 안의 세션 객체에만 존재
버튼 클릭 ─▶ sessions.run(session, fn)  ← 연타 방지 락, idle 타이머 갱신
            │
게임 종료 ─▶ wallet.settle(net)         ← MongoDB에 $inc 한 번 (원자적)
            └▶ sessions.end()
```

- **판돈 검사:** 시작 시점에 잔고를 읽고, 진행 중 추가 베팅(더블·레이즈)은 그 스냅샷으로 검사합니다.
- **무반응 처리:** 블랙잭 60초 → 자동 스탠드, 포커 90초 → 자동 다이, 슬롯/주사위/바카라 → 테이블 종료.
- **재시작 시:** 메모리 세션은 사라지지만 아직 정산 전이므로 **잔고 손실은 없습니다.** 남은 버튼을 누르면 "만료된 게임" 안내가 뜹니다.
- **버튼 소유권:** `customId = prefix:ownerId:action:arg` 형식이라 남의 게임 버튼은 라우터에서 차단됩니다.

### 실시간 편집과 레이트 리밋
디스코드는 메시지 편집 빈도를 제한하므로, 0.2초마다 무조건 `edit`을 보내면 요청이 큐에 쌓여 화면이 점점 뒤처집니다.
`LiveMessage`는 **편집 중이면 최신 프레임 하나만 보관**하고 끝나면 그것만 보내므로, 화면은 API가 허용하는 최대 속도로 항상 최신 상태를 따라갑니다.
그래프의 실제 배수는 화면이 아니라 **서버 시각 기반 공식**(`m(t) = e^(k·t)`)으로 계산되고, 캐시아웃은 버튼을 누른 순간의 서버 시각으로 정산됩니다.

---

## 🕹️ 게임 사양 요약

| 명령어 | 핵심 로직 | 판독 포인트 |
|---|---|---|
| `/블랙잭` | 6덱(312장) 슈, 60장 이하 재셔플, Hi-Lo 카운팅, S17, BJ 3:2, 더블 | 계기판의 Running/True Count 원시 수치만 표시 |
| `/슬롯 금액` | 🍒40 🍋30 🔔20 💎8 7️⃣2 가중치, 결과 선 연산 후 0.4초 간격 릴 공개 | — |
| `/그래프 금액` | `crashPoint = max(1, 0.97/U)`, 0.2초 틱 + in-flight 스로틀 | 배수·상승 속도·로그 스케일 그래프 |
| `/주사위 금액` | 2d6 정확 확률, 4연패 이상 시 재굴림 보정 | Lo/7/Hi 확률·배당 표시 |
| `/포커페이스 금액` | 홀덤 7장 평가기, 몬테카를로 승률·메이드 확률 기반 딜러 블러핑 | 베팅 로그 & 보드 텍스처, 종료 후 딜러 의도 공개 |
| `/바카라 금액` | 8덱 슈, 정식 서드 카드 규칙 | 채널 공유 흐름 보드(최근 5판·연속·누적) |
| `/잔고` | 전적 조회, 잔고 1,000 미만 시 24시간 1회 지원금 | — |

> 사양서의 슬롯 가중치(🍒40 🍋30 💎8 7️⃣2)는 합이 80%라서, 남는 20%를 🔔로 채웠습니다.

### 📊 이론 환수율(RTP) — `src/config.js`에서 조정

| 게임 | 기본 설정 | RTP | 비고 |
|---|---|---|---|
| 슬롯 | 🍒×3 · 🍋×8 · 🔔×15 · 💎×100 · 7️⃣×777 · 🍒🍒×1.25 | **94.5%** | 정확 계산값, 테스트로 검증 |
| 그래프 | 하우스 엣지 3% | **97%** | 어느 시점에 탈출해도 동일 |
| 주사위 Hi/Lo | ×2 (확률 41.7%) | **83.3%** | ×2.3으로 올리면 95.8% |
| 주사위 7 | ×5 (확률 16.7%) | **83.3%** | ×5.7로 올리면 95.0% |
| 바카라 | P ×2 / B ×1.95 / T ×9 | 98.8% / 98.9% / 85.6% | 실제 카지노 표준 |
| 블랙잭 | S17, 3:2, 더블 | 약 99% 내외 | 스플릿 미지원이라 표준 룰보다 조금 불리, True Count가 높으면 유저 우위 가능 |

사양서의 주사위 배당(Hi/Lo 2배, 7 4~5배)은 하우스 엣지가 16~33%로 다른 게임보다 훨씬 큽니다. 의도된 설계가 아니라면 `DICE.PAYOUT`을 위 값으로 올리는 것을 권장합니다.

**연패 보정(Dynamic Balancing):** 4연패 이상이면 패배 결과를 15% 확률로 1회 재굴림합니다. 보정 중 Hi 승률은 41.7% → 45.3%, 7 적중률은 16.7% → 18.8%가 됩니다 (`npm test`로 검증).
유저에게 보이지 않는 확률 조정이므로, 공정성을 위해 `DICE.ASSIST.SHOW_TO_USER: true` 로 발동 사실을 표시하는 옵션을 넣어 두었습니다.

---

## 🔧 1단계 — 디스코드 봇 만들기

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**
2. **General Information** → `Application ID` 복사 → `CLIENT_ID`
3. **Bot** 탭 → **Reset Token** → 토큰 복사 → `DISCORD_TOKEN` (한 번만 보이니 바로 보관)
   - Privileged Gateway Intents는 **모두 꺼둔 상태로 OK** (슬래시 명령어만 사용)
4. **OAuth2 → URL Generator**
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `View Channels`, `Send Messages`, `Embed Links`, `Read Message History`
   - 생성된 URL로 서버에 초대

## 🍃 2단계 — MongoDB Atlas

1. [MongoDB Atlas](https://www.mongodb.com/atlas)에서 무료 클러스터 생성
2. **Database Access** → DB 유저 생성 (비밀번호에 `@ : /` 등이 있으면 URL 인코딩 필요)
3. **Network Access** → `0.0.0.0/0` 허용 (Koyeb의 아웃바운드 IP는 고정이 아님)
4. **Connect → Drivers** → 연결 문자열 복사, 호스트 뒤에 DB 이름(`/casino`)을 붙여 `MONGODB_URI`로 사용

## 💻 3단계 — 로컬 실행

```bash
npm install
cp .env.example .env      # 값 채우기 (DEV_GUILD_ID를 넣으면 명령어가 즉시 반영됨)
npm test                  # 엔진 확률 검증
npm start
```

## 🐙 4단계 — GitHub 업로드

```bash
git init
git add .
git commit -m "init: discord casino bot"
git branch -M main
git remote add origin https://github.com/<계정>/discord-casino-bot.git
git push -u origin main
```
`.env`는 `.gitignore`에 들어 있어 올라가지 않습니다. 토큰이 실수로 커밋되면 즉시 Developer Portal에서 **Reset Token** 하세요.

## 🚀 5단계 — Koyeb 배포 (GitHub 연동 + Buildpack)

1. Koyeb 대시보드 → **Create Service** → **GitHub** → 저장소 선택, 브랜치 `main`
2. **Builder: Buildpack** — `package.json`의 `engines`로 Node 버전을, `scripts.start`로 실행 명령(`npm start` → `node index.js`)을 자동 인식합니다.
3. **Environment variables** — 토큰류는 Secret으로 등록

   | 키 | 값 |
   |---|---|
   | `DISCORD_TOKEN` | (Secret) 봇 토큰 |
   | `MONGODB_URI` | (Secret) Atlas 연결 문자열 |
   | `CLIENT_ID` | Application ID |
   | `REGISTER_COMMANDS` | `true` (부팅 시 명령어 자동 등록 — Koyeb엔 셸이 없으므로 권장) |
   | `DEV_GUILD_ID` | (선택) 테스트 서버 ID. 운영 시엔 비워서 전역 등록 |

4. **서비스 타입**
   - **Web Service**로 만들 경우: 포트 `8000`을 노출하고 헬스 체크를 이 포트로 지정하세요. `index.js`에 헬스 체크용 HTTP 서버가 내장되어 있습니다.
   - **Worker**로 만들 경우: 포트 설정 없이 그대로 동작합니다.
5. **인스턴스는 반드시 1개로 고정**하세요. 세션이 프로세스 메모리에 있으므로 2개 이상이면 같은 봇이 이중 로그인되어 버튼 처리가 꼬입니다. 트래픽이 없을 때 인스턴스를 재우는 기능(scale-to-zero/sleep)이 켜져 있다면 꺼야 봇이 오프라인이 되지 않습니다.
6. **Deploy** → 로그에 `✅ 로그인`, `📝 슬래시 명령어 N개 등록`이 보이면 완료. 이후 `main`에 push할 때마다 자동 재배포됩니다.

> 전역 명령어는 디스코드 쪽 반영에 시간이 걸릴 수 있습니다. 개발 중엔 `DEV_GUILD_ID`를 쓰면 즉시 반영됩니다.

---

## 🛠️ 커스터마이징 & 확장 아이디어

- 모든 수치는 `src/config.js` 한 곳에서 수정 → `npm test`로 RTP 확인
- 서버별 독립 지갑이 필요하면 `User` 스키마의 unique 인덱스를 `{ userId: 1, guildId: 1 }` 복합 인덱스로 바꾸고 `wallet.js`의 조회 조건에 `guildId`를 추가
- 블랙잭 스플릿·인슈어런스, 그래프 자동 캐시아웃, `/랭킹`(money 내림차순 집계) 등은 기존 세션 패턴 그대로 추가 가능
- 다중 인스턴스 확장이 필요해지면 세션 저장소를 Redis로 옮기고 discord.js 샤딩 적용
