// ── 플레이: 세션 화면 ───────────────────────────────────────────
'use strict';

Themes.renderPicker(document.getElementById('theme-picker'));

const sessionId = new URLSearchParams(location.search).get('id');
if (!sessionId) location.href = '/';

const logEl = document.getElementById('log');
const typingEl = document.getElementById('typing');
const typingText = document.getElementById('typing-text');
const whoSel = document.getElementById('who');
const chatIn = document.getElementById('chat-in');
const partyEl = document.getElementById('party');
const sceneChip = document.getElementById('scene-chip');
const startHolder = document.getElementById('start-holder');
const inputBar = document.getElementById('input-bar');

let session = null;
let busy = false;

// ── 유틸 ───────────────────────────────────────────────────────
function npcHue(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

// 마크다운(굵게/기울임/취소선/코드) 인라인 렌더 — HTML은 먼저 이스케이프
function mdInline(text) {
  return esc(text)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

function paragraphs(text) {
  return String(text).split(/\n{2,}|\n/).map(s => s.trim()).filter(Boolean)
    .map(p => el('p', { html: mdInline(p) }));
}

// 이름 매칭 (키퍼가 "Baron"처럼 짧은 이름으로 부르는 경우 대응)
function findSheetByName(name) {
  if (!session || !session.sheets) return null;
  const sheets = session.sheets.filter(s => s.stAvatar || s.customAvatar);
  return sheets.find(s => s.name === name)
    || sheets.find(s => s.name.includes(name) || String(name).includes(s.name))
    || null;
}

// 플레이어 입력을 대사("...")와 행동/나레이션으로 분리
function splitSpeech(text) {
  const parts = [];
  const re = /["“”「]([^"“”「」]+)["“”」]/g;
  let last = 0, m;
  const str = String(text);
  while ((m = re.exec(str))) {
    if (m.index > last) parts.push({ kind: 'action', text: str.slice(last, m.index) });
    parts.push({ kind: 'speech', text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < str.length) parts.push({ kind: 'action', text: str.slice(last) });
  return mergeTrivialActions(parts.filter(p => p.text.trim()));
}

// 괄호뿐인 조각("대사" (부연) 같은 것)은 나레이션으로 떨어뜨리지 않고 옆 말풍선에 붙인다
function mergeTrivialActions(parts) {
  const out = [];
  for (let p of parts) {
    const isParenOnly = p.kind === 'action' && /^[\s.,…~!?]*[([][^)\]]*[)\]][\s.,…~!?]*$/.test(p.text);
    if (isParenOnly) {
      const prev = out[out.length - 1];
      if (prev && prev.kind === 'speech') { prev.text += ' ' + p.text.trim(); continue; }
      out.push({ kind: 'paren', text: p.text.trim() }); // 뒤 말풍선 앞에 붙이도록 보류
      continue;
    }
    if (p.kind === 'speech' && out.length && out[out.length - 1].kind === 'paren') {
      const paren = out.pop();
      p = { kind: 'speech', text: paren.text + ' ' + p.text };
    }
    out.push(p);
  }
  return out.map(p => (p.kind === 'paren' ? { kind: 'speech', text: p.text } : p));
}

// 패널 <style>을 패널 전용 스코프로 가둔다 (@keyframes/@font-face는 그대로, @media는 내부 재귀)
function scopeCss(css, scope) {
  let out = '';
  let i = 0;
  const str = String(css);
  while (i < str.length) {
    const brace = str.indexOf('{', i);
    if (brace === -1) break;
    const selector = str.slice(i, brace).trim();
    let depth = 1, j = brace + 1;
    while (j < str.length && depth > 0) {
      if (str[j] === '{') depth++;
      else if (str[j] === '}') depth--;
      j++;
    }
    const bodyTxt = str.slice(brace + 1, j - 1);
    if (/^@(keyframes|-webkit-keyframes|font-face|charset|import)/i.test(selector)) {
      out += `${selector}{${bodyTxt}}`;
    } else if (/^@(media|supports|container)/i.test(selector)) {
      out += `${selector}{${scopeCss(bodyTxt, scope)}}`;
    } else if (selector) {
      const scoped = selector.split(',').map(s => `${scope} ${s.trim()}`).join(', ');
      out += `${scoped}{${bodyTxt}}`;
    }
    i = j;
  }
  return out;
}

// 키퍼가 만든 극중 오브젝트(핸드아웃) HTML 정화 — 스크립트/이벤트 제거, 스타일은 스코핑
let panelSeq = 0;
function sanitizePanelHtml(html, scopeClass) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html);
  tpl.content.querySelectorAll('script, iframe, object, embed, link, meta, form, base').forEach(n => n.remove());
  if (scopeClass) {
    tpl.content.querySelectorAll('style').forEach(st => {
      st.textContent = scopeCss(st.textContent, '.' + scopeClass);
    });
  }
  tpl.content.querySelectorAll('*').forEach(node => {
    for (const attr of [...node.attributes]) {
      const n = attr.name.toLowerCase();
      if (n.startsWith('on')) node.removeAttribute(attr.name);
      else if ((n === 'href' || n === 'src') && /^\s*javascript:/i.test(String(attr.value))) node.removeAttribute(attr.name);
    }
  });
  // 외부 이미지는 서버 프록시로 — 핫링크(리퍼러) 차단 우회
  tpl.content.querySelectorAll('img[src]').forEach(img => {
    const src = img.getAttribute('src') || '';
    if (/^https?:\/\//i.test(src)) {
      img.setAttribute('src', apiUrl('/api/img-proxy?u=' + encodeURIComponent(src)));
      img.setAttribute('loading', 'lazy');
    }
  });
  return tpl.innerHTML;
}

