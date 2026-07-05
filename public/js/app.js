// ── 로비: 세션/시나리오/탐사자/설정 ─────────────────────────────
'use strict';

Themes.renderPicker(document.getElementById('theme-picker'));

let scenarios = [], investigators = [], sessions = [], settings = null;

// ── 메인 탭 ─────────────────────────────────────────────────────
const TAB_SECTIONS = {
  sessions: 'sec-sessions',
  scenarios: 'sec-scenarios',
  investigators: 'sec-investigators',
  settings: 'sec-settings',
};
function switchTab(tab) {
  if (!TAB_SECTIONS[tab]) tab = 'sessions';
  for (const [t, secId] of Object.entries(TAB_SECTIONS)) {
    document.getElementById(secId).classList.toggle('hidden', t !== tab);
  }
  document.querySelectorAll('#main-tabs .tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab));
  localStorage.setItem('kp-tab', tab);
}
document.querySelectorAll('#main-tabs .tab-btn').forEach(b =>
  b.addEventListener('click', () => switchTab(b.dataset.tab)));
switchTab(localStorage.getItem('kp-tab') || 'sessions');

// ── 전역 진행바 (분석/시트 생성/세션 준비 등) ───────────────────
const Progress = (() => {
  let bar = null, fill = null, label = null, timer = null;
  function ensure() {
    if (bar) return;
    fill = el('div', { class: 'gprog-fill' });
    label = el('span', { class: 'gprog-label' });
    bar = el('div', { class: 'gprog' }, fill, label);
    document.body.appendChild(bar);
  }
  return {
    set(pct, text) {
      ensure();
      bar.classList.add('show');
      fill.style.width = Math.min(100, pct).toFixed(1) + '%';
      if (text) label.textContent = text;
    },
    // 시간 기반 점근 게이지 (정확한 진행률이 없는 LLM 작업용)
    auto(text, expectSec = 45) {
      ensure();
      clearInterval(timer);
      const t0 = Date.now();
      this.set(2, text);
      timer = setInterval(() => {
        const sec = (Date.now() - t0) / 1000;
        this.set(Math.min(95, 100 * (1 - Math.exp(-sec / (expectSec * 0.65)))), text);
      }, 400);
    },
    done() {
      clearInterval(timer);
      timer = null;
      if (!bar) return;
      fill.style.width = '100%';
      setTimeout(() => bar.classList.remove('show'), 600);
    },
  };
})();

async function loadAll() {
  [scenarios, investigators, sessions, settings] = await Promise.all([
    API.get('/api/scenarios'), API.get('/api/investigators'),
    API.get('/api/sessions'), API.get('/api/settings'),
  ]);
  renderSessions(); renderScenarios(); renderInvestigators(); renderSettings();
}

// ── 세션 (슬림 카드 + 완료 세션 접기) ──────────────────────────
function makeSessionCard(s) {
  return el('div', { class: 'card card-click card-slim' + (s.ended ? ' card-ended' : ''), onclick: () => location.href = apiUrl('/play.html?id=' + s.id) },
    el('div', { class: 'slim-row' },
      el('span', { class: 'card-title slim-title' }, s.title),
      s.ended
        ? el('span', { class: 'chip chip-end' }, `🏁 ${s.ended.id}`)
        : el('span', { class: 'chip chip-live' }, s.historyLength ? '진행 중' : '시작 전')),
    el('div', { class: 'card-sub muted small' }, `📜 ${s.scenarioTitle} · ${fmtDate(s.createdAt)}`),
    el('button', { class: 'card-del', title: '세션 삭제', onclick: async e => {
      e.stopPropagation();
      if (!confirm(`세션 "${s.title}"을(를) 삭제할까요?`)) return;
      await API.del('/api/sessions/' + s.id);
      toast('세션을 삭제했습니다.');
      loadAll();
    } }, '✕'),
  );
}

function renderSessions() {
  const holder = document.getElementById('session-list');
  holder.innerHTML = '';
  if (!sessions.length) {
    holder.appendChild(el('div', { class: 'empty' }, '아직 세션이 없습니다. 시나리오와 탐사자를 준비하고 새 세션을 열어보세요.'));
    return;
  }
  const active = sessions.filter(s => !s.ended);
  const ended = sessions.filter(s => s.ended);
  for (const s of active) holder.appendChild(makeSessionCard(s));
  if (!active.length) holder.appendChild(el('div', { class: 'empty' }, '진행 중인 세션이 없습니다.'));
  if (ended.length) {
    const key = 'kp-ended-sessions';
    let open = localStorage.getItem(key) === 'open'; // 기본 접힘
    const grid = el('div', { class: 'card-grid inv-group-grid' }, ended.map(makeSessionCard));
    const arrow = el('span', { class: 'group-arrow' }, open ? '▾' : '▸');
    const head = el('button', { class: 'inv-group-head' },
      arrow, el('strong', {}, '🏁 완료된 세션'), el('span', { class: 'muted small' }, `${ended.length}개`));
    head.addEventListener('click', () => {
      open = !open;
      localStorage.setItem(key, open ? 'open' : 'closed');
      grid.classList.toggle('hidden', !open);
      arrow.textContent = open ? '▾' : '▸';
    });
    grid.classList.toggle('hidden', !open);
    holder.appendChild(el('div', { class: 'inv-group' }, head, grid));
  }
}

document.getElementById('btn-new-session').addEventListener('click', async () => {
  const ready = scenarios.filter(s => s.compiled);
  if (!ready.length) return toast('먼저 시나리오를 추가하고 분석해주세요.', 'warn');
  if (!investigators.length) return toast('먼저 탐사자를 만들어주세요.', 'warn');

  // 페르소나 커넥션 (동료 자동 필터용)
  let stPersonas = [];
  try { stPersonas = await API.get('/api/st/personas'); } catch { /* ST 미연동 */ }

  let chosenScenario = ready[0].id;
  const chosenInvs = new Set();

  const scSel = el('div', { class: 'pick-list' },
    ready.map(s => {
      const b = el('button', { class: 'pick-item', 'data-id': s.id },
        el('strong', {}, s.title),
        el('span', { class: 'muted' }, s.summarySafe || ''),
        s.meta ? el('span', { class: 'muted small' }, [s.meta.players, s.meta.playtime, s.meta.background].filter(Boolean).join(' · ')) : null);
      b.addEventListener('click', () => {
        chosenScenario = s.id;
        scSel.querySelectorAll('.pick-item').forEach(x => x.classList.toggle('picked', x.dataset.id === s.id));
      });
      return b;
    }));
  scSel.querySelector('.pick-item').classList.add('picked');

  // 내 탐사자 = 페르소나 출신만 (없으면 비KPC → 전체 폴백)
  const personaInvs = investigators.filter(i => i.source === 'st-persona');
  const playerList = personaInvs.length ? personaInvs
    : (investigators.filter(i => !i.kpc).length ? investigators.filter(i => !i.kpc) : investigators);
  let playerId = playerList[0].id;
  let showAllComp = false;

  function invLabel(i) {
    return [
      el('strong', {}, i.name),
      el('span', { class: 'muted' }, `${i.occupation || '무직'} · 체력 ${i.hpMax} · SAN ${i.sanStart}`),
    ];
  }

  // 선택한 페르소나의 ST 커넥션 (연결된 캐릭터 아바타 집합)
  function connectionsOf(pid) {
    const inv = investigators.find(i => i.id === pid);
    if (!inv || !inv.stAvatar) return null;
    const p = stPersonas.find(x => x.avatar === inv.stAvatar);
    if (!p || !Array.isArray(p.connections) || !p.connections.length) return null;
    return new Set(p.connections.map(String));
  }

  const playerSel = el('div', { class: 'pick-list' },
    playerList.map(i => {
      const b = el('button', { class: 'pick-item', 'data-id': i.id }, invLabel(i));
      b.addEventListener('click', () => {
        playerId = i.id;
        chosenInvs.delete(i.id);
        renderRoles();
        renderComp(); // 페르소나가 바뀌면 커넥션 필터도 갱신
      });
      return b;
    }));

  const compSel = el('div', { class: 'pick-list' });
  function renderComp() {
    compSel.innerHTML = '';
    const base = investigators.filter(i => i.id !== playerId);
    const conn = connectionsOf(playerId);
    let list = base;
    if (conn && !showAllComp) {
      list = base.filter(i => i.stAvatar
        && (conn.has(i.stAvatar) || conn.has(i.stAvatar.replace(/\.[^/.]+$/, ''))));
    }
    if (conn) {
      const toggle = el('button', { class: 'btn btn-ghost btn-sm' },
        showAllComp ? '🔗 연결된 동료만' : `전체 보기 (${base.length})`);
      toggle.addEventListener('click', () => { showAllComp = !showAllComp; renderComp(); });
      compSel.appendChild(el('div', { class: 'st-filter-row' },
        el('span', { class: 'muted small' },
          showAllComp ? '전체 탐사자 표시 중' : `이 페르소나에 연결된 캐릭터만 (${list.length})`),
        toggle));
    }
    if (!list.length) compSel.appendChild(el('div', { class: 'empty' }, '표시할 동료가 없습니다.'));
    for (const i of list) {
      const b = el('button', { class: 'pick-item', 'data-id': i.id }, invLabel(i));
      b.addEventListener('click', () => {
        if (chosenInvs.has(i.id)) chosenInvs.delete(i.id);
        else chosenInvs.add(i.id);
        renderRoles();
      });
      compSel.appendChild(b);
    }
    renderRoles();
  }

  function renderRoles() {
    playerSel.querySelectorAll('.pick-item').forEach(x =>
      x.classList.toggle('picked', x.dataset.id === playerId));
    compSel.querySelectorAll('.pick-item').forEach(x =>
      x.classList.toggle('picked', chosenInvs.has(x.dataset.id)));
  }
  renderComp();

  const titleIn = el('input', { class: 'in', placeholder: '(비우면 자동)' });
  const content = el('div', {},
    el('h4', { class: 'pick-h' }, '시나리오'), scSel,
    el('h4', { class: 'pick-h' }, '🔍 내 탐사자 (직접 조작)'), playerSel,
    el('h4', { class: 'pick-h' }, '🤝 동료 탐사자 (키퍼가 연기 · 선택 안 해도 됨)'), compSel,
    el('h4', { class: 'pick-h' }, '세션 이름'), titleIn);

  openModal('새 세션', content, [
    { label: '취소', onclick: c => c() },
    { label: '다음 (이름 확인)', primary: true, onclick: close => {
      const title = titleIn.value;
      const invList = [playerId, ...chosenInvs]
        .map(id => investigators.find(i => i.id === id))
        .filter(Boolean);
      close();
      confirmKoreanNames(invList, async () => {
        try {
          Progress.auto('키퍼가 시나리오를 이 파티에 맞게 조정하는 중… (관계 재설정)', 45);
          const s = await API.post('/api/sessions', {
            scenarioId: chosenScenario,
            investigatorIds: invList.map(i => i.id),
            playerId,
            title,
          });
          Progress.done();
          location.href = apiUrl('/play.html?id=' + s.id);
        } catch (err) {
          Progress.done();
          toast(err.message, 'error');
        }
      });
    } },
  ]);
});

// ── 세션 전 이름 확인: 세션은 한글 이름으로 진행 ────────────────
async function confirmKoreanNames(invList, onConfirm) {
  const latin = invList.filter(i => /[A-Za-z]/.test(i.name));
  let suggestions = {};
  if (latin.length) {
    Progress.auto('이름 한글 표기 제안 받는 중…', 12);
    try {
      suggestions = (await API.post('/api/hangulize', { names: latin.map(i => i.name) })).names || {};
    } catch { /* 제안 실패 시 원래 이름으로 */ }
    Progress.done();
  }
  const rows = invList.map(inv => ({
    inv,
    input: el('input', { class: 'in', value: suggestions[inv.name] || inv.name }),
  }));
  const content = el('div', {},
    el('p', { class: 'muted small' },
      '세션은 한글 이름으로 진행돼요. 발음이 다르면 고쳐주세요 — 저장하면 시트 이름도 함께 바뀝니다.'),
    rows.map(r => el('div', { class: 'field' },
      el('span', { class: 'field-label' }, r.inv.name), r.input)));
  openModal('탐사자 이름 확인', content, [
    { label: '취소', onclick: c => c() },
    { label: '이대로 시작', primary: true, onclick: async close => {
      try {
        for (const r of rows) {
          const nn = r.input.value.trim();
          if (nn && nn !== r.inv.name) {
            await API.put('/api/investigators/' + r.inv.id, { ...r.inv, name: nn });
            r.inv.name = nn;
          }
        }
      } catch (err) { return toast(err.message, 'error'); }
      close();
      onConfirm();
    } },
  ]);
}

// ── 시나리오 ───────────────────────────────────────────────────
function renderScenarios() {
  const holder = document.getElementById('scenario-list');
  holder.innerHTML = '';
  if (!scenarios.length) {
    holder.appendChild(el('div', { class: 'empty' }, '시나리오 텍스트를 붙여넣으면 AI가 분석해 세션을 준비합니다.'));
    return;
  }
  // 분석 대기 / 분석 완료 분류
  const groups = [
    ['⏳ 분석 대기', scenarios.filter(s => !s.compiled)],
    ['✅ 분석 완료', scenarios.filter(s => s.compiled)],
  ];
  for (const [label, list] of groups) {
    if (!list.length) continue;
    holder.appendChild(el('div', { class: 'grid-group-head' }, `${label} (${list.length})`));
    for (const s of list) holder.appendChild(makeScenarioCard(s));
  }
}

function makeScenarioCard(s) {
  {
    const card = el('div', { class: 'card card-click', onclick: () => openScenarioModal(s) },
      el('div', { class: 'card-title' }, s.title),
      s.summarySafe ? el('div', { class: 'card-sub' }, s.summarySafe) : null,
      s.meta ? el('div', { class: 'card-sub muted small' },
        [s.meta.players, s.meta.playtime, s.meta.difficulty && ('난이도 ' + s.meta.difficulty)].filter(Boolean).join(' · ')) : null,
      el('div', { class: 'card-foot' },
        el('span', { class: 'muted' }, `${(s.textLength / 1000).toFixed(1)}천 자`),
        s.compiled
          ? el('span', { class: 'chip chip-ok' }, '분석 완료')
          : el('button', { class: 'btn btn-sm btn-primary', onclick: e => {
              e.stopPropagation();
              compileScenario(s, e.target);
            } }, '분석하기')),
      el('button', { class: 'card-del', title: '삭제', onclick: async e => {
        e.stopPropagation();
        if (!confirm(`시나리오 "${s.title}"을(를) 삭제할까요?`)) return;
        await API.del('/api/scenarios/' + s.id);
        loadAll();
      } }, '✕'),
    );
    return card;
  }
}

// ── 시나리오 상세: 이름 수정 + 개요/정보 (플레이어에게 안전한 것만) ──
function openScenarioModal(s) {
  const nameIn = el('input', { class: 'in', value: s.title });
  const rows = [];
  const addRow = (label, val) => {
    if (!val) return;
    rows.push(el('div', { class: 'sc-info-row' },
      el('span', { class: 'field-label' }, label),
      el('span', {}, String(val))));
  };
  if (s.compiled && s.meta) {
    addRow('인원', s.meta.players);
    addRow('예상 시간', s.meta.playtime);
    addRow('배경', s.meta.background);
    addRow('난이도', s.meta.difficulty);
    addRow('톤', s.meta.tone);
    addRow('파티 전제', s.meta.partyPremise);
    addRow('권장 기능', Array.isArray(s.meta.recommendedSkills) ? s.meta.recommendedSkills.join(', ') : s.meta.recommendedSkills);
    addRow('로스 가능성', s.meta.lossChance);
  }
  addRow('분량', `${(s.textLength / 1000).toFixed(1)}천 자`);
  if (s.compiled && s.compiledLength) {
    const ratio = Math.round((s.compiledLength / Math.max(1, s.textLength)) * 100);
    addRow('분석 보존율', `${(s.compiledLength / 1000).toFixed(1)}천 자 (원문의 ${ratio}%)${ratio < 60 ? ' ⚠ 압축됨 — 재분석 권장' : ''}`);
  }

  const content = el('div', {},
    el('h4', { class: 'pick-h' }, '제목'), nameIn,
    s.summarySafe ? el('div', {},
      el('h4', { class: 'pick-h' }, '개요'),
      el('p', { class: 'sc-summary' }, s.summarySafe)) : null,
    rows.length ? el('div', {}, el('h4', { class: 'pick-h' }, '정보'), el('div', { class: 'sc-info' }, rows)) : null,
    s.compiled ? null : el('p', { class: 'muted small' }, '아직 분석 전입니다 — 분석하면 개요와 정보가 채워져요.'));

  openModal('시나리오', content, [
    { label: '닫기', onclick: c => c() },
    { label: '📤 내보내기', onclick: () => {
      location.href = apiUrl(`/api/scenarios/${s.id}/export`);
      toast('파일 안에 진상이 포함돼요 — 플레이할 사람은 열어보지 않게!', 'warn');
    } },
    { label: '이름 저장', primary: true, onclick: async close => {
      const name = nameIn.value.trim();
      if (!name) return toast('제목을 입력하세요.', 'warn');
      try {
        await API.put('/api/scenarios/' + s.id, { name });
        toast('제목을 저장했습니다.', 'ok');
        close();
        loadAll();
      } catch (err) { toast(err.message, 'error'); }
    } },
  ]);
}

async function compileScenario(s, btn) {
  btn.disabled = true;
  btn.classList.add('btn-progress');
  Progress.auto(`시나리오 분석 중 — ${s.title}`, 90);
  // 컴파일은 LLM 1회 호출이라 정확한 진행률이 없다 → 시간 기반 점근 게이지 (완료 시 100%)
  const t0 = Date.now();
  const tick = () => {
    const sec = (Date.now() - t0) / 1000;
    const pct = Math.min(95, 100 * (1 - Math.exp(-sec / 45)));
    btn.style.setProperty('--pct', pct.toFixed(1) + '%');
    btn.textContent = `분석 중… ${Math.round(pct)}%`;
  };
  tick();
  const timer = setInterval(tick, 500);
  try {
    let lastErr = null;
    await API.stream(`/api/scenarios/${s.id}/compile`, {}, ev => {
      if (ev.e === 'error') lastErr = ev.message;
    });
    if (lastErr) throw new Error(lastErr);
    clearInterval(timer);
    btn.style.setProperty('--pct', '100%');
    btn.textContent = '완료!';
    toast('시나리오 분석 완료!', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
  clearInterval(timer);
  Progress.done();
  loadAll();
}

document.getElementById('btn-new-scenario').addEventListener('click', () => {
  const nameIn = el('input', { class: 'in', placeholder: '(비우면 분석 후 자동 결정)' });
  const textIn = el('textarea', { class: 'in mono', rows: '14', placeholder: '시나리오 전문을 붙여넣으세요 (1~2만 자 권장)' });
  const fileIn = el('input', { type: 'file', accept: '.txt,.md,.pdf,.json,text/plain,application/pdf,application/json', class: 'file-in' });
  let modalClose = null;
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0];
    if (!f) return;
    if (/\.json$/i.test(f.name)) {
      // 키퍼의 방 내보내기 파일 → 바로 가져오기 (분석본 포함)
      try {
        const parsed = JSON.parse(await f.text());
        const sc = await API.post('/api/scenarios/import', parsed);
        toast(`"${sc.title}" 가져옴${sc.compiled ? ' (분석본 포함 — 바로 플레이 가능)' : ''}`, 'ok');
        if (modalClose) modalClose();
        loadAll();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
      toast('PDF에서 텍스트를 추출하는 중…', 'info');
      try {
        const data = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = reject;
          r.readAsDataURL(f);
        });
        const out = await API.post('/api/pdf-extract', { data });
        textIn.value = out.text;
        toast(`PDF ${out.pages}쪽에서 ${(out.text.length / 1000).toFixed(1)}천 자 추출 — 내용 확인 후 저장하세요.`, 'ok');
      } catch (err) { toast(err.message, 'error'); }
    } else {
      textIn.value = await f.text();
    }
    if (!nameIn.value) nameIn.value = f.name.replace(/\.(txt|md|pdf)$/i, '');
  });
  const content = el('div', {},
    el('h4', { class: 'pick-h' }, '제목'), nameIn,
    el('h4', { class: 'pick-h' }, '본문 (txt/md/PDF 불러오기 가능)'), fileIn, textIn);
  modalClose = openModal('시나리오 추가', content, [
    { label: '취소', onclick: c => c() },
    { label: '저장', primary: true, onclick: async close => {
      try {
        await API.post('/api/scenarios', { name: nameIn.value, text: textIn.value });
        close();
        toast('시나리오를 저장했습니다. "분석하기"를 눌러 준비를 마치세요.', 'ok');
        loadAll();
      } catch (err) { toast(err.message, 'error'); }
    } },
  ]);
});

