// ── 키퍼의 방 — 라우트 조립 ──────────────────────────────────────
// attach(app) : express app에 전체 API + 정적 UI를 붙인다.
// ST가 형제 폴더(../SillyTavern 또는 ~/SillyTavern)에 있으면 경로 설정 없이
// 자동 연동된다 (discord-bridge와 같은 배치 가정).
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const store = require('./src/store');
const coc = require('./src/coc');
const dice = require('./src/dice');
const stReader = require('./src/st-reader');
const { generateSheetsFromProfile } = require('./src/sheet-gen');
const { compileScenario } = require('./src/compiler');
const { chat, parseJSON } = require('./src/llm');
const { ADAPT_SYSTEM, adaptUser, WRITER_SYSTEM } = require('./src/prompts');
const { runTurn, publicState, resolveRolls, describePendingRolls, describePushable, findInvestigator } = require('./src/keeper');

const VERSION = require('./package.json').version;

// NDJSON 스트리밍 헬퍼 (ST의 compression 미들웨어 대비 flush)
function ndjson(res) {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  if (res.flushHeaders) res.flushHeaders();
  return ev => {
    res.write(JSON.stringify(ev) + '\n');
    if (typeof res.flush === 'function') res.flush();
  };
}

function fail(res, status, message) {
  res.status(status).json({ error: message });
}

// 최초 실행: samples/의 예시 시나리오·탐사자를 data/로 시드
// (data/는 git에 안 올라가므로 — 자기 업데이트(git pull)가 충돌 없이 돌기 위함)
function seedData() {
  const samplesDir = path.join(__dirname, 'samples');
  if (!fs.existsSync(samplesDir)) return;
  for (const kind of fs.readdirSync(samplesDir)) {
    const src = path.join(samplesDir, kind);
    if (!fs.statSync(src).isDirectory()) continue;
    const dst = path.join(__dirname, 'data', kind);
    fs.mkdirSync(dst, { recursive: true });
    if (fs.readdirSync(dst).some(f => f.endsWith('.json'))) continue;
    for (const f of fs.readdirSync(src)) {
      if (f.endsWith('.json')) fs.copyFileSync(path.join(src, f), path.join(dst, f));
    }
  }
}

