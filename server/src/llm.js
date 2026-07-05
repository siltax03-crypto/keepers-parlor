// ── LLM 어댑터: Gemini / Claude(Anthropic) / ST 커넥션 프로필 ────
// chat({settings, system, messages, json, maxTokens}) → 응답 텍스트
const stReader = require('./st-reader');

function describeProvider(settings) {
  const p = settings.provider;
  if (p === 'st') return `ST프로필(${(settings.st && settings.st.profile) || '선택된 프로필'})`;
  if (p === 'claude') return `Claude(${(settings.claude && settings.claude.model) || ''})`;
  return `Gemini(${(settings.gemini && settings.gemini.model) || ''})`;
}

async function chat({ settings, system, messages, json = true, maxTokens = 16384, temperature = 0.8 }) {
  const provider = settings.provider;
  const label = describeProvider(settings);
  const t0 = Date.now();
  console.log(`[LLM] ${label} 호출 — 메시지 ${messages.length}개`);
  try {
    let text;
    if (provider === 'st') text = await chatViaSTProfile({ settings, system, messages, json, maxTokens, temperature });
    else if (provider === 'claude') text = await chatClaude({ cfg: settings.claude, system, messages, maxTokens, temperature });
    else text = await chatGemini({ cfg: settings.gemini, system, messages, json, maxTokens, temperature });
    console.log(`[LLM] ${label} 응답 ${text.length}자 · ${((Date.now() - t0) / 1000).toFixed(1)}초`);
    return text;
  } catch (err) {
    console.error(`[LLM] ${label} 실패 (${((Date.now() - t0) / 1000).toFixed(1)}초): ${err.message}`);
    throw err;
  }
}

// ST ConnectionManager 프로필로 라우팅 (discord-bridge ai-client와 동일한 분기)
async function chatViaSTProfile({ settings, system, messages, json, maxTokens, temperature }) {
  const st = settings.st || {};
  stReader.setPath(st.path);
  if (!stReader.available()) throw new Error('SillyTavern 경로가 유효하지 않습니다. 설정에서 stPath를 확인해주세요.');
  const profile = stReader.getConnectionProfile(st.profile);
  if (!profile.apiKey) throw new Error(`ST 프로필 "${profile.name}"의 API 키를 secrets.json에서 찾지 못했습니다.`);
  const api = profile.api || '';
  const model = profile.model || '';

  // 커스텀(OpenAI 호환 프록시) — 모델명과 무관하게 프로필의 base URL로.
  // 이 분기가 gemini/claude 모델명 휴리스틱보다 먼저여야 한다
  // (커스텀 프록시로 gemini 모델을 쓰는 경우 AI Studio로 새면 안 됨).
  const customBase = profile['api-url'] || profile.custom_url || profile.reverse_proxy || '';
  if (api.includes('custom')) {
    if (!customBase) throw new Error(`커스텀 프로필 "${profile.name}"에 API URL이 없습니다.`);
    return chatOpenAI({ cfg: { apiKey: profile.apiKey, model, baseUrl: customBase }, system, messages, maxTokens, temperature });
  }
  if (api.includes('vertex')) {
    // Vertex AI Express (API 키 인증) — api-url 필드가 리전
    const region = profile['api-url'] || 'us-central1';
    const baseUrl = region === 'global'
      ? 'https://aiplatform.googleapis.com'
      : `https://${region}-aiplatform.googleapis.com`;
    const url = `${baseUrl}/v1/publishers/google/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(profile.apiKey)}`;
    return geminiRequest({ url, system, messages, json, maxTokens, temperature, label: `Vertex(${profile.name})` });
  }
  if (api.includes('google') || api.includes('makersuite') || model.includes('gemini')) {
    return chatGemini({ cfg: { apiKey: profile.apiKey, model }, system, messages, json, maxTokens, temperature });
  }
  if (api.includes('claude') || model.includes('claude')) {
    return chatClaude({ cfg: { apiKey: profile.apiKey, model }, system, messages, maxTokens, temperature });
  }
  // 그 외(openai 등) — 프로필에 URL이 있으면 그걸 base로 (브릿지 ai-client와 동일)
  return chatOpenAI({ cfg: { apiKey: profile.apiKey, model, baseUrl: customBase }, system, messages, maxTokens, temperature });
}

