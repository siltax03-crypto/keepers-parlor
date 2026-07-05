// ── 키퍼 오케스트레이션: LLM ↔ 주사위 엔진 ↔ 게임 상태 ──────────
const dice = require('./dice');
const { BASE_SKILLS } = require('./coc');
const { chat, parseJSON } = require('./llm');
const { buildKeeperSystem, keeperTurnUser, rollResultsUser, MEMO_SYSTEM, memoUser } = require('./prompts');

const MAX_ITERATIONS = 6;
const TRANSCRIPT_LIMIT = 60;   // 항상 원문으로 보여줄 최근 기록
const MEMO_TRIGGER = 30;       // 이만큼 밀려나면 메모로 압축
const TRANSCRIPT_HARD_MAX = 120;

const CHAR_MAP = {
  '근력': 'STR', '건강': 'CON', '체력': 'CON', '크기': 'SIZ', '민첩': 'DEX',
  '외모': 'APP', '지능': 'INT', '아이디어': 'INT', '정신력': 'POW', '교육': 'EDU',
};

function findInvestigator(session, name) {
  if (!name) return session.investigators[0];
  const exact = session.investigators.find(i => i.name === name);
  if (exact) return exact;
  return session.investigators.find(i => i.name.includes(name) || name.includes(i.name)) || session.investigators[0];
}

function lookupValue(inv, name, llmValue) {
  if (!inv) return llmValue || 20;
  const n = String(name || '').trim();
  for (const [k, stat] of Object.entries(CHAR_MAP)) {
    if (n === k || n.startsWith(k)) return inv.stats[stat];
  }
  if (/행운/.test(n)) return inv.luck;
  if (inv.skills[n] != null) return inv.skills[n];
  const partial = Object.keys(inv.skills).find(k => k.includes(n) || n.includes(k));
  if (partial) return inv.skills[partial];
  if (BASE_SKILLS[n] != null) return BASE_SKILLS[n];
  if (llmValue > 0) return llmValue;
  return 20;
}

function stateForLLM(session) {
  return {
    scene: session.scene,
    flags: session.flags,
    turnCount: session.turnCount,
    ended: session.ended,
    investigators: session.investigators.map(inv => ({
      name: inv.name, occupation: inv.occupation, age: inv.age, gender: inv.gender,
      controlledBy: inv.kpc ? 'keeper' : 'player',
      stats: inv.stats, luck: inv.luck,
      hp: inv.hp, hpMax: inv.hpMax, san: inv.san, mp: inv.mp, mpMax: inv.mpMax,
      db: inv.db, skills: inv.skills,
      statuses: inv.statuses, trackers: inv.trackers, items: inv.items,
      background: inv.background || undefined,
    })),
  };
}

function entriesToText(entries) {
  return entries.map(en => {
    if (en.t === 'roll') {
      const d = en.data;
      if (d.kind === 'san') return `🎲 [SAN 체크] ${en.investigator}: ${d.roll}/${d.san} → ${d.levelLabel}, SAN ${d.lost} 감소`;
      if (d.kind === 'opposed') return `🎲 [대항] ${d.aLabel}(${d.a.roll}/${d.a.value} ${d.a.levelLabel}) vs ${d.bLabel}(${d.b.roll}/${d.b.value} ${d.b.levelLabel}) → ${d.winner === 'a' ? d.aLabel : d.winner === 'b' ? d.bLabel : '무승부'} 승`;
      if (d.kind === 'dice') return `🎲 [주사위] ${d.expr} = ${d.total}`;
      return `🎲 [판정] ${en.investigator} ${d.name}(${d.difficultyLabel}): ${d.roll}/${d.value} → ${d.levelLabel}`;
    }
    if (en.t === 'player') return `${en.speaker}: ${en.text}`;
    if (en.t === 'panel') return `[오브젝트 패널 표시됨] ${en.alt || ''}`;
    if (en.t === 'narrator') return `[나레이터] ${en.text}`;
    if (en.t === 'npc') return `${en.speaker}: "${en.text}"`;
    if (en.t === 'system') return `[시스템] ${en.text}`;
    return '';
  }).filter(Boolean).join('\n');
}

