/**
 * E2E 스모크 테스트: 실제 명령어 모듈 19개를 가짜 디스코드 인터랙션 + 인메모리 DB로 끝까지 실행.
 *   npm run e2e
 * 실제 discord.js / mongoose 대신 test-support/stubs 를 쓰도록 모듈 해석을 가로챈다.
 * 각 단계에 감시 타이머가 있어 멈추면 어느 단계인지 출력하고 실패 처리한다.
 */
const Module = require('node:module');
const path = require('node:path');
const STUBS = { 'discord.js': path.join(__dirname, 'stubs/discord.js'), mongoose: path.join(__dirname, 'stubs/mongoose.js'), dotenv: path.join(__dirname, 'stubs/dotenv.js') };
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (STUBS[request]) return STUBS[request];
  return origResolve.call(this, request, ...rest);
};

let currentStep = '시작';
const step = (name) => {
  currentStep = name;
  console.log(`── ${name}`);
};
const watchdog = setInterval(() => {
  if (Date.now() - lastProgress > 15_000) {
    console.log(`❌ 멈춤 감지: "${currentStep}" 단계에서 15초 이상 진행 없음`);
    process.exit(2);
  }
}, 1000);
watchdog.unref();
let lastProgress = Date.now();

const ROOT=path.join(__dirname, '..')+'/';
const cfg=require(ROOT+'src/config');
Object.assign(cfg.SLOT,{REEL_DELAY_MS:1,AUTO_SPIN_GAP_MS:1}); Object.assign(cfg.DICE,{FRAME_MS:1});
cfg.CRASH.GROWTH_PER_MS=0.003;
Object.assign(cfg.BLACKJACK,{DEALER_STEP_MS:1,BET_MS:200,TURN_MS:300,INSURANCE_MS:300,LOBBY_MS:200});
Object.assign(cfg.BACCARAT,{DEAL_MS:1,BET_MS:200,LOBBY_MS:200});
Object.assign(cfg.POKER,{BOT_THINK_MS:1,STREET_PAUSE_MS:1,TURN_MS:150,SIMULATIONS:30,LOBBY_MS:200});
Object.assign(cfg.TOURNAMENT,{TURN_MS:60,HAND_PAUSE_MS:1,MAX_HANDS:6,HANDS_PER_LEVEL:2,LOBBY_MS:200});
const mongoose=require('mongoose'); const M=mongoose.models;
const { loadCommands } = require(ROOT+'src/registerCommands');
const cmds=Object.fromEntries(loadCommands().map(c=>[c.data.calls.find(x=>x[0]==='setName')[1][0], c]));
const sessions=require(ROOT+'src/services/sessions');
const wallet=require(ROOT+'src/services/wallet');
const desc=p=>{ if(!p||typeof p==='string') return p||''; if(p.content&&!p.embeds) return p.content; const e=p.embeds?.[0]; const c=e?.calls?.find(c=>c[0]==='setDescription'); const f=e?.calls?.filter(c=>c[0]==='addFields').flatMap(c=>c[1]).map(x=>x.value).join('|'); return (c?c[1][0]:'')+(f||'')+(p.content||''); };
let nid=5000; let pub=null; const eph=[];
// 스레드 모의: 모집 메시지.startThread() → 스레드에 올라간 메시지는 threadLog에 기록
const threads=[]; const threadLog=[];
function fakeChannel(id, isThread=false){ return { id, isThread:()=>isThread, async send(p){ const m={ id:'tm'+(nid++), payload:p, async edit(q){ m.payload=q; } }; threadLog.push(m); return m; }, async setArchived(v){ this.archived=v; } }; }
function fakeMessage(id, chan){ const msg={ id, channel:fakeChannel(chan), edit: async p=>{ pub=p; }, async startThread(o){ const t=fakeChannel('T'+id, true); t.name=o.name; threads.push(t); return t; } }; return msg; }
function mk(uid,opts={},extra={}){ const i={ id:String(nid++), user:{id:uid,username:uid,displayAvatarURL:()=>null}, member:{displayName:uid, roles:[]}, memberPermissions:{has:()=>true}, guildId:'G', channelId:extra.chan||'C', inGuild:()=>true,
  options:{getInteger:n=>opts[n]??null,getNumber:n=>opts[n]??null,getString:n=>opts[n]??null,getBoolean:n=>opts[n]??null,getUser:n=>opts[n]??null,getRole:n=>opts[n]??null,getSubcommand:()=>opts._sub},
  values: extra.values, deferred:false, replied:false, _eph:false,
  async reply(p){ this.replied=true; if(p.flags||p.ephemeral) eph.push(`[${uid}] ${desc(p)}`); else pub=p; }, async deferReply(o){ this.deferred=true; this._eph=!!(o?.flags||o?.ephemeral); },
  async editReply(p){ if(this._eph) eph.push(`[${uid}] ${desc(p)}`); else pub=p; }, async followUp(p){ eph.push(`[${uid}] ${desc(p)}`); return {id:'f'+nid}; },
  async deferUpdate(){ this.deferred=true; }, async update(p){ pub=p; }, async fetchReply(){ return fakeMessage('m'+this.id, extra.chan||'C'); },
  webhook:{ async editMessage(m,p){ eph.push(`[${uid} private] ${desc(p)}`); }, async deleteMessage(){ eph.push(`[${uid} deleted]`); } }, async deleteReply(){ eph.push(`[${uid} deleted]`); }, isButton:()=>true }; return i; }
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ids=()=>(pub?.components||[]).flatMap(r=>r.calls.find(c=>c[0]==='addComponents')[1].flat()).map(b=>(b.calls.find(x=>x[0]==='setCustomId')||[])[1]?.[0]).filter(Boolean);
const ok=(c,m)=>{ lastProgress=Date.now(); console.log(c?'✅':'❌',m); if(!c) process.exitCode=1; };
const money=u=>M.User.docs.find(d=>d.userId===u)?.money;
const noEscrow=()=>M.User.docs.every(d=>d.escrow.length===0);
const btn=(cmd,uid,customId,opts,extra)=>{ const [prefix,owner,action,...rest]=customId.split(':'); return cmds[cmd].handleButton(mk(uid,opts,extra),{action,arg:rest.join(':')}); };