function scrollDown() {
  requestAnimationFrame(() => { logEl.scrollTop = logEl.scrollHeight; });
}

function setBusy(b, statusText) {
  busy = b;
  typingEl.classList.toggle('hidden', !b);
  if (statusText) typingText.textContent = statusText;
  for (const id of ['btn-send', 'btn-continue', 'btn-reroll', 'btn-undo']) {
    document.getElementById(id).disabled = b;
  }
  if (b) scrollDown();
}

// ── 로그 렌더링 ─────────────────────────────────────────────────
function renderEntry(en) {
  if (en.t === 'narrator') {
    return el('div', { class: 'msg narrator' }, el('div', { class: 'narrator-inner' }, paragraphs(en.text)));
  }
  if (en.t === 'npc') {
    const hue = npcHue(en.speaker);
    const kpcSheet = findSheetByName(en.speaker);
    // 아바타는 행마다 새 노드가 필요해서 팩토리로
    const makeAvatar = () => {
      const url = invAvatarUrl(kpcSheet);
      if (url) {
        const img = el('img', { class: 'avatar img-avatar', src: url });
        img.addEventListener('error', () => {
          img.replaceWith(el('div', { class: 'avatar', style: `--hue:${hue}` }, (en.speaker || '?').charAt(0)));
        });
        return img;
      }
      return el('div', { class: 'avatar', style: `--hue:${hue}` }, (en.speaker || '?').charAt(0));
    };
    // 따옴표 대사만 말풍선, 서술은 나레이션 박스로 (따옴표 없으면 전체가 대사)
    const parts = splitSpeech(en.text);
    const hasSpeech = parts.some(p => p.kind === 'speech');
    const rows = [];
    let first = true;
    for (const p of (hasSpeech ? parts : [{ kind: 'speech', text: en.text }])) {
      if (p.kind === 'action') {
        rows.push(el('div', { class: 'narrator-inner inline-narr' }, paragraphs(p.text)));
      } else {
        rows.push(el('div', { class: 'npc-row' },
          first ? makeAvatar() : el('div', { class: 'avatar-spacer' }),
          el('div', { class: 'bubble-wrap' },
            first ? el('div', { class: 'speaker-name', style: `--hue:${hue}` }, en.speaker) : null,
            el('div', { class: 'bubble npc-bubble', style: `--hue:${hue}` }, paragraphs(p.text)))));
        first = false;
      }
    }
    return el('div', { class: 'msg npc-block' }, rows);
  }
  if (en.t === 'player') {
    const mySheet = findSheetByName(en.speaker);
    const makeAvatar = () => {
      const url = invAvatarUrl(mySheet);
      if (!url) return el('div', { class: 'avatar-spacer' });
      const img = el('img', { class: 'avatar img-avatar', src: url });
      img.addEventListener('error', () => img.replaceWith(el('div', { class: 'avatar-spacer' })));
      return img;
    };
    // 따옴표 대사만 말풍선, 행동/서술은 나레이션 박스로
    const parts = splitSpeech(en.text);
    const hasSpeech = parts.some(p => p.kind === 'speech');
    const rows = [];
    let first = true;
    for (const p of (hasSpeech ? parts : [{ kind: 'speech', text: en.text }])) {
      if (p.kind === 'action') {
        rows.push(el('div', { class: 'narrator-inner inline-narr' }, paragraphs(p.text)));
      } else {
        rows.push(el('div', { class: 'player-row' },
          el('div', { class: 'bubble-wrap player-wrap' },
            first ? el('div', { class: 'speaker-name pl' }, en.speaker) : null,
            el('div', { class: 'bubble player-bubble' }, paragraphs(p.text))),
          first ? makeAvatar() : el('div', { class: 'avatar-spacer' })));
        first = false;
      }
    }
    return el('div', { class: 'msg player-block' }, rows);
  }
  if (en.t === 'system') {
    return el('div', { class: 'msg system' }, el('span', { class: 'system-chip' }, en.text));
  }
  if (en.t === 'panel') {
    const scope = 'kp-panel-' + (++panelSeq);
    const inner = el('div', { class: 'panel-inner ' + scope });
    inner.innerHTML = sanitizePanelHtml(en.html || '', scope);
    return el('div', { class: 'msg panel', title: en.alt || '' }, inner);
  }
  if (en.t === 'roll') {
    return renderRoll(en);
  }
  return el('div', {});
}