// ── ✨ AI 시나리오 작가 ─────────────────────────────────────────
document.getElementById('btn-ai-scenario').addEventListener('click', () => {
  let messages = [];
  let busyWiz = false;
  const log = el('div', { class: 'wiz-log' });
  const inputArea = el('div', { class: 'wiz-input' });
  const content = el('div', {},
    el('p', { class: 'muted small' },
      '주제만 주면 작가가 질문하고, 주사위를 굴려 갈림길을 정하면서 시나리오를 써요. 진상은 작가만 아는 비밀 — 완성돼도 내용은 안 보여주고 바로 저장·분석합니다 (스포 방지).'),
    log, inputArea);
  const closeModal = openModal('✨ AI 시나리오 작가', content, []);

  function addLine(cls, text) {
    log.appendChild(el('div', { class: 'wiz-line ' + cls }, text));
    log.scrollTop = log.scrollHeight;
  }

  async function send(userText) {
    if (busyWiz) return;
    busyWiz = true;
    if (userText) {
      messages.push({ role: 'user', content: userText });
      addLine('wiz-user', userText);
    }
    inputArea.innerHTML = '';
    Progress.auto('작가가 구상 중…', 35);
    try {
      await API.stream('/api/scenario-wizard', { messages }, ev => {
        if (ev.e === 'say') addLine('wiz-ai', ev.text);
        else if (ev.e === 'roll') addLine('wiz-roll', `🎲 ${ev.reason || '주사위'} — ${ev.expr} = ${ev.total}`);
        else if (ev.e === 'chapter') addLine('wiz-roll', `📖 ${ev.index}장 「${ev.title}」 완성 (${(ev.length / 1000).toFixed(1)}천 자)`);
        else if (ev.e === 'status') Progress.auto(ev.text, 60);
        else if (ev.e === 'ask') { messages = ev.messages; renderQuestions(ev.say, ev.questions); }
        else if (ev.e === 'saved') onSaved(ev);
        else if (ev.e === 'error') { addLine('wiz-ai', '⚠ ' + ev.message); renderFreeInput(); }
      });
    } catch (err) {
      toast(err.message, 'error');
      renderFreeInput();
    }
    Progress.done();
    busyWiz = false;
  }

  function renderQuestions(say, questions) {
    if (say) addLine('wiz-ai', say);
    inputArea.innerHTML = '';
    const fields = questions.map((q, i) => {
      const free = el('input', { class: 'in', placeholder: '직접 입력 또는 선택지 클릭' });
      const opts = (q.options || []).map(o => {
        const b = el('button', { class: 'btn btn-ghost btn-sm wiz-opt' }, o);
        b.addEventListener('click', () => {
          free.value = o;
          opts.forEach(x => x.classList.remove('btn-primary'));
          b.classList.add('btn-primary');
        });
        return b;
      });
      inputArea.appendChild(el('div', { class: 'field' },
        el('span', { class: 'field-label' }, `${i + 1}. ${q.q}`),
        opts.length ? el('div', { class: 'wiz-opts' }, opts) : null,
        free));
      return { q, free };
    });
    inputArea.appendChild(el('div', { class: 'settings-actions' },
      el('button', { class: 'btn btn-primary', onclick: () => {
        const ans = fields.map((f, i) => `${i + 1}) ${f.q.q} → ${f.free.value.trim() || '(작가에게 맡김)'}`).join('\n');
        send('답변:\n' + ans);
      } }, '보내기')));
  }

  function renderFreeInput() {
    inputArea.innerHTML = '';
    const inp = el('input', { class: 'in', placeholder: '메시지 (요청/재시도)…' });
    inputArea.appendChild(el('div', { class: 'st-profile-row' }, inp,
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => {
        const v = inp.value.trim();
        if (v) send(v);
      } }, '보내기')));
  }

  async function onSaved(ev) {
    if (ev.say) addLine('wiz-ai', ev.say);
    addLine('wiz-ai', `📜 "${ev.scenario.title}" 저장됨 (${(ev.scenario.textLength / 1000).toFixed(1)}천 자) — 이어서 분석합니다.`);
    Progress.auto(`시나리오 분석 중 — ${ev.scenario.title}`, 90);
    try {
      let lastErr = null;
      await API.stream(`/api/scenarios/${ev.scenario.id}/compile`, {}, e2 => {
        if (e2.e === 'error') lastErr = e2.message;
      });
      if (lastErr) throw new Error(lastErr);
      toast(`"${ev.scenario.title}" 준비 완료! 새 세션에서 선택하세요.`, 'ok');
      closeModal();
    } catch (err) {
      toast('분석 실패: ' + err.message + ' — 시나리오 탭에서 분석하기를 다시 눌러주세요.', 'error');
      closeModal();
    }
    Progress.done();
    loadAll();
  }

  // 시작: 주제 입력
  const themeIn = el('input', { class: 'in', placeholder: '예: 아이돌 데뷔물, 시골 폐교, 심해 연구기지…' });
  inputArea.appendChild(el('div', { class: 'field' },
    el('span', { class: 'field-label' }, '주제'), themeIn,
    el('div', { class: 'settings-actions' },
      el('button', { class: 'btn btn-primary', onclick: () => {
        const t = themeIn.value.trim();
        if (!t) return toast('주제를 입력하세요.', 'warn');
        send(`주제: ${t}\n이 주제로 시나리오를 써줘. 장르·룰 스타일은 주제에 맞게. 필요한 질문부터 시작해.`);
      } }, '시작'))));
});