function attach(router) {
  seedData();

  // ST 자동 감지: 형제 폴더 → 홈 폴더 순 (KEEPERS_PARLOR_ST_PATH 환경변수로 강제 가능)
  let stAutoRoot = '';
  const stGuesses = [
    process.env.KEEPERS_PARLOR_ST_PATH,
    path.join(__dirname, '..', '..', 'SillyTavern'),
    path.join(os.homedir(), 'SillyTavern'),
  ].filter(Boolean);
  for (const g of stGuesses) {
    if (fs.existsSync(g)) { stAutoRoot = g; stReader.setDefaultPath(g); break; }
  }

  router.use(express.json({ limit: '40mb' })); // PDF(base64) 업로드 여유
  router.use(express.static(path.join(__dirname, '..', 'public')));

  function stReady() {
    stReader.setPath((store.getSettings().st || {}).path);
    return stReader.available();
  }

  // ── 상태 ────────────────────────────────────────────────────
  router.get('/api/health', (req, res) => {
    res.json({ ok: true, name: 'keepers-parlor', version: VERSION });
  });

  // 이름 한글 표기 제안 (세션은 한글 이름으로 진행 — Hunter → 헌터)
  router.post('/api/hangulize', async (req, res) => {
    const names = [].concat((req.body || {}).names || []).map(String).filter(Boolean).slice(0, 20);
    if (!names.length) return fail(res, 400, '이름이 없습니다.');
    try {
      const raw = await chat({
        settings: store.getSettings(),
        system: 'You transliterate character names into natural Korean (Hangul) as they would be pronounced in Korean localization (e.g. Hunter → 헌터, König → 쾨니히, Soap → 소프). Names already fully in Hangul stay unchanged. Respond ONLY with JSON: {"names":{"<original>":"<한글 표기>"}}',
        messages: [{ role: 'user', content: JSON.stringify(names) }],
        json: true, maxTokens: 2048, temperature: 0.2,
      });
      const parsed = parseJSON(raw);
      res.json({ names: parsed.names || {} });
    } catch (err) { fail(res, 500, String(err.message || err)); }
  });

  // ── 설정 ────────────────────────────────────────────────────
  router.get('/api/settings', (req, res) => res.json(store.getSettings()));
  router.put('/api/settings', (req, res) => res.json(store.saveSettings(req.body || {})));

  // ── SillyTavern 연동 ────────────────────────────────────────
  router.get('/api/st/status', (req, res) => {
    const st = store.getSettings().st || {};
    const auto = !!stAutoRoot; // ST 플러그인 경유 접속 → 경로 자동
    if (!stReady()) return res.json({ available: false, auto, path: st.path || '' });
    let profiles = 0, personas = 0, characters = 0;
    try { profiles = stReader.listConnectionProfiles().length; } catch { /* skip */ }
    try { personas = stReader.listPersonas().length; } catch { /* skip */ }
    try { characters = stReader.listCharacters().length; } catch { /* skip */ }
    res.json({ available: true, auto, path: stReader.currentPath(), profiles, personas, characters });
  });

  router.get('/api/st/profiles', (req, res) => {
    if (!stReady()) return fail(res, 400, 'SillyTavern 경로가 유효하지 않습니다.');
    try { res.json(stReader.listConnectionProfiles()); }
    catch (err) { fail(res, 500, String(err.message || err)); }
  });

  router.get('/api/st/personas', (req, res) => {
    if (!stReady()) return fail(res, 400, 'SillyTavern 경로가 유효하지 않습니다.');
    try { res.json(stReader.listPersonas()); }
    catch (err) { fail(res, 500, String(err.message || err)); }
  });

  router.get('/api/st/characters', (req, res) => {
    if (!stReady()) return fail(res, 400, 'SillyTavern 경로가 유효하지 않습니다.');
    try { res.json(stReader.listCharacters()); }
    catch (err) { fail(res, 500, String(err.message || err)); }
  });

  // 연결된 프로필의 프리셋 항목 목록 (키퍼 전용 on/off·추가 항목 편집용)
  router.get('/api/st/preset-entries', (req, res) => {
    if (!stReady()) return fail(res, 400, 'SillyTavern 경로가 유효하지 않습니다.');
    try {
      const st = store.getSettings().st || {};
      const prof = stReader.getConnectionProfile(st.profile);
      res.json({
        profile: prof.name,
        preset: prof.preset || '',
        entries: stReader.getPresetEntries(prof.preset),
        disabled: st.presetDisabled || [],
        extra: st.presetExtra || [],
      });
    } catch (err) { fail(res, 500, String(err.message || err)); }
  });

  router.get('/api/st/char-avatar/:file', (req, res) => {
    if (!stReady()) return res.status(404).end();
    const p = stReader.getCharacterAvatarPath(path.basename(req.params.file));
    if (!p) return res.status(404).end();
    res.sendFile(p);
  });

  // 카드 진단 — 임포트가 "설명이 없다"고 할 때 뭘 읽었는지 확인용
  router.get('/api/st/char-debug/:file', (req, res) => {
    if (!stReady()) return fail(res, 400, 'SillyTavern 경로가 유효하지 않습니다.');
    try { res.json(stReader.debugCharacter(req.params.file)); }
    catch (err) { fail(res, 500, String(err.message || err)); }
  });

  router.get('/api/st/persona-avatar/:file', (req, res) => {
    if (!stReady()) return res.status(404).end();
    const p = stReader.getPersonaAvatarPath(path.basename(req.params.file));
    if (!p) return res.status(404).end();
    res.sendFile(p);
  });

  // 프로필 텍스트로 시트 생성 (LLM, 캐릭터성 반영 — 멀티 캐릭터 카드면 여러 명)
  // 실패/텍스트 부족 시 랜덤 굴림 1명 폴백 — 폴백 사유(reason)를 응답에 실어 원인을 숨기지 않는다
  async function buildImportedSheets(name, profileText) {
    let reason = '카드에서 읽은 텍스트가 거의 없음';
    if (String(profileText || '').trim().length >= 20) {
      try {
        const gens = await generateSheetsFromProfile({ name, profileText, settings: store.getSettings() });
        return { gens, genBy: 'ai', reason: '' };
      } catch (err) {
        reason = 'AI 시트 생성 실패: ' + String(err.message || err);
        console.error(`[임포트] "${name}" ${reason} → 랜덤 굴림`);
      }
    }
    const gen = coc.quickGenerate(name);
    gen.background = String(profileText || '').slice(0, 2000);
    return { gens: [gen], genBy: 'random', reason };
  }

  function saveImported(gens, base) {
    const group = gens.length > 1 ? base.name : ''; // 단체 카드 → 그룹으로 묶어 표시
    return gens.map(gen => {
      const id = store.newId();
      const inv = coc.normalizeSheet({
        ...gen, id, ...base,
        name: gen.name || base.name,
        ...(group ? { stGroup: group } : {}),
      });
      inv.createdAt = Date.now();
      store.writeJSON('investigators', id, inv);
      return inv;
    });
  }

  // 페르소나 → 탐사자로 임포트 (설명 텍스트를 읽고 시트 생성)
  router.post('/api/st/import/persona', async (req, res) => {
    if (!stReady()) return fail(res, 400, 'SillyTavern 경로가 유효하지 않습니다.');
    try {
      const { avatar } = req.body || {};
      const persona = stReader.listPersonas().find(p => p.avatar === avatar || p.name === avatar);
      if (!persona) return fail(res, 404, '페르소나를 찾을 수 없습니다.');
      const { gens, genBy, reason } = await buildImportedSheets(persona.name, persona.description);
      const invs = saveImported(gens, { name: persona.name, source: 'st-persona', stAvatar: persona.avatar });
      res.json({ investigators: invs, genBy, reason });
    } catch (err) { fail(res, 500, String(err.message || err)); }
  });

  // 캐릭터 → 탐사자로 임포트 (카드+로어북+참메모리를 읽고 시트 생성. 기본은 KPC 동료)
  router.post('/api/st/import/character', async (req, res) => {
    if (!stReady()) return fail(res, 400, 'SillyTavern 경로가 유효하지 않습니다.');
    try {
      const { avatar } = req.body || {};
      const card = stReader.getCharacter(avatar);
      const name = card.name || card.data?.name || avatar;
      // 카드 본문 + 내장 로어북 + 월드인포 + CHARM 메모리까지 전부 프로필로
      const ctx = stReader.buildCharacterContext(card.avatar || avatar, { cap: 24000 });
      console.log(`[임포트] 카드 "${name}" — 컨텍스트 ${ctx.text.length}자`);
      const { gens, genBy, reason } = await buildImportedSheets(name, ctx.text);
      const invs = saveImported(gens, { name, source: 'st-character', stAvatar: card.avatar || avatar, kpc: true });
      res.json({ investigators: invs, genBy, reason, ctxLength: ctx.text.length });
    } catch (err) { fail(res, 500, String(err.message || err)); }
  });

  // ── 시나리오 ────────────────────────────────────────────────
  function scenarioSafeView(sc) {
    return {
      id: sc.id, title: sc.title, createdAt: sc.createdAt,
      compiled: !!sc.compiled,
      summarySafe: sc.compiled ? sc.compiled.summarySafe : '',
      meta: sc.compiled ? sc.compiled.meta : null,
      textLength: (sc.text || '').length,
      compiledLength: sc.compiled ? JSON.stringify(sc.compiled).length : 0,
    };
  }

  router.get('/api/scenarios', (req, res) => {
    res.json(store.listJSON('scenarios').map(scenarioSafeView));
  });

  // PDF → 텍스트 추출 (시나리오 붙여넣기용) — pdfjs-dist 최신, 전 페이지 전문 추출
  router.post('/api/pdf-extract', async (req, res) => {
    try {
      const { data } = req.body || {};
      if (!data) return fail(res, 400, 'PDF 데이터가 없습니다.');
      const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
      const buf = Buffer.from(String(data).replace(/^data:.*?;base64,/, ''), 'base64');
      const doc = await pdfjs.getDocument({
        data: new Uint8Array(buf),
        useSystemFonts: true,
        isEvalSupported: false,
      }).promise;
      const pagesOut = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        const lines = [];
        let line = '';
        for (const item of tc.items) {
          line += item.str;
          if (item.hasEOL) { lines.push(line); line = ''; }
        }
        if (line) lines.push(line);
        pagesOut.push(lines.join('\n'));
        page.cleanup();
      }
      await doc.destroy();
      const text = pagesOut.join('\n\n')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim();
      if (text.length < 100) return fail(res, 400, 'PDF에서 텍스트를 거의 추출하지 못했습니다 (스캔 이미지 PDF일 수 있어요 — 그 경우 OCR이 필요합니다).');
      console.log(`[PDF] 추출 완료 — ${doc.numPages}쪽, ${text.length}자`);
      res.json({ text, pages: doc.numPages });
    } catch (err) {
      fail(res, 500, 'PDF 해석 실패: ' + String(err.message || err));
    }
  });

  // ── AI 시나리오 작가: 인터뷰(질문) ↔ 주사위 ↔ 집필 → 저장 ──────
  // 완성본은 서버에만 저장 (진상 스포 방지 — 클라이언트에 원문을 보내지 않는다)
  router.post('/api/scenario-wizard', async (req, res) => {
    const emit = ndjson(res);
    try {
      let messages = Array.isArray((req.body || {}).messages) ? (req.body || {}).messages.slice(-60) : [];
      if (!messages.length) { emit({ e: 'error', message: '주제가 없습니다.' }); res.end(); return; }
      const settings = store.getSettings();
      let plot = null;          // 긴 시나리오: 플롯 먼저 (keeper-only)
      const chapters = [];      // 챕터별 집필 누적
      for (let iter = 0; iter < 20; iter++) {
        emit({ e: 'status', text: iter === 0 ? '작가가 구상 중…' : (chapters.length ? `${chapters.length + 1}장 집필 중…` : '작가가 이어서 쓰는 중…') });
        const raw = await chat({ settings, system: WRITER_SYSTEM, messages, json: true, maxTokens: 32768, temperature: 0.9 });
        messages.push({ role: 'assistant', content: raw });
        let resp;
        try { resp = parseJSON(raw); } catch { throw new Error('작가 응답 해석 실패 — 다시 시도해주세요.'); }

        if (Array.isArray(resp.rolls) && resp.rolls.length) {
          if (resp.say) emit({ e: 'say', text: String(resp.say) });
          const results = [];
          for (const r of resp.rolls.slice(0, 10)) {
            try {
              const out = dice.evalExpr(r.expr || '1d6');
              results.push({ expr: out.expr, total: out.total, reason: r.reason || '' });
              emit({ e: 'roll', expr: out.expr, total: out.total, reason: r.reason || '' });
            } catch { /* 식이 이상하면 스킵 */ }
          }
          messages.push({ role: 'user', content: '[DICE RESULTS] ' + JSON.stringify(results) + ' — continue.' });
          continue;
        }

        if (Array.isArray(resp.questions) && resp.questions.length) {
          emit({ e: 'ask', say: String(resp.say || ''), questions: resp.questions.slice(0, 5), messages });
          res.end();
          return;
        }

        // 플롯 접수 → 챕터 집필 시작 (플롯 내용은 클라이언트에 안 보냄)
        if (resp.plot && resp.plot.outline) {
          plot = { title: String(resp.plot.title || 'AI 시나리오').slice(0, 80), outline: String(resp.plot.outline) };
          emit({ e: 'say', text: String(resp.say || '') || `플롯 완성 — "${plot.title}" 챕터 집필을 시작합니다.` });
          console.log(`[각본] 플롯 완성: "${plot.title}" (${plot.outline.length}자)`);
          messages.push({ role: 'user', content: '[PLOT ACCEPTED] Now write chapter 1 (shape 4: {"chapter":{...},"more":true}).' });
          continue;
        }

        // 챕터 수신 → 누적, more=false면 조립·저장
        if (resp.chapter && resp.chapter.text) {
          chapters.push({ title: String(resp.chapter.title || `${chapters.length + 1}장`), text: String(resp.chapter.text) });
          const ch = chapters[chapters.length - 1];
          emit({ e: 'chapter', index: chapters.length, title: ch.title, length: ch.text.length });
          console.log(`[각본] ${chapters.length}장 "${ch.title}" (${ch.text.length}자)`);
          if (resp.more !== false && chapters.length < 15) {
            messages.push({ role: 'user', content: `[CHAPTER ${chapters.length} RECEIVED] Continue with chapter ${chapters.length + 1}. Stay consistent with the PLOT. Set "more":false on the final chapter.` });
            continue;
          }
          // 조립: KP 전용 전체 구조 + 챕터들
          const fullText = (plot ? `[전체 구조 — KP 전용]\n${plot.outline}\n\n` : '')
            + chapters.map(c => `${c.title}\n\n${c.text}`).join('\n\n\n');
          const id = store.newId();
          const sc = {
            id,
            title: (plot && plot.title) || 'AI 시나리오',
            userTitled: true,
            aiWritten: true,
            text: fullText,
            compiled: null,
            createdAt: Date.now(),
          };
          store.writeJSON('scenarios', id, sc);
          console.log(`[각본] "${sc.title}" 완성 — ${chapters.length}개 장, ${fullText.length}자`);
          emit({ e: 'saved', say: String(resp.say || ''), scenario: scenarioSafeView(sc) });
          res.end();
          return;
        }

        if (resp.scenario && resp.scenario.text) {
          const id = store.newId();
          const sc = {
            id,
            title: String(resp.scenario.title || 'AI 시나리오').slice(0, 80),
            userTitled: true,
            aiWritten: true,
            text: String(resp.scenario.text),
            compiled: null,
            createdAt: Date.now(),
          };
          store.writeJSON('scenarios', id, sc);
          console.log(`[각본] "${sc.title}" 생성 완료 (${sc.text.length}자)`);
          emit({ e: 'saved', say: String(resp.say || ''), scenario: scenarioSafeView(sc) });
          res.end();
          return;
        }

        messages.push({ role: 'user', content: 'Invalid response. Respond with valid JSON: questions, rolls, plot, chapter, or scenario.' });
      }
      emit({ e: 'error', message: '작가가 결론을 내지 못했습니다. 다시 시도해주세요.' });
    } catch (err) {
      emit({ e: 'error', message: String(err.message || err) });
    }
    res.end();
  });

  // 핸드아웃 이미지 보관 폴더 (가져온 시나리오가 참조할 수 있음)
  const HANDOUT_DIR = path.join(__dirname, 'data', 'handouts');

  // 저장된 핸드아웃 이미지 서빙
  router.get('/api/handouts/:file', (req, res) => {
    const p = path.join(HANDOUT_DIR, path.basename(req.params.file));
    if (!fs.existsSync(p)) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(p);
  });

  // 이미지 프록시 — 핫링크 차단(리퍼러 검사) 우회용. 패널의 외부 이미지가 이걸 거친다
  router.get('/api/img-proxy', async (req, res) => {
    try {
      const u = String(req.query.u || '').replace(/&amp;/g, '&'); // 옛 마커의 인코딩 잔재 대응
      if (!/^https?:\/\//i.test(u)) return res.status(400).end();
      const r = await fetch(u, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; keepers-parlor)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(45000), // pollinations 생성은 오래 걸릴 수 있음
      });
      if (!r.ok) return res.status(502).end();
      const type = r.headers.get('content-type') || 'application/octet-stream';
      if (!/^image\//i.test(type)) return res.status(415).end();
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 15 * 1024 * 1024) return res.status(413).end();
      res.setHeader('Content-Type', type);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.end(buf);
    } catch {
      res.status(502).end();
    }
  });

  router.post('/api/scenarios', (req, res) => {
    let { name, text } = req.body || {};
    text = typeof text === 'string' ? text : '';
    name = typeof name === 'string' ? name : '';
    if (text.trim().length < 100) return fail(res, 400, '시나리오 텍스트가 너무 짧습니다 (100자 이상).');
    const id = store.newId();
    const userTitled = !!(name || '').trim(); // 직접 지은 제목은 분석해도 안 덮어씀
    const sc = { id, title: (name || '').trim() || '미분석 시나리오', userTitled, text, compiled: null, createdAt: Date.now() };
    store.writeJSON('scenarios', id, sc);
    res.json(scenarioSafeView(sc));
  });

  router.post('/api/scenarios/:id/compile', async (req, res) => {
    const sc = store.readJSON('scenarios', req.params.id);
    if (!sc) return fail(res, 404, '시나리오를 찾을 수 없습니다.');
    const emit = ndjson(res);
    const t0 = Date.now();
    console.log(`[컴파일] 시작: "${sc.title}" (${sc.text.length}자)`);
    try {
      const compiled = await compileScenario({
        text: sc.text,
        settings: store.getSettings(),
        onStatus: text => { console.log(`[컴파일] ${text}`); emit({ e: 'status', text }); },
      });
      sc.compiled = compiled;
      if (!sc.userTitled) sc.title = compiled.title || sc.title; // 사용자가 지은 제목은 보존
      store.writeJSON('scenarios', sc.id, sc);
      const compiledLen = JSON.stringify(compiled).length;
      console.log(`[컴파일] 완료: "${sc.title}" — 장면 ${compiled.scenes.length}개 · NPC ${compiled.npcs.length}명 · 원문 ${sc.text.length}자 → ${compiledLen}자${compiledLen < sc.text.length * 0.6 ? ' ⚠ 압축 의심 (재분석 권장)' : ''} · ${((Date.now() - t0) / 1000).toFixed(1)}초`);
      emit({ e: 'done', scenario: scenarioSafeView(sc) });
    } catch (err) {
      console.error(`[컴파일] 실패: "${sc.title}" — ${String(err.message || err)}`);
      emit({ e: 'error', message: String(err.message || err) });
    }
    res.end();
  });

  router.get('/api/scenarios/:id', (req, res) => {
    const sc = store.readJSON('scenarios', req.params.id);
    if (!sc) return fail(res, 404, '시나리오를 찾을 수 없습니다.');
    res.json(scenarioSafeView(sc));
  });

  // 내보내기 — 분석본 포함 통짜 JSON (다른 키퍼의 방에 가져오기로 공유)
  router.get('/api/scenarios/:id/export', (req, res) => {
    const sc = store.readJSON('scenarios', req.params.id);
    if (!sc) return fail(res, 404, '시나리오를 찾을 수 없습니다.');
    const payload = {
      format: 'keepers-parlor-scenario',
      version: 1,
      exportedAt: Date.now(),
      title: sc.title,
      text: sc.text,
      compiled: sc.compiled || null,
      aiWritten: !!sc.aiWritten,
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="scenario.kp.json"; filename*=UTF-8''${encodeURIComponent(sc.title)}.kp.json`);
    res.end(JSON.stringify(payload, null, 2));
  });

  // 가져오기 — 내보낸 파일 그대로 (분석본 있으면 재분석 불필요)
  router.post('/api/scenarios/import', (req, res) => {
    const d = req.body || {};
    if (d.format !== 'keepers-parlor-scenario' || !d.text) {
      return fail(res, 400, '키퍼의 방 시나리오 파일(.kp.json)이 아닙니다.');
    }
    const id = store.newId();
    const sc = {
      id,
      title: String(d.title || '가져온 시나리오').slice(0, 80),
      userTitled: true,
      aiWritten: !!d.aiWritten,
      text: String(d.text),
      compiled: (d.compiled && typeof d.compiled === 'object') ? d.compiled : null,
      createdAt: Date.now(),
    };
    store.writeJSON('scenarios', id, sc);
    console.log(`[가져오기] 시나리오 "${sc.title}" (${sc.text.length}자, 분석본 ${sc.compiled ? '포함' : '없음'})`);
    res.json(scenarioSafeView(sc));
  });

  // 이름 변경 (직접 지은 제목으로 표시 — 이후 분석해도 안 덮어씀)
  router.put('/api/scenarios/:id', (req, res) => {
    const sc = store.readJSON('scenarios', req.params.id);
    if (!sc) return fail(res, 404, '시나리오를 찾을 수 없습니다.');
    const name = String((req.body || {}).name || '').trim();
    if (!name) return fail(res, 400, '제목이 비어 있습니다.');
    sc.title = name.slice(0, 80);
    sc.userTitled = true;
    store.writeJSON('scenarios', sc.id, sc);
    res.json(scenarioSafeView(sc));
  });

  router.delete('/api/scenarios/:id', (req, res) => {
    store.deleteJSON('scenarios', req.params.id);
    res.json({ ok: true });
  });

  // ── 탐사자 ──────────────────────────────────────────────────
  router.get('/api/investigators', (req, res) => res.json(store.listJSON('investigators')));

  router.post('/api/investigators/generate', (req, res) => {
    const sheet = coc.quickGenerate((req.body || {}).name);
    res.json(sheet);
  });

  router.post('/api/investigators', (req, res) => {
    const id = store.newId();
    const inv = coc.normalizeSheet({ ...(req.body || {}), id });
    inv.createdAt = Date.now();
    store.writeJSON('investigators', id, inv);
    res.json(inv);
  });

  router.put('/api/investigators/:id', (req, res) => {
    const old = store.readJSON('investigators', req.params.id);
    if (!old) return fail(res, 404, '탐사자를 찾을 수 없습니다.');
    // 시트 편집기가 안 다루는 메타 필드(프사/ST 연동/그룹/KPC)는 기존 값 보존
    const body = req.body || {};
    const inv = coc.normalizeSheet({
      ...body,
      id: old.id,
      source: body.source !== undefined ? body.source : old.source,
      stAvatar: body.stAvatar !== undefined ? body.stAvatar : old.stAvatar,
      stGroup: body.stGroup !== undefined ? body.stGroup : old.stGroup,
      customAvatar: body.customAvatar !== undefined ? body.customAvatar : old.customAvatar,
      kpc: body.kpc !== undefined ? body.kpc : old.kpc,
    });
    inv.createdAt = old.createdAt;
    store.writeJSON('investigators', old.id, inv);
    res.json(inv);
  });

  router.delete('/api/investigators/:id', (req, res) => {
    store.deleteJSON('investigators', req.params.id);
    res.json({ ok: true });
  });

  // ── 탐사자 프사 (직접 업로드) ─────────────────────────────────
  const AVATAR_DIR = path.join(__dirname, 'data', 'avatars');

  router.post('/api/investigators/:id/avatar', (req, res) => {
    const inv = store.readJSON('investigators', req.params.id);
    if (!inv) return fail(res, 404, '탐사자를 찾을 수 없습니다.');
    const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/.exec(String((req.body || {}).data || ''));
    if (!m) return fail(res, 400, '이미지 파일이 아닙니다 (png/jpg/webp/gif).');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 4 * 1024 * 1024) return fail(res, 400, '이미지가 너무 큽니다 (4MB 이하).');
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
    const fname = `${inv.id}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    fs.writeFileSync(path.join(AVATAR_DIR, fname), buf);
    inv.customAvatar = fname;
    store.writeJSON('investigators', inv.id, inv);
    res.json(inv);
  });

  router.get('/api/avatars/:file', (req, res) => {
    const p = path.join(AVATAR_DIR, path.basename(req.params.file));
    if (!fs.existsSync(p)) return res.status(404).end();
    res.sendFile(p);
  });

  // ── 세션 ────────────────────────────────────────────────────
  function sessionListView(s) {
    return {
      id: s.id, title: s.title, scenarioId: s.scenarioId, scenarioTitle: s.scenarioTitle,
      createdAt: s.createdAt, ended: s.ended,
      investigators: s.investigators.map(i => i.name),
      turnCount: s.turnCount, historyLength: s.history.length,
    };
  }

  router.get('/api/sessions', (req, res) => res.json(store.listJSON('sessions').map(sessionListView)));

  // 세션 개변 브리프: 시나리오 전제에 맞춰 이 파티의 관계를 재설정하고 장면을 파티에 맞게 조정
  async function buildAdaptBrief(session, compiled) {
    const party = session.investigators.map(i => [
      `- ${i.name} (${i.kpc ? '키퍼가 연기하는 KPC' : '플레이어 조작'}) — ${i.occupation || '직업 미상'}, ${i.age}세${i.gender ? ', ' + i.gender : ''}`,
      i.background ? `  배경: ${i.background}` : '',
      i.stContext ? `  카드 자료: ${i.stContext.slice(0, 2000)}` : '',
    ].filter(Boolean).join('\n')).join('\n');
    const brief = await chat({
      settings: store.getSettings(),
      system: ADAPT_SYSTEM,
      messages: [{ role: 'user', content: adaptUser({ compiled, party }) }],
      json: false,
      maxTokens: 8192,
      temperature: 0.7,
    });
    return String(brief).trim().slice(0, 12000);
  }

  router.post('/api/sessions', async (req, res) => {
    const { scenarioId, investigatorIds, title, playerId } = req.body || {};
    const sc = store.readJSON('scenarios', scenarioId);
    if (!sc) return fail(res, 404, '시나리오를 찾을 수 없습니다.');
    if (!sc.compiled) return fail(res, 400, '먼저 시나리오를 분석(컴파일)해야 합니다.');
    const invs = (investigatorIds || []).map(id => store.readJSON('investigators', id)).filter(Boolean);
    if (invs.length === 0) return fail(res, 400, '탐사자를 최소 1명 선택해야 합니다.');

    // 내 탐사자(직접 조작) 1명 — 나머지는 이 세션에서 KPC(키퍼가 연기).
    // 지정이 없으면 페르소나 출신 → 비KPC → 첫 번째 순으로 추정.
    const player = invs.find(i => i.id === playerId)
      || invs.find(i => i.source === 'st-persona' && !i.kpc)
      || invs.find(i => !i.kpc)
      || invs[0];

    const id = store.newId();
    const session = {
      id,
      title: (title || '').trim() || `${sc.title} — ${invs.map(i => i.name).join(', ')}`,
      scenarioId: sc.id, scenarioTitle: sc.title,
      createdAt: Date.now(), turnCount: 0, ended: null,
      scene: sc.compiled.startingScene,
      flags: {},
      history: [],
      investigators: invs.map(inv => ({
        ...inv,
        kpc: inv.id !== player.id,
        hp: inv.hpMax, san: inv.sanStart, mp: inv.mpMax,
        statuses: [], trackers: {}, items: [],
      })),
    };

    // ST 캐릭터 KPC → 카드/로어북/CHARM 컨텍스트를 세션에 스냅샷
    if (stReady()) {
      for (const inv of session.investigators) {
        if (inv.source === 'st-character' && inv.stAvatar) {
          try {
            const ctx = stReader.buildCharacterContext(inv.stAvatar);
            inv.stContext = ctx.text;
          } catch { /* 카드가 삭제됐으면 컨텍스트 없이 진행 */ }
        }
      }
    }

    // 시나리오 개변: 이 파티에 맞춰 관계 재설정 + 훅/장면 조정 (실패해도 세션은 생성)
    try {
      console.log(`[개변] "${session.title}" — 파티 ${session.investigators.length}명에 맞춰 조정 중`);
      session.adapt = await buildAdaptBrief(session, sc.compiled);
      console.log(`[개변] 완료 (${session.adapt.length}자)`);
    } catch (err) {
      console.error(`[개변] 실패 — 원본 그대로 진행: ${String(err.message || err)}`);
    }

    store.writeJSON('sessions', id, session);
    res.json(sessionListView(session));
  });

  router.get('/api/sessions/:id', (req, res) => {
    const s = store.readJSON('sessions', req.params.id);
    if (!s) return fail(res, 404, '세션을 찾을 수 없습니다.');
    res.json({
      ...sessionListView(s),
      history: s.history,
      state: publicState(s),
      sheets: s.investigators.map(({ stContext, ...rest }) => rest),
      pendingRolls: (s.pendingRolls && s.pendingRolls.length) ? describePendingRolls(s) : null,
      pushable: (s.pushable && s.pushable.length) ? describePushable(s) : null,
      pendingAllocate: s.pendingAllocate || null,
      canUndo: !!s.lastTurn,
    });
  });

  router.delete('/api/sessions/:id', (req, res) => {
    store.deleteJSON('sessions', req.params.id);
    res.json({ ok: true });
  });

  // 턴 실행 공통부 — 동시 실행 방지 락
  const sessionLocks = new Set();

  // 턴 컨텍스트: KPC 동료 자료(카드 스냅샷 또는 시트 요약) + 프리셋 스타일 가이드
  function buildTurnExtras(session) {
    const settings = store.getSettings();
    const extras = {};
    const comps = session.investigators.filter(i => i.kpc);
    if (comps.length) {
      extras.companions = comps.map(c => {
        const profile = c.stContext
          || [`${c.occupation || '직업 미상'} · ${c.age}세${c.gender ? ' · ' + c.gender : ''}`, c.background || '']
            .filter(Boolean).join('\n');
        return `## ${c.name}\n${profile}`;
      }).join('\n\n');
    }
    extras.pace = settings.pace || 'beat';
    extras.narration = settings.narration || 'novel';
    if (settings.provider === 'st' && settings.st && settings.st.usePreset && stReady()) {
      try {
        const st = settings.st;
        const prof = stReader.getConnectionProfile(st.profile);
        // 키퍼 전용 오버라이드: presetDisabled로 뺀 항목 제외 + presetExtra 추가 항목 뒤에
        const disabled = new Set(st.presetDisabled || []);
        const parts = stReader.getPresetEntries(prof.preset)
          .filter(e => e.enabled && !disabled.has(e.identifier))
          .map(e => e.content);
        for (const x of st.presetExtra || []) {
          if (x && x.enabled !== false && x.content) parts.push(String(x.content));
        }
        let preset = parts.join('\n\n');
        if (preset) {
          const player = session.investigators.find(i => !i.kpc);
          preset = preset
            .replace(/\{\{user\}\}/gi, player ? player.name : 'Player')
            .replace(/\{\{char\}\}/gi, '등장인물');
          extras.presetText = preset;
        }
      } catch { /* 프리셋 없으면 스킵 */ }
    }
    return extras;
  }

  // 턴 시작 시점 상태 스냅샷 (리롤/되돌리기용)
  function captureSnapshot(session) {
    return JSON.parse(JSON.stringify({
      scene: session.scene,
      flags: session.flags,
      turnCount: session.turnCount,
      investigators: session.investigators,
      memo: session.memo || null,
      pendingRolls: session.pendingRolls || null,
      pushable: session.pushable || null,
      pendingResults: session.pendingResults || null,
      pendingAllocate: session.pendingAllocate || null,
      historyLen: session.history.length,
    }));
  }

  function restoreSnapshot(session, snap) {
    session.scene = snap.scene;
    session.flags = snap.flags;
    session.turnCount = snap.turnCount;
    session.investigators = snap.investigators;
    session.memo = snap.memo || undefined;
    session.pendingRolls = snap.pendingRolls || null;
    session.pushable = snap.pushable || null;
    session.pendingResults = snap.pendingResults || null;
    session.pendingAllocate = snap.pendingAllocate || null;
    session.history.length = snap.historyLen;
  }

  // buildInput은 { input, playerEntry? } 또는 null(중단)을 반환.
  // playerEntry는 handleTurn이 스냅샷을 뜬 뒤에 push한다 (되돌리기 때 함께 제거되도록).
  async function handleTurn(req, res, buildInput) {
    const session = store.readJSON('sessions', req.params.id);
    if (!session) return fail(res, 404, '세션을 찾을 수 없습니다.');
    if (session.ended) return fail(res, 400, '이미 종료된 세션입니다.');
    if (sessionLocks.has(session.id)) return fail(res, 409, '키퍼가 아직 진행 중입니다. 잠시만요.');
    const sc = store.readJSON('scenarios', session.scenarioId);
    if (!sc || !sc.compiled) return fail(res, 400, '세션의 시나리오를 찾을 수 없습니다.');

    const emit = ndjson(res);
    sessionLocks.add(session.id);
    const t0 = Date.now();
    try {
      const built = buildInput(session, emit); // 리롤은 여기서 이전 상태로 복원까지 수행
      if (!built) { res.end(); return; }
      const snapshot = captureSnapshot(session);
      if (built.playerEntry) {
        built.playerEntry.ts = built.playerEntry.ts || Date.now();
        session.history.push(built.playerEntry);
        emit({ e: 'msg', entry: built.playerEntry });
      }
      session.turnCount++;
      console.log(`[턴] "${session.title}" #${session.turnCount} — ${String(built.input).slice(0, 60)}`);
      const settings = store.getSettings();
      const result = await runTurn({
        compiled: sc.compiled, session, playerInput: built.input,
        settings, emit,
        extras: buildTurnExtras(session),
        pauseForPlayer: settings.playerDice !== false,
      });
      session.lastTurn = { snapshot, input: built.input, playerEntry: built.playerEntry || null };
      console.log(`[턴] "${session.title}" #${session.turnCount} 완료 · ${((Date.now() - t0) / 1000).toFixed(1)}초${result.ended ? ' · 세션 종료' : ''}`);
      emit({ e: 'done', waiting: result.waiting, ended: result.ended });
    } catch (err) {
      console.error(`[턴] "${session.title}" 실패: ${String(err.message || err)}`);
      emit({ e: 'error', message: String(err.message || err) });
    } finally {
      sessionLocks.delete(session.id);
      store.writeJSON('sessions', session.id, session);
      res.end();
    }
  }

  router.post('/api/sessions/:id/start', (req, res) => handleTurn(req, res, (session, emit) => {
    if (session.history.length > 0) {
      emit({ e: 'error', message: '이미 시작된 세션입니다.' });
      return null;
    }
    return { input: '[BEGIN SESSION] Start the session: give the opening narration per the scenario introduction, address the investigators by name, and stop at the first point where player input is needed.' };
  }));

  router.post('/api/sessions/:id/act', (req, res) => handleTurn(req, res, (session, emit) => {
    if (session.pendingAllocate) {
      emit({ e: 'error', message: '먼저 위의 스탯 분배 칸을 채워주세요.' });
      return null;
    }
    if (session.pendingRolls && session.pendingRolls.length) {
      emit({ e: 'error', message: '먼저 요청된 판정을 굴려주세요 (🎲 판정 굴리기 버튼).' });
      return null;
    }
    const { investigatorId, text } = req.body || {};
    if (!text || !text.trim()) { emit({ e: 'error', message: '입력이 비어 있습니다.' }); return null; }
    session.pushable = null; // 푸시 선택지를 두고 그냥 행동하면 기회는 지나간 것
    session.pendingResults = null;
    const inv = session.investigators.find(i => i.id === investigatorId) || session.investigators[0];
    return {
      input: `${inv.name}: ${text.trim()}`,
      playerEntry: { t: 'player', speaker: inv.name, text: text.trim() },
    };
  }));

  router.post('/api/sessions/:id/continue', (req, res) => handleTurn(req, res, (session, emit) => {
    if (session.pendingAllocate) {
      emit({ e: 'error', message: '먼저 위의 스탯 분배 칸을 채워주세요.' });
      return null;
    }
    if (session.pendingRolls && session.pendingRolls.length) {
      emit({ e: 'error', message: '먼저 요청된 판정을 굴려주세요 (🎲 판정 굴리기 버튼).' });
      return null;
    }
    // 푸시 선택 대기 중에 진행을 맡기면 = 결과를 받아들이고 진행
    if (session.pendingResults) {
      const results = session.pendingResults;
      session.pendingResults = null;
      session.pushable = null;
      return { input: rollResultsInput(results) };
    }
    return { input: '[CONTINUE] The players yield the floor. Continue the scenario naturally from where it stands (advance the scene, have NPCs act, or apply due checks).' };
  }));

  // 대기 중인 판정을 플레이어가 굴린다 (playerDice 모드에서 키퍼가 멈춘 지점 재개)
  router.post('/api/sessions/:id/roll-pending', (req, res) => handleTurn(req, res, (session, emit) => {
    if (!session.pendingRolls || !session.pendingRolls.length) {
      emit({ e: 'error', message: '굴릴 판정이 없습니다.' });
      return null;
    }
    const rolls = session.pendingRolls;
    session.pendingRolls = null;
    const results = resolveRolls(session, rolls, emit);
    // 내 판정이 실패했으면 밀어붙이기/행운/그냥 진행을 고를 때까지 키퍼 일시정지
    if (session.pushable && session.pushable.length) {
      session.pendingResults = results;
      emit({ e: 'pushable', options: describePushable(session) });
      emit({ e: 'done', waiting: true, ended: null });
      return null;
    }
    return { input: rollResultsInput(results) };
  }));

  function rollResultsInput(results) {
    return '[ROLL RESULTS] The table rolled the requested checks: '
      + JSON.stringify(results)
      + ' — narrate ONLY the immediate outcome of these checks per the scenario (short), then STOP and yield to the player. Do not advance to the next action, location, or companion initiative.';
  }

  // ── 그냥 진행: 실패를 받아들이고 키퍼에게 결과 서술을 맡긴다 ────
  router.post('/api/sessions/:id/resolve-continue', (req, res) => handleTurn(req, res, (session, emit) => {
    if (!session.pendingResults) { emit({ e: 'error', message: '진행할 판정 결과가 없습니다.' }); return null; }
    const results = session.pendingResults;
    session.pendingResults = null;
    session.pushable = null;
    return { input: rollResultsInput(results) };
  }));

  // ── 스탯 분배 확정: UI에서 채운 값을 트래커로 적용하고 재개 ─────
  router.post('/api/sessions/:id/allocate', (req, res) => handleTurn(req, res, (session, emit) => {
    const pa = session.pendingAllocate;
    if (!pa) { emit({ e: 'error', message: '분배할 스탯이 없습니다.' }); return null; }
    const values = (req.body || {}).values || {};
    let sum = 0;
    const clean = {};
    for (const stat of pa.stats) {
      const v = parseInt(values[stat], 10);
      if (isNaN(v)) { emit({ e: 'error', message: `${stat} 값이 비어 있습니다.` }); return null; }
      if (v < pa.min || v > pa.max) { emit({ e: 'error', message: `${stat}은(는) ${pa.min}~${pa.max} 사이여야 합니다.` }); return null; }
      clean[stat] = v;
      sum += v;
    }
    if (sum !== pa.total) { emit({ e: 'error', message: `합계가 ${pa.total}이어야 합니다 (현재 ${sum}).` }); return null; }
    const inv = session.investigators.find(i => i.id === pa.investigatorId) || session.investigators[0];
    for (const [k, v] of Object.entries(clean)) inv.trackers[k] = v;
    session.pendingAllocate = null;
    const entry = {
      t: 'system',
      text: `⚙ ${inv.name} — 스탯 분배: ${Object.entries(clean).map(([k, v]) => `${k} ${v}`).join(' · ')}`,
      ts: Date.now(),
    };
    session.history.push(entry);
    emit({ e: 'msg', entry });
    emit({ e: 'state', state: publicState(session) });
    return {
      input: `[STAT ALLOCATION] ${inv.name} allocated: ${JSON.stringify(clean)}. Acknowledge in 1-2 short segments at most, then STOP and let the player act — do not advance the scene or introduce anything new.`,
    };
  }));

  // ── 밀어붙이기: 실패한 판정을 대가를 걸고 재굴림 (CoC 7e) ──────
  router.post('/api/sessions/:id/push-roll', (req, res) => handleTurn(req, res, (session, emit) => {
    const list = session.pushable || [];
    const p = list[parseInt((req.body || {}).index, 10) || 0];
    if (!p) { emit({ e: 'error', message: '밀어붙일 판정이 없습니다.' }); return null; }
    session.pushable = null;
    const orig = session.pendingResults
      ? ` Other roll results from this batch (narrate together): ${JSON.stringify(session.pendingResults)}.`
      : '';
    session.pendingResults = null;
    const r = dice.skillCheck({
      name: p.name, value: p.value, difficulty: p.difficulty,
      bonusDice: p.bonusDice, penaltyDice: p.penaltyDice,
    });
    const entry = { t: 'roll', investigator: p.investigator, reason: '🔁 밀어붙이기 (실패 시 혹독한 대가)', data: r, ts: Date.now() };
    session.history.push(entry);
    emit({ e: 'roll', entry });
    return {
      input: `[PUSHED ROLL] ${p.investigator} PUSHED the failed ${p.name} check: ${r.roll}/${p.value} → ${r.levelLabel}. Per CoC 7e pushing rules: if this pushed roll FAILED, impose a severe consequence or complication right now (worse than the original failure); if it succeeded, grant the outcome but note the extra time/risk the push cost.${orig} Narrate ONLY that consequence/outcome (short), then STOP and yield to the player — do not advance to the next beat, arrival, or announcement.`,
    };
  }));

  // ── 행운 소모: 실패를 성공으로 (보통 난이도 판정만, 1점=1) ──────
  router.post('/api/sessions/:id/spend-luck', (req, res) => handleTurn(req, res, (session, emit) => {
    const list = session.pushable || [];
    const p = list[parseInt((req.body || {}).index, 10) || 0];
    if (!p) { emit({ e: 'error', message: '행운을 쓸 판정이 없습니다.' }); return null; }
    if (p.difficulty !== 'regular') { emit({ e: 'error', message: '어려움/극단 판정에는 행운을 쓸 수 없습니다.' }); return null; }
    const inv = findInvestigator(session, p.investigator);
    const cost = p.luckCost;
    if (!inv || cost <= 0 || inv.luck < cost) { emit({ e: 'error', message: '행운이 부족합니다.' }); return null; }
    inv.luck -= cost;
    session.pushable = null;
    const orig = session.pendingResults
      ? ` Other roll results from this batch (narrate together): ${JSON.stringify(session.pendingResults)}.`
      : '';
    session.pendingResults = null;
    const entry = { t: 'system', text: `🍀 ${inv.name} — 행운 ${cost} 소모 (남은 행운 ${inv.luck}) → ${p.name} 판정 성공으로 전환`, ts: Date.now() };
    session.history.push(entry);
    emit({ e: 'msg', entry });
    emit({ e: 'state', state: publicState(session) });
    return {
      input: `[LUCK SPENT] ${inv.name} spent ${cost} Luck points (now ${inv.luck}) to convert the failed ${p.name} check (${p.roll}/${p.value}) into a REGULAR SUCCESS, per CoC 7e optional luck rules. Narrate ONLY the success outcome (short), then STOP and yield to the player.${orig}`,
    };
  }));

  // ── 리롤: 마지막 키퍼 턴을 물리고 다시 (피드백 지시 가능) ──────
  router.post('/api/sessions/:id/reroll', (req, res) => handleTurn(req, res, (session, emit) => {
    const lt = session.lastTurn;
    if (!lt) { emit({ e: 'error', message: '다시 굴릴 턴이 없습니다.' }); return null; }
    const feedback = String((req.body || {}).feedback || '').trim().slice(0, 1000);
    // 거부된 응답 텍스트 (피드백 모드에서 참고용)
    const rejected = session.history.slice(lt.snapshot.historyLen)
      .filter(e => e.t === 'narrator' || e.t === 'npc')
      .map(e => (e.speaker && e.speaker !== '나레이터' ? e.speaker + ': ' : '') + e.text)
      .join('\n');
    restoreSnapshot(session, lt.snapshot);
    emit({ e: 'reset', history: session.history, state: publicState(session) });
    let input = lt.input
      + '\n\n[REROLL] Your previous response to this input was rejected by the table owner. Write a NEW, meaningfully different response to the same input.';
    if (feedback) {
      input += `\n[PREVIOUS RESPONSE (rejected)]\n${rejected.slice(0, 2500)}\n[TABLE OWNER FEEDBACK — apply this]: ${feedback}`;
    }
    return { input, playerEntry: lt.playerEntry ? { ...lt.playerEntry } : null };
  }));

  // ── 되돌리기: 마지막 턴(내 입력 포함)을 없던 일로 ──────────────
  router.post('/api/sessions/:id/undo', (req, res) => {
    const session = store.readJSON('sessions', req.params.id);
    if (!session) return fail(res, 404, '세션을 찾을 수 없습니다.');
    if (sessionLocks.has(session.id)) return fail(res, 409, '키퍼가 진행 중에는 되돌릴 수 없습니다.');
    if (!session.lastTurn) return fail(res, 400, '되돌릴 턴이 없습니다.');
    restoreSnapshot(session, session.lastTurn.snapshot);
    session.lastTurn = null; // 연속 되돌리기는 미지원
    store.writeJSON('sessions', session.id, session);
    console.log(`[되돌리기] "${session.title}" — ${session.history.length}번째 기록으로 복원`);
    res.json({ history: session.history, state: publicState(session), pendingRolls: session.pendingRolls ? describePendingRolls(session) : null });
  });

  // 수치(트래커) 수동 설정/생성 — 스탯 분배 보정용
  router.post('/api/sessions/:id/set-tracker', (req, res) => {
    const session = store.readJSON('sessions', req.params.id);
    if (!session) return fail(res, 404, '세션을 찾을 수 없습니다.');
    if (sessionLocks.has(session.id)) return fail(res, 409, '키퍼가 진행 중입니다. 잠시만요.');
    const { investigatorId, name, value } = req.body || {};
    const inv = session.investigators.find(i => i.id === investigatorId) || session.investigators[0];
    const nm = String(name || '').trim().slice(0, 30);
    if (!nm) return fail(res, 400, '수치 이름이 비어 있습니다.');
    const v = Math.max(0, Math.min(999, parseInt(value, 10) || 0));
    const before = inv.trackers[nm];
    inv.trackers[nm] = v;
    const entry = {
      t: 'system',
      text: `⚙ ${inv.name} — ${nm} ${before === undefined ? '' : before + ' → '}${v} (수동 설정)`,
      ts: Date.now(),
    };
    session.history.push(entry);
    store.writeJSON('sessions', session.id, session);
    res.json({ entry, state: publicState(session) });
  });

  // 수동 주사위
  router.post('/api/sessions/:id/roll', (req, res) => {
    const session = store.readJSON('sessions', req.params.id);
    if (!session) return fail(res, 404, '세션을 찾을 수 없습니다.');
    try {
      const r = dice.evalExpr((req.body || {}).expr || '1d100');
      const entry = {
        t: 'roll', investigator: (req.body || {}).who || '', reason: '수동 굴림',
        data: { kind: 'dice', expr: r.expr, total: r.total, detail: r.detail }, ts: Date.now(),
      };
      session.history.push(entry);
      store.writeJSON('sessions', session.id, session);
      res.json({ entry });
    } catch (err) {
      fail(res, 400, String(err.message || err));
    }
  });

  return router;
}

module.exports = { attach };