function renderRoll(en) {
  const d = en.data || {};
  let cls = 'roll-card', body;
  if (d.kind === 'san') {
    cls += d.success ? ' lv-regular' : ' lv-fail';
    body = [
      el('div', { class: 'roll-head' }, `🧠 SAN 체크 — ${en.investigator}`),
      el('div', { class: 'roll-main' },
        el('span', { class: 'roll-num' }, String(d.roll)),
        el('span', { class: 'roll-vs' }, `/ ${d.san}`),
        el('span', { class: 'roll-level' }, d.success ? '성공' : '실패')),
      el('div', { class: 'roll-sub' }, `SAN ${d.lost > 0 ? '-' + d.lost : '유지'}${d.lost > 0 ? ` → ${d.sanAfter}` : ''}`),
    ];
  } else if (d.kind === 'opposed') {
    cls += ' lv-regular';
    body = [
      el('div', { class: 'roll-head' }, `⚔ 대항 판정`),
      el('div', { class: 'roll-opposed' },
        el('div', { class: 'opp-side' + (d.winner === 'a' ? ' opp-win' : '') },
          el('div', { class: 'opp-name' }, d.aLabel),
          el('div', {}, `${d.a.roll} / ${d.a.value}`),
          el('div', { class: 'roll-sub' }, d.a.levelLabel)),
        el('div', { class: 'opp-vs' }, 'VS'),
        el('div', { class: 'opp-side' + (d.winner === 'b' ? ' opp-win' : '') },
          el('div', { class: 'opp-name' }, d.bLabel),
          el('div', {}, `${d.b.roll} / ${d.b.value}`),
          el('div', { class: 'roll-sub' }, d.b.levelLabel))),
    ];
  } else if (d.kind === 'dice') {
    cls += ' lv-plain';
    body = [
      el('div', { class: 'roll-head' }, `🎲 ${d.expr}${en.reason ? ' — ' + en.reason : ''}`),
      el('div', { class: 'roll-main' },
        el('span', { class: 'roll-num' }, String(d.total)),
        el('span', { class: 'roll-sub' }, d.detail !== String(d.total) ? d.detail : '')),
    ];
  } else {
    cls += ' lv-' + (d.level || 'plain');
    const diceNote = [];
    if (d.bonusDice) diceNote.push(`보너스 ${d.bonusDice}`);
    if (d.penaltyDice) diceNote.push(`패널티 ${d.penaltyDice}`);
    body = [
      el('div', { class: 'roll-head' },
        `🎲 ${d.name} 판정${d.difficulty && d.difficulty !== 'regular' ? ` (${d.difficultyLabel})` : ''} — ${en.investigator}`),
      el('div', { class: 'roll-main' },
        el('span', { class: 'roll-num' }, String(d.roll)),
        el('span', { class: 'roll-vs' }, `/ ${d.value}`),
        el('span', { class: 'roll-level' }, d.levelLabel)),
      (en.reason || diceNote.length)
        ? el('div', { class: 'roll-sub' }, [en.reason, diceNote.join(', ')].filter(Boolean).join(' · '))
        : null,
    ];
  }
  return el('div', { class: 'msg roll' }, el('div', { class: cls }, body));
}

