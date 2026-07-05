// ── 공용: API 호출, NDJSON 스트림, 테마, DOM 헬퍼 ────────────────
'use strict';

// 베이스 경로 — 단독 서버('')와 ST 플러그인 마운트('/api/plugins/keepers-parlor') 겸용
const KP_BASE = location.pathname.replace(/\/[^/]*$/, '');

function apiUrl(u) { return KP_BASE + u; }

// ST 플러그인 모드: POST/PUT/DELETE는 ST의 CSRF 토큰 필요
let _csrfToken = null;
async function csrfHeaders(method) {
  if (!KP_BASE || method === 'GET') return {};
  if (!_csrfToken) {
    try { _csrfToken = (await (await fetch('/csrf-token')).json()).token; }
    catch { return {}; } // CSRF 꺼진 ST — 헤더 없이 진행
  }
  return _csrfToken ? { 'X-CSRF-Token': _csrfToken } : {};
}

const API = {
  async req(method, url, body, retried) {
    const res = await fetch(apiUrl(url), {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(await csrfHeaders(method)),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 403 && KP_BASE && !retried) {
      _csrfToken = null; // 토큰 만료 → 한 번 재시도
      return this.req(method, url, body, true);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
    return data;
  },
  get(url) { return this.req('GET', url); },
  post(url, body) { return this.req('POST', url, body); },
  put(url, body) { return this.req('PUT', url, body); },
  del(url) { return this.req('DELETE', url); },

  // NDJSON 스트림 — 이벤트 단위 콜백
  async stream(url, body, onEvent) {
    const res = await fetch(apiUrl(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await csrfHeaders('POST')) },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `요청 실패 (${res.status})`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { onEvent(JSON.parse(line)); } catch { /* skip broken line */ }
      }
    }
    if (buf.trim()) { try { onEvent(JSON.parse(buf.trim())); } catch { /* skip */ } }
  },
};

// ── 탐사자 아바타 URL (업로드 프사 > ST 아바타 > 없음) ──────────
function invAvatarUrl(inv) {
  if (!inv) return null;
  if (inv.customAvatar) return apiUrl('/api/avatars/' + encodeURIComponent(inv.customAvatar));
  if (inv.stAvatar) {
    const route = inv.source === 'st-persona' ? 'persona-avatar' : 'char-avatar';
    return apiUrl(`/api/st/${route}/${encodeURIComponent(inv.stAvatar)}`);
  }
  return null;
}

// ── 화면 설정 (기기 저장 — 글자 크기/글꼴, 전체 배율, 엔터 전송) ──
const FontPrefs = {
  SERIF: '"RIDIBatang", "Nanum Myeongjo", "Noto Serif KR", Batang, serif',
  SANS: '"Pretendard Variable", Pretendard, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif',
  get() {
    return {
      size: parseFloat(localStorage.getItem('kp-font-size')) || 0, // 0 = 테마 기본
      family: localStorage.getItem('kp-font-family') || 'theme',
      ui: parseFloat(localStorage.getItem('kp-ui-scale')) || 100,  // 전체 배율(%)
      enterSend: localStorage.getItem('kp-enter-send') === 'on',   // 엔터로 전송
    };
  },
  update(partial) {
    const cur = this.get();
    const next = { ...cur, ...partial };
    if (next.size) localStorage.setItem('kp-font-size', String(next.size));
    else localStorage.removeItem('kp-font-size');
    localStorage.setItem('kp-font-family', next.family || 'theme');
    if (next.ui && next.ui !== 100) localStorage.setItem('kp-ui-scale', String(next.ui));
    else localStorage.removeItem('kp-ui-scale');
    localStorage.setItem('kp-enter-send', next.enterSend ? 'on' : 'off');
    this.apply();
  },
  // 하위 호환
  set(size, family) { this.update({ size, family }); },
  apply() {
    const { size, family, ui } = this.get();
    const root = document.documentElement;
    if (size) {
      root.style.setProperty('--kp-narr-size', (size + 1) + 'px');
      root.style.setProperty('--kp-chat-size', size + 'px');
    } else {
      root.style.removeProperty('--kp-narr-size');
      root.style.removeProperty('--kp-chat-size');
    }
    if (family === 'serif') root.style.setProperty('--font-narr', this.SERIF);
    else if (family === 'sans') root.style.setProperty('--font-narr', this.SANS);
    else root.style.removeProperty('--font-narr');
    // 전체 배율: zoom으로 줄어든 만큼 너비/높이를 역보정해 빈 공간이 안 생기게
    const z = (ui && ui !== 100) ? ui / 100 : 1;
    if (z !== 1) {
      document.body.style.zoom = String(z);
      document.body.style.width = (100 / z).toFixed(2) + '%';
      document.body.style.height = (100 / z).toFixed(2) + '%';
    } else {
      document.body.style.zoom = '';
      document.body.style.width = '';
      document.body.style.height = '';
    }
  },
};
FontPrefs.apply();
// 홈화면 앱의 뒤로가기 캐시 복원/다른 화면에서 바꾼 설정도 즉시 반영
window.addEventListener('pageshow', () => FontPrefs.apply());
window.addEventListener('storage', () => FontPrefs.apply());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) FontPrefs.apply();
});

// ── 테마 ───────────────────────────────────────────────────────
const Themes = {
  list: ['classic', 'midnight', 'retro', 'soda', 'novel'],
  labels: { classic: '고서', midnight: '심야', retro: '레트로팝', soda: '여름소다', novel: '소설책' },
  current() { return localStorage.getItem('kp-theme') || 'classic'; },
  apply(t) {
    if (!this.list.includes(t)) t = 'classic';
    document.documentElement.dataset.theme = t;
    localStorage.setItem('kp-theme', t);
    document.querySelectorAll('.theme-dot').forEach(d => {
      d.classList.toggle('active', d.dataset.theme === t);
    });
  },
  renderPicker(container) {
    for (const t of this.list) {
      const b = el('button', { class: 'theme-dot theme-dot-' + t, 'data-theme': t, title: this.labels[t] });
      b.addEventListener('click', () => this.apply(t));
      container.appendChild(b);
    }
    this.apply(this.current());
  },
};

// ── DOM 헬퍼 ───────────────────────────────────────────────────
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// ── 모달 ───────────────────────────────────────────────────────
function openModal(title, contentEl, actions = []) {
  const overlay = el('div', { class: 'modal-overlay' });
  const box = el('div', { class: 'modal' },
    el('div', { class: 'modal-head' },
      el('h3', {}, title),
      el('button', { class: 'modal-x', onclick: close }, '✕')),
    el('div', { class: 'modal-body' }, contentEl),
    actions.length ? el('div', { class: 'modal-actions' },
      actions.map(a => el('button', {
        class: 'btn ' + (a.primary ? 'btn-primary' : 'btn-ghost'),
        onclick: () => a.onclick(close),
      }, a.label))) : null,
  );
  overlay.appendChild(box);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  function close() {
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 180);
  }
  return close;
}

// ── 토스트 ─────────────────────────────────────────────────────
function toast(msg, kind = 'info') {
  let holder = document.querySelector('.toast-holder');
  if (!holder) {
    holder = el('div', { class: 'toast-holder' });
    document.body.appendChild(holder);
  }
  const t = el('div', { class: 'toast toast-' + kind }, msg);
  holder.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3500);
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