async function chatGemini({ cfg, system, messages, json, maxTokens, temperature }) {
  if (!cfg.apiKey) throw new Error('Gemini API 키가 설정되지 않았습니다. 설정에서 입력해주세요.');
  const model = cfg.model || 'gemini-3.1-pro';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  return geminiRequest({ url, system, messages, json, maxTokens, temperature, label: 'Gemini' });
}

// Gemini 계열 공통 요청 (AI Studio / Vertex Express 둘 다 동일 스키마)
async function geminiRequest({ url, system, messages, json, maxTokens, temperature, label }) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
      ...(json ? { responseMimeType: 'application/json' } : {}),
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' },
    ],
  };
  if (body.contents.length === 0) body.contents.push({ role: 'user', parts: [{ text: '(계속)' }] });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`${label} API 오류 (${res.status}): ${snippet(errText)}`);
  }
  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  if (!cand) {
    const block = data.promptFeedback && data.promptFeedback.blockReason;
    throw new Error(block ? `${label} 응답 차단됨: ${block}` : `${label} 응답에 candidates가 없습니다.`);
  }
  const parts = (cand.content && cand.content.parts) || [];
  const text = parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('');
  if (!text) throw new Error(`${label} 응답이 비어 있습니다 (finishReason: ${cand.finishReason || '?'})`);
  if (cand.finishReason === 'MAX_TOKENS') {
    throw new Error(`${label} 응답이 토큰 한도에서 잘렸습니다. maxOutputTokens를 늘려야 합니다.`);
  }
  return text;
}

async function chatOpenAI({ cfg, system, messages, maxTokens, temperature }) {
  if (!cfg.apiKey) throw new Error('OpenAI 호환 API 키가 없습니다.');
  // base URL: 커스텀 프록시(api-url) 지원 — 없으면 진짜 OpenAI
  const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const label = cfg.baseUrl ? '커스텀(OpenAI 호환)' : 'OpenAI';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model || 'gpt-4o',
      max_tokens: maxTokens,
      temperature: Math.min(temperature, 1.2),
      messages: [{ role: 'system', content: system }, ...messages.map(m => ({ role: m.role, content: m.content }))],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`${label} API 오류 (${res.status}): ${snippet(errText)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  if (!text) throw new Error(`${label} 응답이 비어 있습니다.`);
  return text;
}

async function chatClaude({ cfg, system, messages, maxTokens, temperature }) {
  if (!cfg.apiKey) throw new Error('Claude API 키가 설정되지 않았습니다. 설정에서 입력해주세요.');
  const model = cfg.model || 'claude-sonnet-5';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: Math.min(maxTokens, 64000),
      temperature: Math.min(temperature, 1),
      system,
      messages: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Claude API 오류 (${res.status}): ${snippet(errText)}`);
  }
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  if (!text) throw new Error('Claude 응답이 비어 있습니다.');
  if (data.stop_reason === 'max_tokens') {
    throw new Error('Claude 응답이 토큰 한도에서 잘렸습니다. max_tokens를 늘려야 합니다.');
  }
  return text;
}

function snippet(s) {
  s = String(s || '');
  return s.length > 400 ? s.slice(0, 400) + '…' : s;
}

// LLM 응답에서 JSON 오브젝트 강건 파싱
function parseJSON(text) {
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch { /* fallthrough */ }
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(t.slice(first, last + 1)); } catch { /* fallthrough */ }
  }
  throw new Error('LLM 응답 JSON 파싱 실패: ' + snippet(t));
}

module.exports = { chat, parseJSON };
