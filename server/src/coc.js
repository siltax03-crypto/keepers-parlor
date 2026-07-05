// ── CoC 7e 탐사자 시트 (현대 배경, 초여명 번역 용어) ─────────────
const { rollDie, evalExpr } = require('./dice');

// 기본 기능 목록 (기본치)
const BASE_SKILLS = {
  '관찰력': 25, '듣기': 20, '자료조사': 20, '은밀행동': 20,
  '심리학': 10, '설득': 10, '매혹': 15, '말재주': 5, '위협': 15,
  '기계수리': 10, '전기수리': 10, '컴퓨터 사용': 5, '운전(자동차)': 20,
  '응급처치': 30, '의학': 1, '정신분석': 1,
  '근접전(격투)': 25, '사격(권총)': 20, '투척': 20, '회피': 0, // 회피 = DEX/2
  '도약': 20, '등반': 20, '수영': 20, '손놀림': 10, '자물쇠': 1,
  '변장': 5, '추적': 10, '자연': 10, '항법': 10, '생존술': 10,
  '오컬트': 5, '역사': 5, '인류학': 1, '고고학': 1, '감정': 5,
  '회계': 5, '법률': 5, '예술/공예': 5, '언어(모국어)': 0, // = EDU
  '크툴루 신화': 0, '재력': 0,
};

const STAT_NAMES = ['STR', 'CON', 'SIZ', 'DEX', 'APP', 'INT', 'POW', 'EDU'];
const STAT_LABEL = {
  STR: '근력', CON: '건강', SIZ: '크기', DEX: '민첩',
  APP: '외모', INT: '지능', POW: '정신력', EDU: '교육',
};

// 특성치 굴림: STR CON DEX APP POW = 3d6×5, SIZ INT EDU = (2d6+6)×5
function rollStats() {
  const r3 = () => (rollDie(6) + rollDie(6) + rollDie(6)) * 5;
  const r2 = () => (rollDie(6) + rollDie(6) + 6) * 5;
  return {
    STR: r3(), CON: r3(), DEX: r3(), APP: r3(), POW: r3(),
    SIZ: r2(), INT: r2(), EDU: r2(),
  };
}

// 파생 수치
function derive(stats) {
  const hpMax = Math.floor((stats.CON + stats.SIZ) / 10);
  const mpMax = Math.floor(stats.POW / 5);
  const sanStart = stats.POW;
  const sum = stats.STR + stats.SIZ;
  let db = '0', build = 0;
  if (sum <= 64) { db = '-2'; build = -2; }
  else if (sum <= 84) { db = '-1'; build = -1; }
  else if (sum <= 124) { db = '0'; build = 0; }
  else if (sum <= 164) { db = '+1d4'; build = 1; }
  else { db = '+1d6'; build = 2; }
  let mov = 8;
  if (stats.DEX < stats.SIZ && stats.STR < stats.SIZ) mov = 7;
  else if (stats.DEX > stats.SIZ && stats.STR > stats.SIZ) mov = 9;
  return { hpMax, mpMax, sanStart, db, build, mov };
}

const OCCUPATIONS = [
  { name: '대학생', skills: ['자료조사', '듣기', '컴퓨터 사용', '언어(모국어)', '심리학', '도약'] },
  { name: '회사원', skills: ['회계', '컴퓨터 사용', '설득', '말재주', '재력', '운전(자동차)'] },
  { name: '기자', skills: ['자료조사', '심리학', '말재주', '관찰력', '은밀행동', '사진(예술/공예)'] },
  { name: '의사', skills: ['의학', '응급처치', '심리학', '과학(생물학)', '설득', '재력'] },
  { name: '경찰', skills: ['법률', '심리학', '관찰력', '위협', '사격(권총)', '운전(자동차)'] },
  { name: '수리기사', skills: ['기계수리', '전기수리', '관찰력', '등반', '운전(자동차)', '재력'] },
  { name: '탐정', skills: ['자료조사', '심리학', '관찰력', '은밀행동', '변장', '법률'] },
  { name: '교수', skills: ['자료조사', '언어(모국어)', '심리학', '설득', '역사', '재력'] },
  { name: '프리랜서', skills: ['예술/공예', '컴퓨터 사용', '말재주', '매혹', '재력', '심리학'] },
  { name: '요리사', skills: ['예술/공예', '관찰력', '듣기', '손놀림', '재력', '응급처치'] },
];