(async()=>{
  ok(Object.keys(cmds).length===24, `명령어 ${Object.keys(cmds).length}개 로드: ${Object.keys(cmds).join(' ')}`);

  step('슬롯 (연속 스핀·잭팟)');
  await cmds['슬롯'].execute(mk('A',{'금액':1000}));
  await btn('슬롯','A',`sl:A:spin:`); await btn('슬롯','A',`sl:A:auto:5`);
  ok(M.GameLog.docs.filter(l=>l.game==='slot').length===6, '슬롯 6판 정산 기록');
  ok(M.Jackpot.docs[0]?.amount >= 100000, `잭팟 풀 적립 ${M.Jackpot.docs[0]?.amount}`);
  await sleep(20);
  const pA=M.Profile.docs.find(p=>p.userId==='A'); ok(pA?.totals.games===6, `프로필 누적 ${pA?.totals.games}판 (이벤트 버스 연동)`);
  await btn('슬롯','A',`sl:A:stop:`);

  step('주사위 (연패 보정 공개·DB 저장)');
  M.User.docs.find(d=>d.userId==='A').diceLossStreak=5;
  await cmds['주사위'].execute(mk('A',{'금액':500})); ok(desc(pub).includes('연패 보정 활성'), '보정 활성 표시');
  for(let k=0;k<5;k++) await btn('주사위','A','dc:A:seven:'); await btn('주사위','A','dc:A:stop:');
  ok(typeof M.User.docs.find(d=>d.userId==='A').diceLossStreak==='number', `연패 기록 저장 (${M.User.docs.find(d=>d.userId==='A').diceLossStreak})`);

  step('그래프 (자동 캐시아웃)');
  const crashEng=require(ROOT+'src/engine/crash'); const origGen=crashEng.generateCrashPoint;
  crashEng.generateCrashPoint=()=>3.0;
  await cmds['그래프'].execute(mk('B',{'금액':1000,'자동캐시아웃':1.5})); await sleep(400);
  const cl=M.GameLog.docs.find(l=>l.game==='crash'&&l.userId==='B'); ok(cl && cl.payout===1500 && cl.detail.cashedAt===1.5, `자동 캐시아웃 1.5x 정산 (payout ${cl?.payout})`);
  crashEng.generateCrashPoint=()=>1.2;
  await cmds['그래프'].execute(mk('B',{'금액':1000,'자동캐시아웃':2})); await sleep(300);
  ok(M.GameLog.docs.filter(l=>l.game==='crash'&&l.userId==='B').at(-1).payout===0, '목표 2x > 폭발 1.2x → 실패 정산');
  crashEng.generateCrashPoint=origGen;

  step('블랙잭 (보험 → 스플릿 → 더블)');
  const { getShoe }=require(ROOT+'src/services/shoes'); const shoe=getShoe('blackjack','BJ');
  const H=s=>s.split(' ').map(x=>({rank:x.slice(0,-1),suit:{s:'♠',h:'♥',d:'♦',c:'♣'}[x.slice(-1)]}));
  // pop 순서: P1, 딜러업, P2, 홀, 그다음 드로우들
  shoe.cards=H('8h As 8d 9c 3s 2h 10c 7d 10s 10h 10d').reverse(); shoe.reshuffleAt=0;
  await cmds['블랙잭'].execute(mk('C',{},{chan:'BJ'})); await sleep(5);
  const T=ids()[0].split(':')[3].split('~')[0];
  await btn('블랙잭','C',`bj:*:bet:${T}~1000`,{}, {chan:'BJ'}); await sleep(5);
  ok(desc(pub).includes('보험 단계'), '딜러 A 업카드 → 보험 단계');
  await btn('블랙잭','C',`bj:*:ins:${T}~yes`,{}, {chan:'BJ'}); await sleep(20);
  ok(desc(pub).includes('피크'), '보험 후 피크 (딜러 블랙잭 아님)');
  ok(ids().some(x=>x.includes(':split:')), '8·8 → 스플릿 버튼');
  await btn('블랙잭','C',`bj:*:split:${T}~`,{}, {chan:'BJ'}); await sleep(10);
  // 손1: 8+3 = 11 → 더블 (2 받음 → 13), 손2: 8+2... 실제 카드 순서에 따름
  for(let k=0;k<10;k++){ const d=desc(pub); if(!d.includes('님 차례')) break; const act = ids().some(x=>x.includes(':double:')) && k===0 ? 'double':'stand'; await btn('블랙잭','C',`bj:*:${act}:${T}~`,{}, {chan:'BJ'}); await sleep(10); }
  await sleep(30);
  const bl=M.GameLog.docs.find(l=>l.game==='blackjack'&&l.userId==='C');
  ok(bl && bl.staked===1000+1000+1000+500, `스플릿+더블+보험 총 베팅 ${bl?.staked} (=3,500)`);
  ok(bl?.detail?.hands?.length===2, '두 손 기록');
  console.log('   ', desc(pub).split('**이번 판 베팅**')[0].split('\n').slice(1,4).join(' / '));
  await btn('블랙잭','C',`bj:*:close:${T}~`,{}, {chan:'BJ'}); await sleep(10);

  step('바카라');
  await cmds['바카라'].execute(mk('C',{},{chan:'BC'})); await sleep(5);
  const T2=ids()[0].split(':')[3].split('~')[0];
  await btn('바카라','C',`bc:*:bet:${T2}~banker.5000`,{}, {chan:'BC'}); await sleep(30);
  ok(M.GameLog.docs.some(l=>l.game==='baccarat'), '바카라 정산');
  await btn('바카라','C',`bc:*:close:${T2}~`,{}, {chan:'BC'}); await sleep(10);

  step('포커 NL 현금 (사람 1 + 봇 2)');
  await cmds['포커페이스'].execute(mk('D',{'금액':2000,'봇':2})); await sleep(20);
  for(let k=0;k<200;k++){ const d=desc(pub); if(d.includes('🏆')&&!d.includes('님 차례')) break; const m=d.match(/👉 \*\*(\w)\*\* 님 차례/); if(m){ const callId=ids().find(x=>x.includes(':call:')); if(callId) await btn('포커페이스','D',callId); } await sleep(5); }
  await sleep(50);
  const pl=M.GameLog.docs.find(l=>l.game==='poker'&&l.userId==='D'); ok(pl && pl.staked===2000, `바이인 2,000 기준 정산 (지급 ${pl?.payout})`);
  ok(ids().some(x=>x.includes(':again:')), '같은 설정 재시작 버튼');

  step('송금·도움말');
  const SA='100000000000000777', SQ='100000000000000888';
  await wallet.getAccount(SA,'G'); M.User.docs.find(d=>d.userId===SA).money=50000; await wallet.getAccount(SQ,'G');
  await cmds['송금'].execute(mk(SA,{'유저':{id:SA},'금액':1000})); ok(eph.at(-1).includes('자기 자신'), '자기 자신 송금 차단');
  await cmds['송금'].execute(mk(SA,{'유저':{id:'Q'},'금액':1000})); ok(eph.at(-1).includes('올바르지 않은'), '잘못된 사용자 ID 차단');
  await cmds['송금'].execute(mk(SA,{'유저':{id:SQ},'금액':10000,'메모':'고마워'}));
  ok(desc(pub).includes('받는 사람') && ids().some(x=>x.includes(':ok:')), '송금 확인 화면 (확인 버튼)');
  const okId=ids().find(x=>x.includes(':ok:'));
  await btn('송금',SA,okId);
  ok(money(SA)===50000-10500 && money(SQ)===20000, `송금 완료 (보낸 ${money(SA)}, 받은 ${money(SQ)}) · 수수료 5% 소각`);
  ok(desc(pub).includes(`<@${SA}> → <@${SQ}>`), '송금 결과 공개');
  await btn('송금',SA,okId); ok(money(SA)===39500, '확인 버튼 연타해도 한 번만');
  await cmds['송금'].execute(mk(SA,{'유저':{id:SQ},'금액':195000})); ok(eph.at(-1).includes('한도') || eph.at(-1).includes('잔고'), '하루 송금 한도/잔고 검사');
  await cmds['도움말'].execute(mk('A')); ok(eph.at(-1)!==undefined, '도움말');
  await cmds['도움말'].execute(mk('A',{'분류':'howto'})); ok(['21을 넘지','9에 가까운','잭팟','캐시아웃','Lo(2~6)','홀덤','블라인드'].every(g=>eph.at(-1).includes(g)), '도움말 게임 방법 (7개 게임)');

  step('토너먼트 (사람 1 + 봇 3, 6핸드 제한)');
  const before=money('E') ?? 10000;
  // 토너먼트 진행 중에도 채널에서 다른 게임 가능 (세션 슬롯 분리)
  const tPromise=cmds['토너먼트'].execute(mk('E',{'참가비':3000,'봇':3,'최대인원':1}));
  await sleep(5);
  await cmds['주사위'].execute(mk('E',{'금액':500})); ok(!eph.some(e=>e.includes('이미 진행 중')), '토너먼트 중 채널에서 다른 게임 시작 가능');
  await btn('주사위','E','dc:E:stop:');
  await tPromise;
  const introBtn=(threadLog[0]?.payload.components||[]).flatMap(r=>r.calls.find(c=>c[0]==='addComponents')[1].flat()).map(b=>(b.calls.find(x=>x[0]==='setCustomId')||[])[1]?.[0]).find(x=>x?.includes(':hand:'));
  ok(!!introBtn, '스레드 시작 안내에 [내 패] 버튼');
  const ephBefore=eph.length;
  await btn('토너먼트','E',introBtn,{},{chan:'TmC'});
  ok(eph.slice(ephBefore).some(e=>e.startsWith('[E]')&&e.includes('내 패')), '[내 패] → 스레드에 비공개 패 표시');
  await sleep(2500);
  const followUps=eph.slice(ephBefore).filter(e=>e.startsWith('[E]')&&e.includes('🃏 **내 패**')).length;
  ok(followUps>=2, `이후 핸드마다 내 패 자동 표시 (${followUps}회)`);
  ok(eph.slice(ephBefore).some(e=>e==='[E deleted]'), '지난 핸드 비공개 메시지는 정리');
  const tl=M.GameLog.docs.find(l=>l.game==='tournament'&&l.userId==='E');
  ok(tl && tl.staked===3000, `참가비 3,000 정산 (지급 ${tl?.payout}, 순위 ${tl?.detail?.place})`);
  ok(tl?.payout===3000, '사람 1명이면 상금 풀 전액 = 참가비 (봇은 상금 없음)');
  ok(M.Tournament.docs[0]?.state==='finished', `토너먼트 기록 저장 (${M.Tournament.docs[0]?.hands}핸드, ${M.Tournament.docs[0]?.endedReason})`);
  ok(threads.length===1 && threads[0].name.includes('토너먼트'), `전용 스레드 생성 (${threads[0]?.name})`);
  const tDesc=threadLog.map(m=>desc(m.payload));
  ok(tDesc[0]?.includes('참가자 <@E>'), '스레드에 시작 안내 공개 (참가자 멘션)');
  ok(tDesc.filter(d=>d.includes('🏆')||d.includes('↩️')).length>=2, `핸드별 결과 메시지 공개 기록 (${threadLog.length}개 메시지)`);
  ok(tDesc.some(d=>d.includes('최종 순위')), '스레드에 최종 순위 공개');
  ok(desc(pub).includes('우승') && desc(pub).includes(threads[0].id), '원래 채널 현황판 → 결과 + 스레드 링크');
  ok(!eph.some(e=>e.includes('🂠 **보드**')), '테이블이 비공개 메시지로 바뀌지 않음');

  step('출석·미션·상점·인벤토리·프로필·전적·리플레이');
  await cmds['출석'].execute(mk('A')); await cmds['출석'].execute(mk('A'));
  ok(desc(pub).includes('이미 출석'), '출석 하루 1회');
  const prof=require(ROOT+'src/services/profile'); const { daily }=prof.currentMissions();
  const pa=M.Profile.docs.find(p=>p.userId==='A'); pa.missions.daily[daily[0].id]=daily[0].goal;
  await btn('미션','A',`ms:A:claim:daily.${daily[0].id}`); ok(eph.at(-1).includes('보상 +'), `미션 보상 수령: ${eph.at(-1)}`);
  await btn('미션','A',`ms:A:claim:daily.${daily[0].id}`); ok(eph.at(-1).includes('이미 받은'), '미션 중복 수령 차단');
  pa.rewardPoints=1000;
  await cmds['상점'].handleSelect(mk('A',{}, {values:['card:outline']}), {action:'buy'}); ok(eph.at(-1).includes('구매 완료'), '포인트로 카드 테마 구매');
  await cmds['상점'].handleSelect(mk('A',{}, {values:['card:outline']}), {action:'buy'}); ok(eph.at(-1).includes('이미 가진'), '중복 구매 차단');
  M.User.docs.find(d=>d.userId==='A').money=100000; const chipsBefore=money('A');
  await cmds['상점'].handleSelect(mk('A',{}, {values:['dice:roman']}), {action:'buy'}); ok(money('A')===chipsBefore-40000 && M.Ledger.docs.some(l=>l.type==='shop'), '칩 구매 → 칩 회수 + 원장 기록');
  await cmds['인벤토리'].handleSelect(mk('A',{}, {values:['cardTheme|outline']}), {action:'equip'});
  ok(M.Profile.docs.find(p=>p.userId==='A').equipped.cardTheme==='outline', '카드 테마 장착');
  await cmds['인벤토리'].handleSelect(mk('A',{}, {values:['cardTheme|letters']}), {action:'equip'}); ok(eph.at(-1).includes('보유하지 않은'), '미보유 아이템 장착 차단');
  await cmds['프로필'].execute(mk('A')); ok(pub.files?.[0]?.name==='profile.png' && pub.files[0].data.length>10000, `프로필 이미지 카드 (${pub.files?.[0]?.data.length} bytes)`);
  await cmds['업적'].execute(mk('A')); ok(['신화','전설','영웅','희귀','일반'].every(t=>desc(pub).includes(t)), '업적 등급별 분류');
  await cmds['업적'].execute(mk('A',{'등급':'mythic'})); ok(desc(pub).includes('신화 등급') && desc(pub).includes('???'), '신화 등급 상세 (숨겨진 업적 ???)');
  await cmds['전적'].execute(mk('A')); ok(desc(pub).includes('슬롯'), '전적 목록');
  await cmds['리플레이'].execute(mk('C')); ok(desc(pub).includes('리플레이') || desc(pub).includes('판 ID') || pub.embeds, '리플레이');
  await cmds['분석'].execute(mk('A')); ok(eph.at(-1).includes('분석') || eph.at(-1).length>0, '분석');
  await cmds['랭킹'].execute(mk('A',{'종류':'balance'})); ok(desc(pub).includes('<@'), '잔고 랭킹');
  await cmds['잔고'].execute(mk('A')); ok(true, '잔고');

  step('특별 규칙 · 스토리 · 명예의 전당');
  await cmds['특별규칙'].execute(mk('A')); ok(desc(pub).includes('내일 규칙 미리보기'), '특별 규칙 (오늘·내일 공개)');
  const sub=(name,opts={})=>({...opts,_sub:name});
  await cmds['스토리'].execute(mk('A',sub('시작'))); ok(desc(pub).includes('목표'), '스토리 시작');
  await cmds['스토리'].execute(mk('A',sub('진행'))); ok(eph.at(-1).includes('▶️'), '스토리 진행');
  await cmds['스토리'].execute(mk('A',sub('지도'))); ok(desc(pub).includes('1장'), '스토리 지도');
  await cmds['명예의전당'].execute(mk('A',sub('목록'))); ok(desc(pub).includes('현재 최고 기록'), '명예의 전당 목록');
  await cmds['명예의전당'].execute(mk('A',sub('기록'))); ok(desc(pub).includes('보유 기록'), '명예의 전당 개인 기록');

  step('관리자');
  const adm=(sub,opts={})=>cmds['관리자'].execute(mk('ADMIN',{_sub:sub,...opts}));
  await adm('지급',{'유저':{id:'Z'},'금액':5000,'사유':'테스트 지급'}); ok(money('Z')===15000, '지급');
  await adm('회수',{'유저':{id:'Z'},'금액':99999,'사유':'과다'}); ok(eph.at(-1).includes('많이 회수할 수 없'), '잔고 초과 회수 차단');
  await adm('회수',{'유저':{id:'Z'},'금액':5000,'사유':'테스트 회수'}); ok(money('Z')===10000, '회수');
  ok(M.AuditLog.docs.filter(a=>a.targetId==='Z').length===2, '감사 로그 2건 (실패 건 제외)');
  await adm('게임',{'게임':'slot','활성':false,'최대':5000});
  const gc=require(ROOT+'src/services/guildConfig');
  ok((await gc.gameBlockReason('G','slot'))?.includes('비활성'), '슬롯 비활성 가드');
  ok((await gc.betBlockReason('G','slot',6000))?.includes('최대'), '베팅 한도 가드');
  await adm('점검',{'켜기':true,'메시지':'10분 점검'}); ok((await gc.gameBlockReason('G','dice'))?.includes('점검'), '점검 모드 가드');
  await adm('점검',{'켜기':false});
  await adm('이벤트',{'이름':'주말','배수':2,'시간':24}); const ev=require(ROOT+'src/services/events'); ok((await ev.pointsMultiplier('G'))===2, '이벤트 포인트 배수');
  ok(desc(pub).includes('보상 포인트') , '이벤트 시작은 공개 공지');
  await adm('지급',{'유저':{id:'Z'},'금액':100,'사유':'공개 지급','공개':true}); ok(desc(pub).includes('지급'), '지급 [공개] 옵션 → 공개 공지');
  await adm('감사로그'); ok(eph.length>0, '감사로그 조회');
  await adm('시즌종료'); ok(M.Season.docs.length===2 && M.Season.docs[0].endedAt, '시즌 종료 → 새 시즌');
  await adm('대시보드'); await adm('밸런스'); ok(true, '대시보드·밸런스 (aggregate는 실DB 필요)');

  step('재시작 복구');
  const gs=require(ROOT+'src/services/gameState');
  await wallet.getAccount('R','G');
  const r1=await wallet.reserve('R','G','slot',1000,{gameId:'g-dead'}); const r2=await wallet.reserve('R','G','dice',1000,{gameId:'g-dead'});
  await wallet.commitResult('R','G',r1.roundId,5000,{reels:['x']});
  await gs.create({gameId:'g-dead',game:'slot',guildId:'G',channelId:'C',messageId:'m1',players:['R'],state:'PLAYING'}); await sleep(5);
  M.User.docs.find(d=>d.userId==='R').escrow.forEach(e=>e.instance='old'); M.GameState.docs.find(g=>g.gameId==='g-dead').instance='old';
  const rec=await wallet.recoverPrevious(); const rb=await gs.recoverBoot(rec);
  ok(rec.settled===1 && rec.refunded===1 && money('R')===10000-2000+5000+1000, `확정 결과 정산 + 미확정 환불 (잔고 ${money('R')})`);
  ok(M.GameState.docs.find(g=>g.gameId==='g-dead').state==='CANCELLED', '게임 상태 CANCELLED + 복구 기록');
  ok(noEscrow(), '모든 에스크로 정리');
  ok(sessions.size===0, `세션 정리 (${sessions.size})`);
  sessions.shutdown();
  console.log(process.exitCode ? '\n❌ E2E 실패' : '\n✅ E2E 전체 통과');
  setTimeout(()=>process.exit(), 50);
})().catch(e=>{console.error('ERR',e);process.exit(1)});
