/** /도움말 — 명령어 안내 (분류별) */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('../config');
const { COLOR, chips } = require('../utils/format');

const SECTIONS = {
  games: {
    name: '🎲 게임',
    lines: [
      '`/블랙잭` 채널 공유 슈 다인 블랙잭 (스플릿·더블·보험)',
      '`/바카라` 플레이어·뱅커·타이 베팅',
      '`/슬롯 금액` 연속 스핀 · 7️⃣7️⃣7️⃣ 잭팟',
      `\`/그래프 금액 [자동캐시아웃]\` ${config.CRASH.START_MULTIPLIER.toFixed(2)}x에서 출발 — 1.00x 넘어서 터지기 전에 탈출`,
      '`/주사위 금액` Hi / Lo / 7',
      '`/포커페이스 금액` 노리밋 홀덤 한 핸드 (봇·유저)',
      '`/토너먼트 참가비` 전용 스레드에서 진행되는 홀덤 토너먼트 — 채널에서는 다른 게임 계속 가능',
    ],
  },
  me: {
    name: '👤 내 정보',
    lines: ['`/잔고` 지갑 · 긴급 지원금', '`/프로필 [유저]` 꾸미기·대표 업적이 반영된 프로필 이미지 카드', '`/전적` `/분석` `/리플레이` 기록·통계', '`/업적 [등급]` 일반·희귀·영웅·전설·신화 등급별 업적', '`/랭킹`'],
  },
  rewards: {
    name: '🎁 보상·꾸미기',
    lines: ['`/출석` 매일 칩 + 포인트 (연속 보너스)', '`/미션` 일일·주간 미션 보상', '`/상점` 카드 테마·색상·테두리·칭호 구매', '`/인벤토리` 장착 (프로필 카드에 바로 반영)'],
  },
  social: {
    name: '🤝 함께하기',
    lines: [`\`/송금 유저 금액\` 칩 보내기 · 수수료 ${config.TRANSFER.FEE_RATE * 100}% · 하루 ${chips(config.TRANSFER.DAILY_LIMIT)}`],
  },
};