function appendEntry(en) {
  logEl.appendChild(renderEntry(en));
  scrollDown();
}

function renderLog(entries) {
  logEl.innerHTML = '';
  for (const en of entries) logEl.appendChild(renderEntry(en));
  scrollDown();
}

// ── 파티 패널 ───────────────────────────────────────────────────
function bar(label, cur, max, cls) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0;
  return el('div', { class: 'bar-row' },
    el('span', { class: 'bar-label' }, label),
    el('div', { class: 'bar' }, el('div', { class: 'bar-fill ' + cls, style: `width:${pct}%` })),
    el('span', { class: 'bar-num' }, `${cur}/${max}`));
}

function invAvatar(inv, sheet) {
  const url = invAvatarUrl({ ...(sheet || {}), ...inv });
  if (url) {
    const img = el('img', { class: 'avatar inv-avatar img-avatar', src: url });
    img.addEventListener('error', () => {
      img.replaceWith(el('div', { class: 'avatar inv-avatar', style: `--hue:${npcHue(inv.name)}` }, inv.name.charAt(0)));
    });
    return img;
  }
  return el('div', { class: 'avatar inv-avatar', style: `--hue:${npcHue(inv.name)}` }, inv.name.charAt(0));
}

function renderParty(state) {
  partyEl.innerHTML = '';
  for (const inv of state.investigators) {
    const sheet = (session.sheets || []).find(s => s.id === inv.id) || inv;
    partyEl.appendChild(el('div', { class: 'inv-card' },
      el('div', { class: 'inv-head' },
        invAvatar(inv, sheet),
        el('div', {},
          el('div', { class: 'inv-name' }, inv.name, inv.kpc ? el('span', { class: 'chip chip-kpc' }, 'KPC') : null),
          el('div', { class: 'muted small' }, inv.occupation || '')),
        el('button', { class: 'btn btn-ghost btn-sm sheet-btn', onclick: () => {
          openModal(`${inv.name} — 시트`, renderSheetView({ ...sheet, ...inv }), []);
        } }, '시트')),
      bar('체력', inv.hp, inv.hpMax, 'hp'),
      bar('SAN', inv.san, inv.sanMax || 99, 'san'),
      bar('MP', inv.mp, inv.mpMax, 'mp'),
      el('div', { class: 'inv-luck' }, `🍀 행운 ${inv.luck}`),
      Object.keys(inv.trackers || {}).length
        ? el('div', { class: 'chip-row' },
            Object.entries(inv.trackers).map(([k, v]) => {
              const chip = el('span', { class: 'chip chip-track', title: '클릭해서 수치 수정' }, `${k} ${v}`);
              chip.addEventListener('click', async () => {
                const nv = prompt(`${inv.name} — ${k} 수치`, String(v));
                if (nv === null || nv.trim() === '') return;
                try {
                  const out = await API.post(`/api/sessions/${sessionId}/set-tracker`, { investigatorId: inv.id, name: k, value: parseInt(nv, 10) });
                  appendEntry(out.entry);
                  renderParty(out.state);
                } catch (err) { toast(err.message, 'error'); }
              });
              return chip;
            }))
        : null,
      (inv.statuses || []).length
        ? el('div', { class: 'chip-row' }, inv.statuses.map(s => el('span', { class: 'chip chip-status' }, s)))
        : null,
      (inv.items || []).length
        ? el('div', { class: 'chip-row' }, inv.items.map(s => el('span', { class: 'chip chip-item' }, `🎒 ${s}`)))
        : null,
    ));
  }
}