// ── 탐사자 ─────────────────────────────────────────────────────
// 프사 업로드 (📷) — 이미지 파일 → dataURL → 서버 저장
function pickAvatar(inv) {
  const input = el('input', { type: 'file', accept: 'image/*' });
  input.addEventListener('change', async () => {
    const f = input.files[0];
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) return toast('이미지가 너무 큽니다 (4MB 이하).', 'warn');
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(f);
    });
    try {
      await API.post(`/api/investigators/${inv.id}/avatar`, { data });
      toast('프사를 바꿨습니다.', 'ok');
      loadAll();
    } catch (err) { toast(err.message, 'error'); }
  });
  input.click();
}

function makeInvCard(i) {
  const avatarUrl = invAvatarUrl(i);
  return el('div', { class: 'card card-click', onclick: () => openInvestigatorModal(i) },
    el('div', { class: 'card-title-row' },
      avatarUrl ? el('img', { class: 'card-avatar', src: avatarUrl, onerror: function () { this.remove(); } }) : null,
      el('div', { class: 'card-title' }, i.name),
      i.kpc ? el('span', { class: 'chip chip-kpc' }, 'KPC') : null),
    el('div', { class: 'card-sub' }, `${i.occupation || '무직'} · ${i.age}세${i.gender ? ' · ' + i.gender : ''}`),
    el('div', { class: 'card-sub muted small' },
      `체력 ${i.hpMax} · SAN ${i.sanStart} · 행운 ${i.luck} · DB ${i.db}`),
    i.source ? el('div', { class: 'card-sub muted small' },
      i.source === 'st-persona' ? '🎭 ST 페르소나' : '🎭 ST 캐릭터 (카드+로어북+참메모리 주입)') : null,
    el('button', { class: 'card-cam', title: '프사 변경', onclick: e => {
      e.stopPropagation();
      pickAvatar(i);
    } }, '📷'),
    el('button', { class: 'card-del', title: '삭제', onclick: async e => {
      e.stopPropagation();
      if (!confirm(`탐사자 "${i.name}"을(를) 삭제할까요?`)) return;
      await API.del('/api/investigators/' + i.id);
      loadAll();
    } }, '✕'),
  );
}

