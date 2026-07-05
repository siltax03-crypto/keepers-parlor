// ── ST 카드/페르소나 → CoC 7e 시트 생성 (LLM, 캐릭터성 반영) ─────
// 카드의 성격/설정을 읽고 룰북에 맞는 특성치·직업·기능을 만든다.
// 프로필 텍스트가 없거나 LLM이 실패하면 호출부에서 quickGenerate로 폴백.
const { chat, parseJSON } = require('./llm');
const { SHEETGEN_SYSTEM, sheetGenUser } = require('./prompts');
const coc = require('./coc');
const { rollDie } = require('./dice');

const round5 = n => Math.round(n / 5) * 5;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// 프로필 하나 → 시트 배열 (멀티 캐릭터 카드면 여러 명, 보통은 1명)
async function generateSheetsFromProfile({ name, profileText, settings }) {
  const raw = await chat({
    settings,
    system: SHEETGEN_SYSTEM,
    messages: [{ role: 'user', content: sheetGenUser(name, String(profileText || '').slice(0, 24000)) }],
    json: true,
    maxTokens: 32768, // 멀티 캐릭터(최대 8명) + thinking 토큰까지 잘리지 않게
    temperature: 0.5,
  });
  const parsed = parseJSON(raw);
  const list = Array.isArray(parsed.investigators) ? parsed.investigators
    : Array.isArray(parsed) ? parsed
    : [parsed]; // 구형 단일 오브젝트 응답도 수용
  if (!list.length) throw new Error('시트 생성 결과가 비어 있습니다.');
  return list.slice(0, 8).map((g, i) => sanitizeSheet(g, list.length > 1 ? (g.name || `${name} ${i + 1}`) : (g.name || name)));
}

function sanitizeSheet(g, name) {
  const stats = {};
  for (const s of coc.STAT_NAMES) {
    const v = parseInt(g.stats && g.stats[s], 10);
    stats[s] = clamp(round5(isNaN(v) ? 50 : v), 15, 90);
  }

  // 기본치 위에 LLM 배분을 얹는다 (기본치보다 낮게는 안 깎음)
  const skills = { ...coc.BASE_SKILLS };
  skills['회피'] = Math.floor(stats.DEX / 2);
  skills['언어(모국어)'] = stats.EDU;
  for (const [k, v] of Object.entries(g.skills || {})) {
    const nm = String(k).trim();
    const val = parseInt(v, 10);
    if (!nm || isNaN(val)) continue;
    if (nm === '크툴루 신화') { skills[nm] = clamp(val, 0, 10); continue; }
    skills[nm] = clamp(val, skills[nm] || 0, 85);
  }
  if ((skills['재력'] || 0) < 15) skills['재력'] = 15 + rollDie(20);

  const luckV = parseInt(g.luck, 10);
  return {
    name: String(name || '무명').slice(0, 40),
    occupation: String(g.occupation || '').slice(0, 40) || '탐사자',
    age: clamp(parseInt(g.age, 10) || 27, 15, 90),
    gender: String(g.gender || '').slice(0, 20),
    background: String(g.background || '').slice(0, 4000),
    stats,
    luck: clamp(isNaN(luckV) ? (rollDie(6) + rollDie(6) + rollDie(6)) * 5 : round5(luckV), 15, 90),
    skills,
    ...coc.derive(stats),
  };
}

module.exports = { generateSheetsFromProfile };