function updateSceneChip() {
  if (session.ended) {
    sceneChip.textContent = `🏁 ${session.ended.id}`;
    sceneChip.classList.add('ended');
    inputBar.classList.add('hidden');
  } else {
    sceneChip.textContent = '';
    sceneChip.classList.remove('ended');
  }
}

// ── 스트림 이벤트 처리 ──────────────────────────────────────────
function handleEvent(ev) {
  if (ev.e === 'status') setBusy(true, ev.text);
  else if (ev.e === 'msg' || ev.e === 'roll') appendEntry(ev.entry);
  else if (ev.e === 'pending') showPending(ev.rolls);
  else if (ev.e === 'pushable') showPushable(ev.options);
  else if (ev.e === 'allocate') showAllocate(ev.req);
  else if (ev.e === 'reset') {
    // 리롤: 서버가 이전 상태로 복원 — 로그/파티를 통째로 다시 그림
    session.history = ev.history;
    renderLog(ev.history);
    renderParty(ev.state);
    hidePending();
    hidePushable();
    hideAllocate();
  }
  else if (ev.e === 'state') {
    renderParty(ev.state);
    if (ev.state.ended) { session.ended = ev.state.ended; updateSceneChip(); }
  } else if (ev.e === 'error') toast(ev.message, 'error');
  else if (ev.e === 'done') {
    if (ev.ended) { session.ended = ev.ended; updateSceneChip(); }
  }
}

async function runStream(url, body) {
  if (busy) return;
  hidePushable(); // 다른 행동을 하면 밀어붙이기 기회는 지나간다
  setBusy(true, '키퍼가 생각 중…');
  try {
    await API.stream(url, body, handleEvent);
  } catch (err) {
    toast(err.message, 'error');
  }
  setBusy(false);
}

// ── 밀어붙이기 / 행운 소모 (실패한 내 판정에 대한 선택지) ───────
let pushBar = null;
function showPushable(options) {
  hidePushable();
  if (!options || !options.length) return;
  const o = options[0];
  const btns = [
    el('button', { class: 'btn btn-sm', onclick: () => {
      hidePushable();
      runStream(`/api/sessions/${sessionId}/push-roll`, { index: o.index });
    } }, '🔁 밀어붙이기'),
  ];
  if (o.luckCost) {
    btns.push(el('button', { class: 'btn btn-sm', onclick: () => {
      hidePushable();
      runStream(`/api/sessions/${sessionId}/spend-luck`, { index: o.index });
    } }, `🍀 행운 ${o.luckCost} 소모해 성공`));
  }
  pushBar = el('div', { class: 'pending-bar' },
    el('div', { class: 'pending-labels' }, el('span', { class: 'chip chip-roll' }, `🎲 ${o.label}`)),
    ...btns,
    el('button', { class: 'btn btn-ghost btn-sm', onclick: () => {
      hidePushable();
      runStream(`/api/sessions/${sessionId}/resolve-continue`, {});
    } }, '⏭ 그냥 진행'));
  inputBar.parentNode.insertBefore(pushBar, inputBar);
  scrollDown();
}
function hidePushable() {
  if (pushBar) { pushBar.remove(); pushBar = null; }
}

