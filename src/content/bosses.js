/**
 * 월드 보스 정의 & 피해 계산 (순수 로직).
 * 공격은 칩을 걸지 않는 무료 행동이며, 피해량은 기존 주사위 엔진(rollPair)의 굴림으로 정해진다.
 * 평소 게임 플레이도 정산 이벤트로 소량의 "지원 피해"를 준다 (하루 상한).
 * 보스 상태는 게임 확률·배당에 영향을 주지 않는다.
 */
const BOSSES = [
  { id: 'dragon', name: '황금 탐욕룡 「그리드」', emoji: '🐉', hpPerPlayer: 600, minHp: 3000, flavor: '카지노 금고를 통째로 삼키려는 탐욕의 용.' },
  { id: 'golem', name: '칩 골렘 「토큰」', emoji: '🗿', hpPerPlayer: 500, minHp: 2500, flavor: '버려진 칩으로 빚어진 거대한 골렘.' },
  { id: 'phantom', name: '딜러의 망령 「셔플」', emoji: '👻', hpPerPlayer: 550, minHp: 2800, flavor: '끝없이 카드를 섞는 저주받은 딜러.' },
  { id: 'kraken', name: '심해의 크라켄 「잭팟」', emoji: '🦑', hpPerPlayer: 700, minHp: 3500, flavor: '7️⃣7️⃣7️⃣을 노리는 촉수 괴물.' },
];
const byId = Object.fromEntries(BOSSES.map((b) => [b.id, b]));

/** 체력 비율 → 페이즈 (1: 100~67%, 2: 66~34%, 3: 33% 이하 · 광폭화) */
function phaseFor(hp, maxHp) {
  const r = hp / maxHp;
  return r > 2 / 3 ? 1 : r > 1 / 3 ? 2 : 3;
}

/**
 * 공격 피해 (주사위 두 개). 같은 눈(더블)이면 치명타 ×2, 3페이즈(광폭화)는 보스 방어력 상승으로 ×0.8.
 * @param dice [a, b]
 */
function attackDamage(dice, phase) {
  const [a, b] = dice;
  const crit = a === b;
  let dmg = (a + b) * 10 + (crit ? (a + b) * 10 : 0);
  if (phase === 3) dmg = Math.floor(dmg * 0.8);
  return { dmg, crit };
}

/** 평소 게임 1판의 지원 피해 */
const passiveDamage = (ev) => (ev.status === 'settled' ? (ev.net > 0 ? 4 : 2) : 0);

/** 참여 인원 추정치로 체력 결정 */
const maxHpFor = (def, expectedPlayers) => Math.max(def.minHp, def.hpPerPlayer * Math.max(1, expectedPlayers));

const hpBar = (hp, max, len = 16) => {
  const n = Math.max(0, Math.round((hp / max) * len));
  return `${'█'.repeat(n)}${'░'.repeat(len - n)}`;
};

module.exports = { BOSSES, byId, phaseFor, attackDamage, passiveDamage, maxHpFor, hpBar };
