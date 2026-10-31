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
    lines: ['`/잔고` 지갑 · 긴급 지원금', '`/프로필 [유저]` 꾸미기가 반영된 프로필 이미지 카드', '`/전적` `/분석` `/리플레이` 기록·통계', '`/업적` `/랭킹`'],
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

module.exports = {
  data: new SlashCommandBuilder()
    .setName('도움말')
    .setDescription('카지노 명령어 안내')
    .addStringOption((o) =>
      o
        .setName('분류')
        .setDescription('보고 싶은 분류만')
        .addChoices(...Object.entries(SECTIONS).map(([value, s]) => ({ name: s.name, value }))),
    ),
  SECTIONS,
  async execute(i) {
    const only = i.options.getString('분류');
    const list = only ? [SECTIONS[only]] : Object.values(SECTIONS);
    const embed = new EmbedBuilder()
      .setColor(COLOR.info)
      .setTitle('🎰 카지노 도움말')
      .setDescription(list.map((s) => `**${s.name}**\n${s.lines.join('\n')}`).join('\n\n'))
      .setFooter({ text: '모든 칩은 게임 재화이며 현금으로 바꿀 수 없어요 · 한 사람당 동시에 한 게임' });
    return i.reply({ embeds: [embed], ephemeral: true });
  },
};