// 최근 기록: 메모가 커버하는 지점부터 (빈틈 없이), 상한만 둔다
function transcriptText(session) {
  const upTo = (session.memo && session.memo.upTo) || 0;
  const start = Math.max(upTo, session.history.length - TRANSCRIPT_HARD_MAX);
  return entriesToText(session.history.slice(start));
}

// 오래된 기록을 세션 메모로 압축 (실패해도 턴은 계속)
async function updateMemo({ session, settings, emit }) {
  const upTo = (session.memo && session.memo.upTo) || 0;
  const cutoff = session.history.length - TRANSCRIPT_LIMIT;
  if (cutoff - upTo < MEMO_TRIGGER) return;
  try {
    emit({ e: 'status', text: '키퍼가 지난 일들을 기록해 두는 중…' });
    const chunkText = entriesToText(session.history.slice(upTo, cutoff));
    const text = await chat({
      settings,
      system: MEMO_SYSTEM,
      messages: [{ role: 'user', content: memoUser(session.memo && session.memo.text, chunkText) }],
      json: false,
      maxTokens: 4096,
      temperature: 0.3,
    });
    session.memo = { text: String(text).trim().slice(0, 8000), upTo: cutoff };
    console.log(`[메모] "${session.title}" — ${cutoff}번째 기록까지 압축 (${session.memo.text.length}자)`);
  } catch (err) {
    console.error(`[메모] 요약 실패 (턴은 계속): ${String(err.message || err)}`);
  }
}