function renderInvestigators() {
  const holder = document.getElementById('investigator-list');
  holder.innerHTML = '';
  if (!investigators.length) {
    holder.appendChild(el('div', { class: 'empty' }, '탐사자 시트를 만들어보세요. 🎲 자동 생성 또는 🎭 ST에서 가져오기로 빠르게 시작할 수 있어요.'));
    return;
  }
  // 단체 카드 출신은 그룹으로 묶어 접을 수 있게
  const groups = new Map();
  const singles = [];
  for (const i of investigators) {
    if (i.stGroup) {
      if (!groups.has(i.stGroup)) groups.set(i.stGroup, []);
      groups.get(i.stGroup).push(i);
    } else singles.push(i);
  }
  for (const i of singles) holder.appendChild(makeInvCard(i));
  for (const [gname, members] of groups) {
    const key = 'kp-group-' + gname;
    let open = localStorage.getItem(key) !== 'closed';
    const grid = el('div', { class: 'card-grid inv-group-grid' }, members.map(makeInvCard));
    const arrow = el('span', { class: 'group-arrow' }, open ? '▾' : '▸');
    const head = el('button', { class: 'inv-group-head' },
      arrow, el('strong', {}, `📁 ${gname}`), el('span', { class: 'muted small' }, `${members.length}명`));
    head.addEventListener('click', () => {
      open = !open;
      localStorage.setItem(key, open ? 'open' : 'closed');
      grid.classList.toggle('hidden', !open);
      arrow.textContent = open ? '▾' : '▸';
    });
    grid.classList.toggle('hidden', !open);
    holder.appendChild(el('div', { class: 'inv-group' }, head, grid));
  }
}