// ── 스탯 분배 패널 (키퍼의 allocate 요청 → 입력칸 UI) ───────────
let allocBar = null;
function showAllocate(req) {
  hideAllocate();
  const inputs = {};
  const remainEl = el('strong', {}, String(req.total));
  let okBtn;
  const update = () => {
    let sum = 0, ok = true;
    for (const s of req.stats) {
      const v = parseInt(inputs[s].value, 10);
      if (isNaN(v) || v < req.min || v > req.max) ok = false;
      else sum += v;
    }
    const remain = req.total - sum;
    remainEl.textContent = String(remain);
    remainEl.style.color = (ok && remain === 0) ? 'var(--ok)' : 'var(--err)';
    if (ok && remain === 0) okBtn.removeAttribute('disabled');
    else okBtn.setAttribute('disabled', 'disabled');
  };
  const rows = req.stats.map(s => {
    const inp = el('input', { class: 'in in-num', type: 'number', min: req.min, max: req.max, inputmode: 'numeric' });
    inp.addEventListener('input', update);
    inputs[s] = inp;
    return el('div', { class: 'alloc-row' }, el('span', { class: 'alloc-name' }, s), inp);
  });
  okBtn = el('button', { class: 'btn btn-primary', disabled: 'disabled', onclick: () => {
    const values = {};
    for (const s of req.stats) values[s] = parseInt(inputs[s].value, 10);
    hideAllocate();
    runStream(`/api/sessions/${sessionId}/allocate`, { values });
  } }, '확인');
  allocBar = el('div', { class: 'pending-bar alloc-bar' },
    el('div', { class: 'alloc-head' },
      `⚙ ${req.investigator} — 스탯 분배 (합계 ${req.total} · 각 ${req.min}~${req.max}) · 남은 포인트 `, remainEl),
    el('div', { class: 'alloc-rows' }, rows),
    okBtn);
  inputBar.parentNode.insertBefore(allocBar, inputBar);
  update();
  scrollDown();
}
function hideAllocate() {
  if (allocBar) { allocBar.remove(); allocBar = null; }
}

// ── 내 판정 굴리기 (playerDice 모드: 키퍼가 판정 요청 후 대기) ──
let pendingBar = null;
function showPending(rolls) {
  hidePending();
  pendingBar = el('div', { class: 'pending-bar' },
    el('div', { class: 'pending-labels' },
      (rolls || []).map(r => el('span', { class: 'chip chip-roll' }, `🎲 ${r}`))),
    el('button', { class: 'btn btn-primary pending-btn', onclick: () => {
      hidePending();
      runStream(`/api/sessions/${sessionId}/roll-pending`, {});
    } }, '🎲 판정 굴리기'));
  inputBar.parentNode.insertBefore(pendingBar, inputBar);
  scrollDown();
}
function hidePending() {
  if (pendingBar) { pendingBar.remove(); pendingBar = null; }
}

// ── 입력 ───────────────────────────────────────────────────────
async function send() {
  const text = chatIn.value.trim();
  if (!text || busy) return;
  chatIn.value = '';
  chatIn.style.height = 'auto';
  await runStream(`/api/sessions/${sessionId}/act`, {
    investigatorId: whoSel.value, text,
  });
}

document.getElementById('btn-send').addEventListener('click', send);
// 엔터는 줄바꿈 — 전송은 ➤ 버튼 또는 Ctrl+Enter
chatIn.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); send(); }
});
chatIn.addEventListener('input', () => {
  chatIn.style.height = 'auto';
  chatIn.style.height = Math.min(chatIn.scrollHeight, 200) + 'px';
});

document.getElementById('btn-continue').addEventListener('click', () => {
  runStream(`/api/sessions/${sessionId}/continue`, {});
});

// ── ↻ 다시 (리롤 / 피드백 반영 수정) ────────────────────────────
document.getElementById('btn-reroll').addEventListener('click', () => {
  if (busy) return;
  const fb = el('textarea', { class: 'in', rows: '3', placeholder: '(선택) 어떻게 바꿀지 지시 — 예: "더 짧게", "바론이 화내는 건 이상해, 웃어넘기게"' });
  openModal('키퍼 응답 다시 쓰기', el('div', {},
    el('p', { class: 'muted small' }, '마지막 키퍼 턴을 물리고 같은 입력에 대해 다시 씁니다. 지시를 적으면 그대로 반영하고, 비우면 그냥 새로 굴려요. 그 턴의 상태 변화(HP/SAN 등)도 함께 되돌아갑니다.'),
    fb), [
    { label: '취소', onclick: c => c() },
    { label: '↻ 다시 쓰기', primary: true, onclick: close => {
      close();
      runStream(`/api/sessions/${sessionId}/reroll`, { feedback: fb.value.trim() });
    } },
  ]);
});