/** 게임 방법 (게임별 필드) — 수치는 config에서 가져와 설정을 바꿔도 안내가 맞게 유지됨 */
const pct = (x) => `${Math.round(x * 100)}%`;
const HOWTO = [
  {
    name: '🃏 블랙잭 `/블랙잭`',
    value: [
      '**목표:** 21을 넘지 않으면서 딜러보다 21에 가깝게. J·Q·K는 10, A는 1 또는 11.',
      '**진행:** 테이블이 열리면 [참가] → 베팅 금액 버튼 → 카드 2장씩.',
      '**행동:** 히트(한 장 더) · 스탠드(멈춤) · 더블(베팅 2배, 딱 한 장) · 스플릿(같은 숫자 2장을 두 손으로)',
      `**배당:** 승리 1:1 · 블랙잭(처음 두 장 21) 3:2 · 딜러 A면 보험(베팅 ½, 딜러 블랙잭이면 2:1)`,
      '**팁:** 딜러는 17 이상이면 멈춰요. 12~16에서 딜러 업카드가 2~6이면 스탠드가 기본.',
    ].join('\n'),
  },
  {
    name: '🎴 바카라 `/바카라`',
    value: [
      '**목표:** 플레이어 / 뱅커 중 끝자리 합이 9에 가까운 쪽 맞히기 (10·J·Q·K = 0).',
      '**진행:** [참가] 후 쪽 × 금액 버튼 한 번으로 베팅 → 딜러가 규칙대로 3번째 카드를 자동 처리.',
      `**배당:** 플레이어 ×${config.BACCARAT.PAYOUT.player} · 뱅커 ×${config.BACCARAT.PAYOUT.banker} · 타이 ×${config.BACCARAT.PAYOUT.tie} (원금 포함)`,
      '**팁:** 흐름 보드는 지난 결과일 뿐, 다음 판 확률은 바뀌지 않아요.',
    ].join('\n'),
  },
  {
    name: '🎰 슬롯 `/슬롯 금액`',
    value: [
      '**진행:** 한 번 돌리거나 [×5/×10/×25] 연속 스핀 (중간에 [멈춤] 가능).',
      `**배당:** 같은 그림 3개 🍒×${config.SLOT.PAYTABLE.triple['🍒']} 🍋×${config.SLOT.PAYTABLE.triple['🍋']} 🔔×${config.SLOT.PAYTABLE.triple['🔔']} 💎×${config.SLOT.PAYTABLE.triple['💎']} 7️⃣×${config.SLOT.PAYTABLE.triple['7️⃣']} · 🍒🍒 ×${config.SLOT.PAYTABLE.twoCherry}`,
      '**잭팟:** 7️⃣7️⃣7️⃣이 나오면 ×777에 **잭팟 풀 전액**까지!',
    ].join('\n'),
  },
  {
    name: '📈 그래프 `/그래프 금액 [자동캐시아웃]`',
    value: [
      `**진행:** 배수가 **${config.CRASH.START_MULTIPLIER.toFixed(2)}x**에서 출발해 점점 빨라지며 올라가요. 언제 터질지는 시작할 때 이미 정해져 있어요.`,
      '**행동:** 터지기 전에 [캐시아웃] → 베팅 × 그 순간 배수를 받음. 터지면 전액 잃음.',
      '**주의:** 1.00x(본전) 전에 탈출하면 원금 일부만 돌려받아요.',
      '**자동:** `자동캐시아웃:2` 처럼 목표를 정하면 그 배수에 정확히 자동 탈출.',
      `**확률:** 어떤 목표(1.00x 이상)든 기대 환수율 ${pct(1 - config.CRASH.HOUSE_EDGE)}.`,
    ].join('\n'),
  },
  {
    name: '🎲 주사위 `/주사위 금액`',
    value: [
      '**진행:** 주사위 2개의 합을 예측 → Lo(2~6) · 7 · Hi(8~12) 버튼.',
      `**배당:** Lo ×${config.DICE.PAYOUT.lo} · 7 ×${config.DICE.PAYOUT.seven} · Hi ×${config.DICE.PAYOUT.hi} (원금 포함)`,
      '**연패 보정:** 연패가 길어지면 보정이 켜지고, 그때 확률이 화면에 공개돼요.',
    ].join('\n'),
  },
  {
    name: '🎭 포커페이스 `/포커페이스 금액 [봇] [최대인원]`',
    value: [
      '**규칙:** 텍사스 홀덤. 내 패 2장 + 공용 카드 5장 중 가장 좋은 5장으로 승부.',
      '**순서:** 프리플랍 → 플랍(3장) → 턴(1장) → 리버(1장) → 쇼다운. 매 단계 베팅.',
      '**행동:** 콜/체크 · 레이즈(최소·½팟·팟) · 올인 · 다이. **[내 패]** 버튼으로 내 카드 확인 (나만 보임).',
      '**족보(높은 순):** 로열 스트레이트 플러시 > 스트레이트 플러시 > 포카드 > 풀하우스 > 플러시 > 스트레이트 > 트리플 > 투페어 > 원페어 > 하이카드',
      '**정산:** 금액 = 시작 스택. 한 핸드가 끝나면 남은 스택을 돌려받아요. 끝나면 봇의 블러핑 여부가 공개돼요.',
    ].join('\n'),
  },
  {
    name: '🏆 토너먼트 `/토너먼트 참가비 [봇] [최대인원] [시작칩]`',
    value: [
      '**진행:** 참가비를 내고 같은 칩으로 시작 → 시작되면 **전용 스레드**에서 진행돼요 (채널에서는 다른 게임 가능).',
      `**규칙:** ${config.TOURNAMENT.HANDS_PER_LEVEL}핸드마다 블라인드 ×${config.TOURNAMENT.BLIND_GROWTH}, 칩이 0이면 탈락. 최후의 1인 또는 최대 ${config.TOURNAMENT.MAX_HANDS}핸드 뒤 칩 순위로 종료.`,
      '**내 패:** 스레드에서 [🃏 내 패]를 한 번 누르면 탈락 전까지 핸드마다 내 패가 스레드에 자동으로 떠요.',
      '**상금:** 사람 참가비 합을 사람 순위대로 분배 (1~2명 100% · 3~4명 65/35 · 5명+ 50/30/20). 봇은 상금 없음.',
      '**자리비움:** 두 번 연속 시간 초과면 자동 체크/다이 → [복귀]로 돌아오기.',
    ].join('\n'),
  },
];

module.exports = {
  HOWTO,
  data: new SlashCommandBuilder()
    .setName('도움말')
    .setDescription('카지노 명령어 안내')
    .addStringOption((o) =>
      o
        .setName('분류')
        .setDescription('보고 싶은 분류만')
        .addChoices({ name: '🎮 게임 방법', value: 'howto' }, ...Object.entries(SECTIONS).map(([value, s]) => ({ name: s.name, value }))),
    ),
  SECTIONS,
  async execute(i) {
    const only = i.options.getString('분류');
    if (only === 'howto') {
      const embed = new EmbedBuilder()
        .setColor(COLOR.gold)
        .setTitle('🎮 게임 방법')
        .setDescription('모든 게임은 명령어를 입력하면 버튼으로 진행돼요. 배당은 **원금 포함** 지급 배수예요. (×2 = 건 돈의 2배를 받음)')
        .addFields(...HOWTO)
        .setFooter({ text: '결과는 시작 시 안전한 난수로 미리 정해지고, 칩은 판이 끝날 때 한 번만 정산돼요' });
      return i.reply({ embeds: [embed], ephemeral: true });
    }
    const list = only ? [SECTIONS[only]] : Object.values(SECTIONS);
    const embed = new EmbedBuilder()
      .setColor(COLOR.info)
      .setTitle('🎰 카지노 도움말')
      .setDescription(
        [
          ...(only ? [] : ['📖 **처음이라면?** `/도움말 분류:🎮 게임 방법` 에서 게임별 규칙·버튼·배당을 확인하세요.', '']),
          list.map((s) => `**${s.name}**\n${s.lines.join('\n')}`).join('\n\n'),
        ].join('\n'),
      )
      .setFooter({ text: '모든 칩은 게임 재화이며 현금으로 바꿀 수 없어요 · 한 사람당 동시에 한 게임' });
    return i.reply({ embeds: [embed], ephemeral: true });
  },
};