// ── ST 가져오기 모달 ────────────────────────────────────────────
document.getElementById('btn-st-import').addEventListener('click', async () => {
  let status;
  try { status = await API.get('/api/st/status'); }
  catch { status = { available: false }; }
  if (!status.available) {
    return toast('SillyTavern 경로가 설정되지 않았거나 유효하지 않아요. 설정에서 stPath를 입력하세요.', 'warn');
  }

  const listHolder = el('div', { class: 'st-list' }, el('div', { class: 'empty' }, '불러오는 중…'));
  let tab = 'personas';
  let importing = false;
  const sel = new Map(); // avatar → item (현재 탭에서 선택된 것들)
  const tabPersonas = el('button', { class: 'seg-btn active' }, `페르소나 (${status.personas})`);
  const tabChars = el('button', { class: 'seg-btn' }, `캐릭터 (${status.characters})`);
  tabPersonas.addEventListener('click', () => { tab = 'personas'; sel.clear(); tabPersonas.classList.add('active'); tabChars.classList.remove('active'); loadTab(); });
  tabChars.addEventListener('click', () => { tab = 'characters'; sel.clear(); tabChars.classList.add('active'); tabPersonas.classList.remove('active'); loadTab(); });

  const importBtn = el('button', { class: 'btn btn-primary', disabled: 'disabled' }, '가져오기');
  function updatePick() {
    importBtn.textContent = importing ? '가져오는 중…' : `🎲 선택 ${sel.size}개 가져오기`;
    if (!sel.size || importing) importBtn.setAttribute('disabled', 'disabled');
    else importBtn.removeAttribute('disabled');
  }
  updatePick();

  async function runQueue() {
    if (!sel.size || importing) return;
    importing = true;
    updatePick();
    const picked = [...sel.values()];
    const kind = tab === 'personas' ? 'persona' : 'character';
    const kindLabel = tab === 'personas' ? '페르소나' : '캐릭터';
    let made = 0;
    for (let i = 0; i < picked.length; i++) {
      const it = picked[i];
      Progress.auto(`시트 생성 중 (${i + 1}/${picked.length}) — [${kindLabel}] ${it.name}`, 30);
      try {
        const out = await API.post(`/api/st/import/${kind}`, { avatar: it.avatar });
        made += (out.investigators || []).length;
        if (out.genBy !== 'ai') toast(`${it.name} — 랜덤 굴림 폴백 (${out.reason || '원인 미상'})`, 'warn');
      } catch (err) { toast(`${it.name}: ${err.message}`, 'error'); }
    }
    Progress.done();
    importing = false;
    sel.clear();
    if (made) toast(`탐사자 ${made}명 가져왔습니다.`, 'ok');
    investigators = await API.get('/api/investigators');
    renderInvestigators();
    updatePick();
    loadTab();
  }
  importBtn.addEventListener('click', runQueue);

  const content = el('div', {},
    el('div', { class: 'seg st-tabs' }, tabPersonas, tabChars),
    el('p', { class: 'muted small st-hint' },
      '여러 개 선택 → 가져오기를 누르면 순서대로 시트를 만들어요 (한 명당 십수 초). 페르소나 → 보통 내가 조작하는 탐사자 / 캐릭터 → 키퍼가 연기하는 동료(KPC). 시트는 나중에 수정 가능.'),
    listHolder,
    el('div', { class: 'st-import-bar' }, importBtn));

  let showAllChars = false; // 기본: 페르소나에 연결된 캐릭터만
  async function loadTab() {
    listHolder.innerHTML = '';
    listHolder.appendChild(el('div', { class: 'empty' }, '불러오는 중…'));
    try {
      let items = await API.get(tab === 'personas' ? '/api/st/personas' : '/api/st/characters');
      listHolder.innerHTML = '';
      if (tab === 'characters') {
        const connectedCount = items.filter(c => c.connected).length;
        if (connectedCount > 0) {
          if (!showAllChars) items = items.filter(c => c.connected);
          const toggle = el('button', { class: 'btn btn-ghost btn-sm' },
            showAllChars ? `🔗 연결된 것만 보기 (${connectedCount})` : `전체 보기 (${status.characters})`);
          toggle.addEventListener('click', () => { showAllChars = !showAllChars; loadTab(); });
          listHolder.appendChild(el('div', { class: 'st-filter-row' },
            el('span', { class: 'muted small' },
              showAllChars ? '전체 캐릭터 표시 중' : `페르소나에 연결된 캐릭터만 (${connectedCount}개)`),
            toggle));
        }
      }
      if (!items.length) {
        listHolder.appendChild(el('div', { class: 'empty' }, '항목이 없습니다.'));
        return;
      }
      for (const it of items) {
        const route = tab === 'personas' ? 'persona-avatar' : 'char-avatar';
        const already = investigators.some(v => v.stAvatar === it.avatar);
        const row = el('button', { class: 'pick-item st-item' + (already ? ' st-done' : '') + (sel.has(it.avatar) ? ' picked' : '') },
          el('img', { class: 'st-avatar', src: apiUrl(`/api/st/${route}/${encodeURIComponent(it.avatar)}`), onerror: function () { this.style.visibility = 'hidden'; } }),
          el('div', { class: 'st-item-body' },
            el('strong', {}, it.name),
            el('span', { class: 'muted small' },
              tab === 'personas'
                ? (it.description || '').slice(0, 80)
                : [it.descriptionPreview, it.hasBook || it.world ? '📖 로어북' : '', it.hasCharm ? '🧠 참메모리' : ''].filter(Boolean).join(' · ')),
            already ? el('span', { class: 'chip chip-ok' }, '가져옴') : null));
        row.addEventListener('click', () => {
          if (importing) return;
          if (sel.has(it.avatar)) { sel.delete(it.avatar); row.classList.remove('picked'); }
          else { sel.set(it.avatar, it); row.classList.add('picked'); }
          updatePick();
        });
        listHolder.appendChild(row);
      }
    } catch (err) {
      listHolder.innerHTML = '';
      listHolder.appendChild(el('div', { class: 'empty' }, err.message));
    }
  }
  loadTab();
  openModal('SillyTavern에서 가져오기', content, []);
});

