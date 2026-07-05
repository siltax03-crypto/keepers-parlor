// ── CoC 7e dice engine ──────────────────────────────────────────
// 모든 굴림은 서버가 담당한다. LLM은 판정을 "요청"만 할 수 있다.

function rollDie(sides) {
  return 1 + Math.floor(Math.random() * sides);
}

// "2d6+3", "1d100", "1d3", "3", "1d4-1" 같은 표현식 평가
function evalExpr(expr) {
  const s = String(expr).trim().toLowerCase().replace(/\s/g, '');
  if (/^-?\d+$/.test(s)) return { total: parseInt(s, 10), detail: s, expr: s };
  const m = s.match(/^(\d*)d(\d+)([+-]\d+)?$/);
  if (!m) throw new Error(`주사위 표현식을 해석할 수 없음: "${expr}"`);
  const n = m[1] ? parseInt(m[1], 10) : 1;
  const sides = parseInt(m[2], 10);
  const mod = m[3] ? parseInt(m[3], 10) : 0;
  if (n < 1 || n > 100 || sides < 2 || sides > 1000) throw new Error(`주사위 범위 초과: "${expr}"`);
  const rolls = [];
  for (let i = 0; i < n; i++) rolls.push(rollDie(sides));
  const total = rolls.reduce((a, b) => a + b, 0) + mod;
  return { total: Math.max(0, total), detail: `[${rolls.join(',')}]${mod ? (mod > 0 ? '+' + mod : mod) : ''}`, expr: s };
}

// d100 (보너스/패널티 주사위 지원 — 십의 자리 주사위를 추가로 굴려 유/불리 선택)
function rollD100(bonusDice = 0, penaltyDice = 0) {
  const net = (bonusDice | 0) - (penaltyDice | 0); // 상쇄 (7e RAW)
  const ones = Math.floor(Math.random() * 10);
  const tensCount = 1 + Math.abs(net);
  const tens = [];
  for (let i = 0; i < tensCount; i++) tens.push(Math.floor(Math.random() * 10));
  const candidates = tens.map(t => {
    const v = t * 10 + ones;
    return v === 0 ? 100 : v;
  });
  const result = net >= 0 ? Math.min(...candidates) : Math.max(...candidates);
  return { result, ones, tens, candidates, bonusDice: bonusDice | 0, penaltyDice: penaltyDice | 0 };
}

// 성공 단계
function successLevel(roll, value) {
  if (roll === 1) return 'critical';
  if (roll === 100 || (value < 50 && roll >= 96)) return 'fumble';
  if (roll <= Math.floor(value / 5)) return 'extreme';
  if (roll <= Math.floor(value / 2)) return 'hard';
  if (roll <= value) return 'regular';
  return 'fail';
}

const LEVEL_RANK = { fumble: 0, fail: 1, regular: 2, hard: 3, extreme: 4, critical: 5 };
const LEVEL_LABEL = {
  fumble: '펌블', fail: '실패', regular: '성공',
  hard: '어려운 성공', extreme: '극단적 성공', critical: '대성공',
};

function meetsDifficulty(level, difficulty) {
  const need = { regular: 2, hard: 3, extreme: 4 }[difficulty || 'regular'] || 2;
  return LEVEL_RANK[level] >= need;
}

const DIFFICULTY_LABEL = { regular: '보통', hard: '어려움', extreme: '극단' };

// 기능/특성 판정
function skillCheck({ name, value, difficulty = 'regular', bonusDice = 0, penaltyDice = 0 }) {
  value = Math.max(1, Math.min(99, value | 0 || 20));
  const r = rollD100(bonusDice, penaltyDice);
  const level = successLevel(r.result, value);
  return {
    kind: 'skill', name, value, difficulty,
    bonusDice: r.bonusDice, penaltyDice: r.penaltyDice,
    roll: r.result, candidates: r.candidates,
    level, levelLabel: LEVEL_LABEL[level],
    difficultyLabel: DIFFICULTY_LABEL[difficulty] || '보통',
    success: meetsDifficulty(level, difficulty),
  };
}

// SAN 체크 — loss 표기 "성공/실패" 예: "1/1d2", "0/1d6"
function sanCheck({ san, loss = '0/1' }) {
  san = Math.max(0, Math.min(99, san | 0));
  const r = rollD100();
  const level = successLevel(r.result, san);
  const success = LEVEL_RANK[level] >= 2;
  const parts = String(loss).split('/');
  const side = (success ? parts[0] : (parts[1] !== undefined ? parts[1] : parts[0])).trim();
  const lost = evalExpr(side || '0');
  return {
    kind: 'san', san, loss, roll: r.result,
    success, level, levelLabel: LEVEL_LABEL[level],
    lost: lost.total, lostDetail: lost.detail,
  };
}

// 대항 판정 — 높은 성공 단계가 승리, 동급이면 높은 수치 승리
function opposedCheck({ aName, aValue, bName, bValue, aLabel, bLabel }) {
  const a = skillCheck({ name: aName, value: aValue });
  const b = skillCheck({ name: bName, value: bValue });
  let winner = null;
  if (LEVEL_RANK[a.level] >= 2 || LEVEL_RANK[b.level] >= 2) {
    if (LEVEL_RANK[a.level] > LEVEL_RANK[b.level]) winner = 'a';
    else if (LEVEL_RANK[b.level] > LEVEL_RANK[a.level]) winner = 'b';
    else winner = a.value >= b.value ? 'a' : 'b';
  }
  return { kind: 'opposed', a, b, aLabel: aLabel || aName, bLabel: bLabel || bName, winner };
}

module.exports = {
  rollDie, evalExpr, rollD100, successLevel, meetsDifficulty,
  skillCheck, sanCheck, opposedCheck,
  LEVEL_RANK, LEVEL_LABEL, DIFFICULTY_LABEL,
};