// ── ↩ 되돌리기 (마지막 턴 삭제) ─────────────────────────────────
document.getElementById('btn-undo').addEventListener('click', async () => {
  if (busy) return;
  if (!confirm('마지막 턴(내 입력 포함)을 없던 일로 되돌릴까요?')) return;
  try {
    const out = await API.post(`/api/sessions/${sessionId}/undo`, {});
    session.history = out.history;
    renderLog(out.history);
    renderParty(out.state);
    hidePending();
    hidePushable();
    if (out.pendingRolls && out.pendingRolls.length) showPending(out.pendingRolls);
    toast('마지막 턴을 되돌렸습니다.', 'ok');
  } catch (err) { toast(err.message, 'error'); }
});

document.getElementById('btn-start').addEventListener('click', async () => {
  startHolder.classList.add('hidden');
  await runStream(`/api/sessions/${sessionId}/start`, {});
});

// ── 주사위 팝오버 ───────────────────────────────────────────────
const dicePop = document.getElementById('dice-pop');
const diceQuick = document.getElementById('dice-quick');
for (const expr of ['1d100', '1d20', '1d10', '1d8', '1d6', '1d4', '1d3', '2d6']) {
  diceQuick.appendChild(el('button', { class: 'btn btn-ghost btn-sm', onclick: () => manualRoll(expr) }, expr));
}
document.getElementById('btn-roll-custom').addEventListener('click', () => {
  const expr = document.getElementById('dice-expr').value.trim();
  if (expr) manualRoll(expr);
});
document.getElementById('btn-dice').addEventListener('click', e => {
  e.stopPropagation();
  dicePop.classList.toggle('hidden');
});
document.addEventListener('click', e => {
  if (!dicePop.contains(e.target) && e.target.id !== 'btn-dice') dicePop.classList.add('hidden');
});

async function manualRoll(expr) {
  try {
    const { entry } = await API.post(`/api/sessions/${sessionId}/roll`, {
      expr, who: whoSel.selectedOptions[0]?.textContent || '',
    });
    appendEntry(entry);
  } catch (err) { toast(err.message, 'error'); }
  dicePop.classList.add('hidden');
}

// ── 모바일 사이드 패널 ──────────────────────────────────────────
const sideCol = document.getElementById('side-col');
const sideDim = document.getElementById('side-dim');
function toggleSide(open) {
  sideCol.classList.toggle('open', open);
  sideDim.classList.toggle('hidden', !open);
}
document.getElementById('btn-party').addEventListener('click', () => toggleSide(true));
document.getElementById('btn-close-side').addEventListener('click', () => toggleSide(false));
sideDim.addEventListener('click', () => toggleSide(false));

// ── 초기 로드 ───────────────────────────────────────────────────
(async function init() {
  try {
    session = await API.get('/api/sessions/' + sessionId);
  } catch (err) {
    toast(err.message, 'error');
    setTimeout(() => location.href = 'index.html', 1500);
    return;
  }
  document.getElementById('session-title').textContent = session.title;
  document.title = session.title + ' — 키퍼의 방';

  whoSel.innerHTML = '';
  const playerSheets = session.sheets.filter(s => !s.kpc);
  for (const inv of playerSheets) {
    whoSel.appendChild(el('option', { value: inv.id }, inv.name));
  }
  whoSel.classList.toggle('hidden', playerSheets.length < 2);

  renderLog(session.history);
  renderParty(session.state);
  updateSceneChip();

  if (session.history.length === 0 && !session.ended) {
    startHolder.classList.remove('hidden');
  }
  if (session.pendingRolls && session.pendingRolls.length && !session.ended) {
    showPending(session.pendingRolls);
  }
  if (session.pushable && session.pushable.length && !session.ended) {
    showPushable(session.pushable);
  }
  if (session.pendingAllocate && !session.ended) {
    showAllocate(session.pendingAllocate);
  }
})();