function openInvestigatorModal(existing) {
  const editor = createSheetEditor(existing || null);
  const genBtn = el('button', { class: 'btn btn-ghost', onclick: async () => {
    genBtn.disabled = true;
    try {
      const cur = editor.getData();
      const g = await API.post('/api/investigators/generate', { name: cur.name !== '무명' ? cur.name : '' });
      editor.setData(g);
      toast(`${g.occupation} 탐사자를 굴렸습니다.`, 'ok');
    } catch (err) { toast(err.message, 'error'); }
    genBtn.disabled = false;
  } }, '🎲 자동 생성');
  const content = el('div', {}, el('div', { class: 'gen-bar' }, genBtn), editor.root);
  openModal(existing ? '탐사자 편집' : '새 탐사자', content, [
    { label: '취소', onclick: c => c() },
    { label: '저장', primary: true, onclick: async close => {
      try {
        const data = editor.getData();
        if (existing) await API.put('/api/investigators/' + existing.id, data);
        else await API.post('/api/investigators', data);
        close();
        toast('탐사자를 저장했습니다.', 'ok');
        loadAll();
      } catch (err) { toast(err.message, 'error'); }
    } },
  ]);
}

document.getElementById('btn-new-investigator').addEventListener('click', () => openInvestigatorModal(null));