function pushEntry(session, entry, emit) {
  entry.ts = Date.now();
  session.history.push(entry);
  emit({ e: entry.t === 'roll' ? 'roll' : 'msg', entry });
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function applyUpdates(session, updates, emit) {
  if (!updates || typeof updates !== 'object') return;
  const notes = [];
  if (updates.scene && updates.scene !== session.scene) {
    session.scene = updates.scene;
  }
  if (updates.flags && typeof updates.flags === 'object') {
    Object.assign(session.flags, updates.flags);
  }
  if (updates.investigators && typeof updates.investigators === 'object') {
    for (const [name, u] of Object.entries(updates.investigators)) {
      const inv = findInvestigator(session, name);
      if (!inv || !u) continue;
      if (u.hpDelta) { inv.hp = clamp(inv.hp + (u.hpDelta | 0), 0, inv.hpMax); notes.push(`${inv.name} 체력 ${u.hpDelta > 0 ? '+' : ''}${u.hpDelta} → ${inv.hp}/${inv.hpMax}`); }
      if (u.sanDelta) { inv.san = clamp(inv.san + (u.sanDelta | 0), 0, 99); notes.push(`${inv.name} SAN ${u.sanDelta > 0 ? '+' : ''}${u.sanDelta} → ${inv.san}`); }
      if (u.mpDelta) { inv.mp = clamp(inv.mp + (u.mpDelta | 0), 0, inv.mpMax); }
      if (u.luckDelta) { inv.luck = clamp(inv.luck + (u.luckDelta | 0), 0, 99); }
      if (u.trackers && typeof u.trackers === 'object') {
        for (const [tk, delta] of Object.entries(u.trackers)) {
          inv.trackers[tk] = Math.max(0, (inv.trackers[tk] || 0) + (delta | 0));
          notes.push(`${inv.name} ${tk}: ${inv.trackers[tk]}`);
        }
      }
      for (const s of [].concat(u.addStatus || [])) { if (s && !inv.statuses.includes(s)) { inv.statuses.push(s); notes.push(`${inv.name} 상태: ${s}`); } }
      for (const s of [].concat(u.removeStatus || [])) {
        const idx = inv.statuses.findIndex(x => x === s || x.includes(s));
        if (idx >= 0) { notes.push(`${inv.name} 상태 해제: ${inv.statuses[idx]}`); inv.statuses.splice(idx, 1); }
      }
      for (const it of [].concat(u.addItem || [])) { if (it && !inv.items.includes(it)) { inv.items.push(it); notes.push(`${inv.name} 획득: ${it}`); } }
      for (const it of [].concat(u.removeItem || [])) {
        const idx = inv.items.findIndex(x => x === it || x.includes(it));
        if (idx >= 0) { notes.push(`${inv.name} 상실: ${inv.items[idx]}`); inv.items.splice(idx, 1); }
      }
    }
  }
  if (notes.length) pushEntry(session, { t: 'system', text: notes.join(' · ') }, emit);
  emit({ e: 'state', state: publicState(session) });
}

function publicState(session) {
  return {
    scene: session.scene,
    ended: session.ended,
    investigators: session.investigators.map(inv => ({
      id: inv.id, name: inv.name, occupation: inv.occupation,
      kpc: !!inv.kpc, stAvatar: inv.stAvatar || '', customAvatar: inv.customAvatar || '',
      hp: inv.hp, hpMax: inv.hpMax, san: inv.san, sanMax: inv.sanStart,
      mp: inv.mp, mpMax: inv.mpMax, luck: inv.luck,
      statuses: inv.statuses, trackers: inv.trackers, items: inv.items,
    })),
  };
}

// CoC 7e 광기 발작 테이블 (1d10, 실시간)
const MADNESS_BOUTS = [
  '기억상실 — 직전 기억을 잃고 낯선 곳에서 정신이 든다',
  '신체화 증상 — 심인성 실명·마비·감각 상실',
  '폭력 충동 — 주변(적아 불문)에게 파괴적 폭력을 터뜨린다',
  '편집증 — 모두가 나를 속이고 감시한다고 확신한다',
  '중요한 사람 — 소중한 인물과 관련된 망상에 사로잡혀 그에게 가려 한다',
  '실신 — 그 자리에서 정신을 잃고 쓰러진다',
  '공황 도주 — 수단을 가리지 않고 그 자리에서 도망친다',
  '신체 히스테리 — 비명·오열·웃음 발작 등 격렬한 감정 폭발',
  '공포증 발현 — 새로운 공포증이 생기고 대상이 곁에 있다고 느낀다',
  '조증 집착 — 새로운 집착(마니아)이 생겨 그 행동에 몰두한다',
];

function resolveRolls(session, rolls, emit) {
  const results = [];
  const pushable = [];
  for (const req of rolls) {
    try {
      if (req.kind === 'san') {
        const inv = findInvestigator(session, req.investigator);
        const r = dice.sanCheck({ san: inv.san, loss: req.loss });
        inv.san = clamp(inv.san - r.lost, 0, 99);
        const data = { ...r, sanAfter: inv.san };
        pushEntry(session, { t: 'roll', investigator: inv.name, reason: req.reason, data }, emit);
        results.push({ kind: 'san', investigator: inv.name, roll: r.roll, success: r.success, sanLost: r.lost, sanNow: inv.san });
        // 7e: 한 번에 SAN 5+ 상실 → INT 판정 성공(상황을 이해해버림) 시 일시적 광기
        if (r.lost >= 5) {
          const intR = dice.skillCheck({ name: '지능(광기 판정)', value: inv.stats.INT });
          pushEntry(session, { t: 'roll', investigator: inv.name, reason: 'SAN 5+ 상실 — 광기 판정 (성공 시 발작)', data: intR }, emit);
          if (intR.success) {
            const bout = dice.rollDie(10);
            const symptom = MADNESS_BOUTS[bout - 1];
            const label = symptom.split(' — ')[0];
            if (!inv.statuses.includes(`일시적 광기: ${label}`)) inv.statuses.push(`일시적 광기: ${label}`);
            pushEntry(session, { t: 'system', text: `🧠 ${inv.name} — 일시적 광기 발작! (1d10=${bout}) ${symptom}` }, emit);
            results.push({
              kind: 'madness', investigator: inv.name, bout, symptom,
              note: 'TEMPORARY INSANITY: roleplay this bout of madness NOW per CoC 7e (it lasts a short while); the investigator acts out the symptom before regaining control.',
            });
          }
        }
      } else if (req.kind === 'opposed') {
        const aInv = findInvestigator(session, req.aInvestigator);
        const aValue = req.aValue > 0 ? req.aValue : lookupValue(aInv, req.aName, req.aValue);
        const r = dice.opposedCheck({
          aName: req.aName, aValue,
          bName: req.bName, bValue: req.bValue || 50,
          aLabel: `${aInv ? aInv.name : ''} ${req.aName}`.trim(),
          bLabel: `${req.bOwner || ''} ${req.bName}`.trim(),
        });
        pushEntry(session, { t: 'roll', investigator: aInv ? aInv.name : '', reason: req.reason, data: r }, emit);
        results.push({
          kind: 'opposed', aLabel: r.aLabel, bLabel: r.bLabel,
          a: { roll: r.a.roll, value: r.a.value, level: r.a.levelLabel },
          b: { roll: r.b.roll, value: r.b.value, level: r.b.levelLabel },
          winner: r.winner === 'a' ? r.aLabel : r.winner === 'b' ? r.bLabel : null,
        });
      } else if (req.kind === 'dice') {
        const r = dice.evalExpr(req.expr);
        const data = { kind: 'dice', expr: req.expr, total: r.total, detail: r.detail };
        pushEntry(session, { t: 'roll', investigator: '', reason: req.reason, data }, emit);
        results.push({ kind: 'dice', expr: req.expr, total: r.total, reason: req.reason });
      } else {
        // skill / characteristic
        const inv = findInvestigator(session, req.investigator);
        const value = lookupValue(inv, req.name, req.value);
        const r = dice.skillCheck({
          name: req.name, value,
          difficulty: req.difficulty || 'regular',
          bonusDice: req.bonusDice || 0, penaltyDice: req.penaltyDice || 0,
        });
        pushEntry(session, { t: 'roll', investigator: inv ? inv.name : '', reason: req.reason, data: r }, emit);
        results.push({
          kind: 'skill', investigator: inv ? inv.name : '', name: req.name,
          value, roll: r.roll, level: r.level, levelLabel: r.levelLabel,
          difficulty: r.difficulty, success: r.success,
        });
        // 플레이어 탐사자의 실패한 기능 판정 → 밀어붙이기/행운 소모 후보
        // (펌블은 밀 수 없고, 행운/SAN/크툴루 신화는 행운 소모 불가 — 7e)
        if (inv && !inv.kpc && !r.success && r.level !== 'fumble'
          && !/행운|크툴루/.test(String(req.name))) {
          pushable.push({
            investigator: inv.name, name: req.name, value,
            roll: r.roll, difficulty: req.difficulty || 'regular',
            bonusDice: req.bonusDice || 0, penaltyDice: req.penaltyDice || 0,
            luckCost: r.roll - value,
          });
        }
      }
    } catch (err) {
      results.push({ kind: 'error', request: req, error: String(err.message || err) });
    }
  }
  // 푸시 후보는 세션에만 기록 — 알림/일시정지 여부는 호출부가 결정
  session.pushable = pushable.length ? pushable : null;
  emit({ e: 'state', state: publicState(session) });
  return results;
}

// 밀어붙이기/행운 소모 후보를 UI 라벨로
function describePushable(session) {
  return (session.pushable || []).map((p, i) => {
    const inv = findInvestigator(session, p.investigator);
    const luckOk = p.difficulty === 'regular' && inv && inv.luck >= p.luckCost && p.luckCost > 0;
    return {
      index: i,
      label: `${p.name} 실패 (${p.roll}/${p.value}) — ${p.investigator}`,
      luckCost: luckOk ? p.luckCost : null,
    };
  });
}

// 플레이어(직접 조작) 탐사자의 판정인지 — 그 판정은 플레이어가 굴린다
function isPlayerRoll(session, req) {
  if (!req || req.kind === 'dice') return false;
  const name = req.kind === 'opposed' ? req.aInvestigator : req.investigator;
  const inv = findInvestigator(session, name);
  return !!inv && !inv.kpc;
}

// 대기 중인 판정 요청을 사람이 읽을 라벨로
function describePendingRolls(session) {
  const DIFF = { hard: '어려움', extreme: '극단' };
  return (session.pendingRolls || []).map(r => {
    if (r.kind === 'san') return `SAN 체크 — ${findInvestigator(session, r.investigator).name}`;
    if (r.kind === 'opposed') return `대항 판정: ${r.aName || ''} — ${findInvestigator(session, r.aInvestigator).name}`;
    if (r.kind === 'dice') return `주사위 ${r.expr}`;
    const inv = findInvestigator(session, r.investigator);
    return `${r.name}${DIFF[r.difficulty] ? ` (${DIFF[r.difficulty]})` : ''} — ${inv ? inv.name : ''}`;
  });
}

// ── 장면 윈도우: 큰 시나리오는 현재 장면 + 인접 장면만 원문, 나머지는 요약 골격 ──
const WINDOW_THRESHOLD = 20000; // 컴파일 JSON이 이보다 작으면 통째로 준다

function windowCompiled(compiled, session) {
  try {
    if (!compiled || !Array.isArray(compiled.scenes) || compiled.scenes.length <= 2) return { view: compiled, note: '' };
    if (JSON.stringify(compiled).length <= WINDOW_THRESHOLD) return { view: compiled, note: '' };

    const cur = compiled.scenes.find(s => s.id === session.scene) || compiled.scenes[0];
    const keep = new Set([cur.id, compiled.startingScene]);
    // 현재 장면이 이어질 수 있는 장면들(exits/kpNotes에 언급된 id)은 원문 유지
    const refText = JSON.stringify([cur.exits, cur.kpNotes]) + String(cur.text || '').slice(-800);
    for (const m of refText.matchAll(/\bs\d+\b/gi)) keep.add(m[0]);

    const scenes = compiled.scenes.map(s => keep.has(s.id) ? s : {
      id: s.id,
      title: s.title,
      summary: s.summary || String(s.text || '').slice(0, 200),
      checks: s.checks,
      exits: s.exits,
      trimmed: true,
    });
    const view = { ...compiled, scenes };
    const note = `CONTEXT WINDOW: to save tokens, only the current scene (${cur.id}) and its adjacent scenes carry full "text"; scenes marked "trimmed" show only a summary. Their full text will be provided automatically on the next turn once "scene" moves there — so when play transitions to a trimmed scene, set stateUpdates.scene to it and end your response at the transition (do not improvise the trimmed scene's content from its summary).`;
    return { view, note };
  } catch {
    return { view: compiled, note: '' };
  }
}

// 한 턴 실행: 플레이어 입력 → (LLM → 주사위 → LLM …) → 대기/엔딩
// extras: { companions?: string, presetText?: string, pace?: string } — ST/설정 컨텍스트
// pauseForPlayer: 플레이어 탐사자 판정이 요청되면 굴리지 않고 멈춤 (UI의 🎲 버튼으로 재개)
async function runTurn({ compiled, session, playerInput, settings, emit, extras = {}, pauseForPlayer = false }) {
  await updateMemo({ session, settings, emit }); // 오래된 기록이 쌓였으면 먼저 압축
  const system = buildKeeperSystem({ presetText: extras.presetText, pace: extras.pace, narration: extras.narration });
  const win = windowCompiled(compiled, session); // 큰 시나리오는 현재 장면 중심으로 창을 낸다
  const messages = [{
    role: 'user',
    content: keeperTurnUser({
      compiled: win.view,
      windowNote: win.note,
      state: stateForLLM(session),
      transcript: transcriptText(session),
      playerInput,
      companions: extras.companions || '',
      memo: (session.memo && session.memo.text) || '',
      adapt: session.adapt || '',
      paceHint: extras.pace !== 'flow'
        ? 'INTERACTIVE TEMPO IS BINDING: this response covers ONE scene beat — hard limit 3 segments (+1 panel). One NPC entrance OR one revelation OR one exchange, never several. End by yielding to the player. Never narrate the player investigator\'s own actions or thoughts beyond what they typed.'
        : '',
    }),
  }];

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    emit({ e: 'status', text: iter === 0 ? '키퍼가 상황을 살피는 중…' : '키퍼가 판정 결과를 반영하는 중…' });
    const raw = await chat({ settings, system, messages, json: true, maxTokens: 16384, temperature: 0.85 });
    let resp;
    try {
      resp = parseJSON(raw);
    } catch (err) {
      pushEntry(session, { t: 'system', text: '⚠ 키퍼 응답 해석 실패. 다시 입력해 주세요.' }, emit);
      throw err;
    }
    messages.push({ role: 'assistant', content: raw });

    for (const seg of resp.segments || []) {
      if (!seg) continue;
      // 다이어제틱 패널 (핸드아웃/오브젝트 HTML)
      if (seg.panel) {
        pushEntry(session, { t: 'panel', html: String(seg.panel), alt: String(seg.alt || '극중 오브젝트') }, emit);
        continue;
      }
      if (!seg.text) continue;
      const isNarrator = !seg.speaker || /^narrator$|^나레이/i.test(seg.speaker);
      pushEntry(session, {
        t: isNarrator ? 'narrator' : 'npc',
        speaker: isNarrator ? '나레이터' : seg.speaker,
        text: String(seg.text),
      }, emit);
    }

    applyUpdates(session, resp.stateUpdates, emit);

    if (resp.ending && resp.ending.id) {
      session.ended = { id: resp.ending.id, title: resp.ending.title || '', ts: Date.now() };
      pushEntry(session, { t: 'system', text: `🏁 시나리오 종료 — ${resp.ending.id}${resp.ending.title ? ': ' + resp.ending.title : ''}` }, emit);
      emit({ e: 'state', state: publicState(session) });
      return { waiting: false, ended: session.ended };
    }

    // 스탯 분배 요청 → UI로 (숫자를 나레이션으로 받지 않는다)
    if (resp.allocate && Array.isArray(resp.allocate.stats) && resp.allocate.stats.length) {
      const a = resp.allocate;
      const inv = findInvestigator(session, a.investigator);
      // fixed 값은 즉시 적용
      if (a.fixed && typeof a.fixed === 'object') {
        for (const [k, v] of Object.entries(a.fixed)) {
          const nv = parseInt(v, 10);
          if (!isNaN(nv) && String(k).trim()) inv.trackers[String(k).trim().slice(0, 30)] = Math.max(0, Math.min(999, nv));
        }
      }
      session.pendingAllocate = {
        investigatorId: inv.id,
        investigator: inv.name,
        total: Math.max(1, parseInt(a.total, 10) || 100),
        min: Math.max(0, parseInt(a.min, 10) || 0),
        max: Math.min(999, parseInt(a.max, 10) || 999),
        stats: a.stats.map(s => String(s).trim().slice(0, 20)).filter(Boolean).slice(0, 8),
      };
      emit({ e: 'state', state: publicState(session) });
      emit({ e: 'allocate', req: session.pendingAllocate });
      return { waiting: true, ended: null };
    }

    if (Array.isArray(resp.rolls) && resp.rolls.length > 0) {
      // 플레이어 탐사자의 판정 → 자동으로 굴리지 않고 UI에 넘긴다 (🎲 버튼으로 재개)
      if (pauseForPlayer && resp.rolls.some(r => isPlayerRoll(session, r))) {
        session.pendingRolls = resp.rolls;
        emit({ e: 'pending', rolls: describePendingRolls(session) });
        return { waiting: true, ended: null, pending: true };
      }
      const results = resolveRolls(session, resp.rolls, emit);
      if (!pauseForPlayer) session.pushable = null; // 자동 진행 모드에선 푸시 선택지 없음
      messages.push({ role: 'user', content: rollResultsUser(results) });
      continue;
    }

    return { waiting: true, ended: null };
  }

  pushEntry(session, { t: 'system', text: '⚠ 키퍼가 판정을 너무 길게 이어가 턴을 강제 종료했습니다. 계속 진행해 주세요.' }, emit);
  return { waiting: true, ended: null };
}

module.exports = { runTurn, publicState, resolveRolls, stateForLLM, describePendingRolls, describePushable, findInvestigator, windowCompiled };
