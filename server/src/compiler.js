// ── 시나리오 컴파일러: 원문 텍스트 → 구조화 JSON ─────────────────
const { chat, parseJSON } = require('./llm');
const { COMPILER_SYSTEM, compilerUser } = require('./prompts');

async function compileScenario({ text, settings, onStatus }) {
  if (!text || text.trim().length < 100) throw new Error('시나리오 텍스트가 너무 짧습니다.');
  onStatus && onStatus('시나리오 분석 중… (LLM 호출, 30초~2분 정도 걸릴 수 있어요)');

  const raw = await chat({
    settings,
    system: COMPILER_SYSTEM,
    messages: [{ role: 'user', content: compilerUser(text) }],
    json: true,
    maxTokens: 65536, // 대형 시나리오 원문 보존 (요약 압축 방지)
    temperature: 0.3,
  });

  onStatus && onStatus('분석 결과 검증 중…');
  const compiled = parseJSON(raw);

  // 최소 구조 검증
  const problems = [];
  if (!compiled.title) problems.push('title 누락');
  if (!Array.isArray(compiled.scenes) || compiled.scenes.length === 0) problems.push('scenes 누락');
  if (!Array.isArray(compiled.endings) || compiled.endings.length === 0) problems.push('endings 누락');
  if (!compiled.startingScene && compiled.scenes && compiled.scenes[0]) {
    compiled.startingScene = compiled.scenes[0].id;
  }
  if (problems.length) throw new Error('컴파일 결과가 불완전합니다: ' + problems.join(', '));

  compiled.system = compiled.system || 'coc7e';
  compiled.globalMechanics = compiled.globalMechanics || [];
  compiled.npcs = compiled.npcs || [];
  compiled.items = compiled.items || [];
  return compiled;
}

module.exports = { compileScenario };