// ── 설정 ───────────────────────────────────────────────────────
function renderSettings() {
  if (!settings) return;
  document.querySelectorAll('#provider-seg .seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.p === settings.provider);
  });
  document.getElementById('box-gemini').classList.toggle('dim', settings.provider !== 'gemini');
  document.getElementById('box-claude').classList.toggle('dim', settings.provider !== 'claude');
  document.getElementById('box-st').classList.toggle('dim', settings.provider !== 'st');
  document.getElementById('gemini-key').value = settings.gemini.apiKey || '';
  document.getElementById('gemini-model').value = settings.gemini.model || '';
  document.getElementById('claude-key').value = settings.claude.apiKey || '';
  document.getElementById('claude-model').value = settings.claude.model || '';
  const st = settings.st || {};
  document.getElementById('st-path').value = st.path || '';
  document.getElementById('st-use-preset').checked = st.usePreset !== false;
  document.querySelectorAll('#pace-seg .seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.pace === (settings.pace || 'beat'));
  });
  document.querySelectorAll('#narration-seg .seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.narr === (settings.narration || 'novel'));
  });
  document.getElementById('player-dice').checked = settings.playerDice !== false;
  refreshSTStatus();
}

document.querySelectorAll('#pace-seg .seg-btn').forEach(b => {
  b.addEventListener('click', () => {
    settings.pace = b.dataset.pace;
    renderSettings();
  });
});

document.querySelectorAll('#narration-seg .seg-btn').forEach(b => {
  b.addEventListener('click', () => {
    settings.narration = b.dataset.narr;
    renderSettings();
  });
});