// 간이 자동 생성 — 특성치 + 직업 기능 배분
function quickGenerate(name) {
  const stats = rollStats();
  const d = derive(stats);
  const occ = OCCUPATIONS[Math.floor(Math.random() * OCCUPATIONS.length)];
  const skills = {};
  for (const [k, v] of Object.entries(BASE_SKILLS)) skills[k] = v;
  skills['회피'] = Math.floor(stats.DEX / 2);
  skills['언어(모국어)'] = stats.EDU;

  // 직업 점수 EDU×4를 직업 기능에, 취미 점수 INT×2를 무작위 기능에
  let occPoints = stats.EDU * 4;
  const occSkills = occ.skills.filter(s => s in skills || (skills[s] = 5) >= 0);
  while (occPoints > 0 && occSkills.length) {
    const s = occSkills[Math.floor(Math.random() * occSkills.length)];
    const add = Math.min(occPoints, 5 + Math.floor(Math.random() * 15));
    if ((skills[s] || 0) + add > 75) { occSkills.splice(occSkills.indexOf(s), 1); continue; }
    skills[s] = (skills[s] || 0) + add;
    occPoints -= add;
    if (occSkills.length === 0) break;
  }
  let intPoints = stats.INT * 2;
  const all = Object.keys(skills).filter(s => s !== '크툴루 신화');
  let guard = 200;
  while (intPoints > 0 && guard-- > 0) {
    const s = all[Math.floor(Math.random() * all.length)];
    const add = Math.min(intPoints, 5 + Math.floor(Math.random() * 10));
    if ((skills[s] || 0) + add > 70) continue;
    skills[s] = (skills[s] || 0) + add;
    intPoints -= add;
  }
  if (skills['재력'] < 15) skills['재력'] = 15 + Math.floor(Math.random() * 35);

  return {
    name: name || '이름 없는 탐사자',
    occupation: occ.name,
    age: 20 + Math.floor(Math.random() * 20),
    gender: '',
    background: '',
    stats,
    luck: (rollDie(6) + rollDie(6) + rollDie(6)) * 5,
    skills,
    ...d,
  };
}

// 시트 정규화 (편집 저장 시 파생치 재계산)
function normalizeSheet(inv) {
  const stats = {};
  for (const s of STAT_NAMES) stats[s] = Math.max(1, Math.min(99, parseInt(inv.stats?.[s], 10) || 50));
  const d = derive(stats);
  const skills = {};
  for (const [k, v] of Object.entries(inv.skills || {})) {
    const val = parseInt(v, 10);
    if (!isNaN(val) && String(k).trim()) skills[String(k).trim()] = Math.max(0, Math.min(99, val));
  }
  return {
    id: inv.id,
    name: String(inv.name || '무명').slice(0, 40),
    occupation: String(inv.occupation || '').slice(0, 40),
    age: parseInt(inv.age, 10) || 25,
    gender: String(inv.gender || '').slice(0, 20),
    background: String(inv.background || '').slice(0, 4000),
    stats,
    luck: Math.max(0, Math.min(99, parseInt(inv.luck, 10) || 50)),
    skills,
    // ST 연동/표시 필드 (있을 때만 보존)
    ...(inv.source ? { source: inv.source } : {}),
    ...(inv.stAvatar ? { stAvatar: inv.stAvatar } : {}),
    ...(inv.stGroup ? { stGroup: String(inv.stGroup).slice(0, 60) } : {}),
    ...(inv.customAvatar ? { customAvatar: inv.customAvatar } : {}),
    ...(inv.kpc ? { kpc: true } : {}),
    ...d,
  };
}

module.exports = { BASE_SKILLS, STAT_NAMES, STAT_LABEL, rollStats, derive, quickGenerate, normalizeSheet };