// ── 글자 설정 (기기 저장 — 즉시 적용, 저장 버튼 불필요) ─────────
function renderFontControls() {
  const { size, family } = FontPrefs.get();
  document.querySelectorAll('#font-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.font === family));
  const slider = document.getElementById('font-size');
  slider.value = size || 14.5;
  document.getElementById('font-size-label').textContent = size ? size + 'px' : '기본';
}
document.querySelectorAll('#font-seg .seg-btn').forEach(b => {
  b.addEventListener('click', () => {
    FontPrefs.set(FontPrefs.get().size, b.dataset.font);
    renderFontControls();
  });
});
document.getElementById('font-size').addEventListener('input', e => {
  FontPrefs.set(parseFloat(e.target.value), FontPrefs.get().family);
  renderFontControls();
});
renderFontControls();

async function refreshSTStatus() {
  const statusEl = document.getElementById('st-status');
  const sel = document.getElementById('st-profile');
  try {
    const s = await API.get('/api/st/status');
    // ST 플러그인 프록시 경유 접속이면 경로가 자동 감지되므로 입력란을 숨긴다
    const pathField = document.getElementById('st-path-field');
    if (pathField) pathField.style.display = s.auto ? 'none' : '';
    if (!s.available) {
      statusEl.textContent = (settings.st && settings.st.path) ? '⚠ 경로를 찾을 수 없음 (저장 후 다시 확인)' : 'ST 경로를 입력하고 저장하세요.';
      return;
    }
    statusEl.textContent = (s.auto ? '✓ ST 자동 연동' : '✓ 연결됨')
      + ` — 프로필 ${s.profiles} · 페르소나 ${s.personas} · 캐릭터 ${s.characters}`;
    const profiles = await API.get('/api/st/profiles');
    const current = (settings.st && settings.st.profile) || '';
    sel.innerHTML = '';
    sel.appendChild(el('option', { value: '' }, '(ST에서 선택된 프로필)'));
    for (const p of profiles) {
      const label = `${p.name} — ${p.api}/${p.model}${p.preset ? ' · 프리셋: ' + p.preset : ''}`;
      const opt = el('option', { value: p.name }, label);
      if (p.name === current) opt.selected = true;
      sel.appendChild(opt);
    }
  } catch {
    statusEl.textContent = '⚠ ST 상태 확인 실패';
  }
}

document.getElementById('btn-st-refresh').addEventListener('click', async () => {
  // 경로 먼저 저장하고 다시 조회
  settings = await API.put('/api/settings', { st: { path: document.getElementById('st-path').value.trim() } });
  refreshSTStatus();
});

document.querySelectorAll('#provider-seg .seg-btn').forEach(b => {
  b.addEventListener('click', () => {
    settings.provider = b.dataset.p;
    renderSettings();
  });
});

// ── 프리셋 항목 편집 (키퍼 전용 on/off + 추가 — ST 원본은 안 건드림) ──
document.getElementById('btn-preset-edit').addEventListener('click', async () => {
  let data;
  try { data = await API.get('/api/st/preset-entries'); }
  catch (err) { return toast(err.message, 'error'); }

  const disabled = new Set((settings.st && settings.st.presetDisabled) || []);
  const extra = JSON.parse(JSON.stringify((settings.st && settings.st.presetExtra) || []));
  const list = el('div', { class: 'preset-list' });

  function renderList() {
    list.innerHTML = '';
    const stEntries = data.entries.filter(e => e.enabled); // ST에서 켜져 있는 항목만 대상
    if (!stEntries.length && !extra.length) {
      list.appendChild(el('div', { class: 'empty' },
        data.preset ? '프리셋에 주입할 항목이 없습니다.' : '프로필에 연결된 프리셋이 없습니다. 아래에서 항목을 직접 추가할 수 있어요.'));
    }
    for (const e of stEntries) {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !disabled.has(e.identifier);
      cb.addEventListener('change', () => {
        if (cb.checked) disabled.delete(e.identifier);
        else disabled.add(e.identifier);
      });
      const preview = el('div', { class: 'muted small preset-preview' }, e.content);
      preview.addEventListener('click', () => preview.classList.toggle('full'));
      list.appendChild(el('div', { class: 'preset-item' },
        el('label', { class: 'check-row' }, cb, el('strong', {}, e.name)),
        preview));
    }
    extra.forEach((x, i) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = x.enabled !== false;
      cb.addEventListener('change', () => { x.enabled = cb.checked; });
      const row = el('div', { class: 'preset-item preset-extra-item' },
        el('label', { class: 'check-row' }, cb,
          el('strong', {}, `➕ ${x.name || '커스텀'}`),
          el('button', { class: 'card-del preset-del', title: '삭제', onclick: () => { extra.splice(i, 1); renderList(); } }, '✕')),
        el('div', { class: 'muted small preset-preview full' }, x.content));
      list.appendChild(row);
    });
  }
  renderList();

  const nameIn = el('input', { class: 'in', placeholder: '항목 이름 (예: 묘사 짧게)' });
  const contentIn = el('textarea', { class: 'in mono', rows: '4', placeholder: '추가할 지시문 — 키퍼 스타일 가이드 끝에 붙습니다' });
  const addBtn = el('button', { class: 'btn btn-ghost btn-sm', onclick: () => {
    if (!contentIn.value.trim()) return toast('내용을 입력하세요.', 'warn');
    extra.push({ name: nameIn.value.trim() || '커스텀', content: contentIn.value.trim(), enabled: true });
    nameIn.value = ''; contentIn.value = '';
    renderList();
  } }, '＋ 추가');

  const content = el('div', {},
    el('p', { class: 'muted small' },
      `프로필 "${data.profile}" · 프리셋 "${data.preset || '(없음)'}" — 체크를 끄면 여기(키퍼 주입)에서만 빠지고 ST 원본은 그대로예요. 내용은 클릭하면 펼쳐집니다.`),
    list,
    el('h4', { class: 'pick-h' }, '항목 추가 (키퍼 전용)'), nameIn, contentIn, addBtn);

  openModal('프리셋 항목', content, [
    { label: '취소', onclick: c => c() },
    { label: '저장', primary: true, onclick: async close => {
      try {
        settings = await API.put('/api/settings', { st: { presetDisabled: [...disabled], presetExtra: extra } });
        toast('프리셋 구성을 저장했습니다.', 'ok');
        close();
      } catch (err) { toast(err.message, 'error'); }
    } },
  ]);
});

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  try {
    settings = await API.put('/api/settings', {
      provider: settings.provider,
      pace: settings.pace || 'beat',
      narration: settings.narration || 'novel',
      playerDice: document.getElementById('player-dice').checked,
      gemini: { apiKey: document.getElementById('gemini-key').value.trim(), model: document.getElementById('gemini-model').value.trim() || 'gemini-3.1-pro' },
      claude: { apiKey: document.getElementById('claude-key').value.trim(), model: document.getElementById('claude-model').value.trim() || 'claude-sonnet-5' },
      st: {
        path: document.getElementById('st-path').value.trim(),
        profile: document.getElementById('st-profile').value,
        usePreset: document.getElementById('st-use-preset').checked,
      },
    });
    renderSettings();
    toast('설정을 저장했습니다.', 'ok');
  } catch (err) { toast(err.message, 'error'); }
});

loadAll().catch(err => toast(err.message, 'error'));
