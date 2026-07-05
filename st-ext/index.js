// ── 키퍼의 방 — SillyTavern UI 확장 (런처 + 관리) ────────────────
// discord-bridge 방식: 이 폴더의 파일들을 ST 확장 폴더에 복사해서 쓴다.
//   mkdir -p ~/SillyTavern/data/default-user/extensions/keepers-parlor
//   cp st-ext/* ~/SillyTavern/data/default-user/extensions/keepers-parlor/
//
// 게임은 서버 자기 주소(http://<서버주소>:4020)로 직접 열린다.
// 설치 후 관리는 여기서 다 처리: 열기 / 상태 / 서버 재시작 / 업데이트.
const PLUGIN_ID = 'keepers-parlor';
const PLUGIN_BASE = `/api/plugins/${PLUGIN_ID}`;

let serverInfo = null; // { target, port, path } — 플러그인이 알려주는 게임 서버 정보

async function fetchInfo() {
  if (serverInfo) return serverInfo;
  try {
    const res = await fetch(`${PLUGIN_BASE}/info`);
    if (res.ok) serverInfo = await res.json();
  } catch { /* 플러그인 없음 */ }
  return serverInfo;
}

// 게임 접속 주소: 서버가 로컬(127.0.0.1)로 설정돼 있으면 ST와 같은 호스트의 해당 포트로
function gameUrl() {
  const port = (serverInfo && serverInfo.port) || 4020;
  try {
    const t = new URL(serverInfo.target);
    if (t.hostname !== '127.0.0.1' && t.hostname !== 'localhost') return serverInfo.target + '/';
  } catch { /* 기본 규칙 사용 */ }
  return `http://${location.hostname}:${port}/`;
}

async function openParlor() {
  await fetchInfo();
  window.open(gameUrl(), '_blank');
}

// ST의 CSRF 토큰 (POST용)
let _csrf = null;
async function csrfToken() {
  if (_csrf) return _csrf;
  try { _csrf = (await (await fetch('/csrf-token')).json()).token; } catch { /* CSRF 꺼진 ST */ }
  return _csrf;
}

async function sysPost(action) {
  const res = await fetch(`${PLUGIN_BASE}/${action}`, {
    method: 'POST',
    headers: { 'X-CSRF-Token': await csrfToken() },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

jQuery(async () => {
  const settingsHtml = `
  <div id="kp-ext-settings">
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>⚿ 키퍼의 방 (Keeper's Parlor)</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <div id="kp-status" class="kp-status">상태 확인 중…</div>
        <div class="kp-actions">
          <div id="kp-open" class="menu_button" title="새 탭에서 TRPG 테이블 열기">🕯 테이블 열기</div>
          <div id="kp-recheck" class="menu_button" title="서버 상태 다시 확인">상태 새로고침</div>
          <div id="kp-restart" class="menu_button" title="게임 서버 재시작 (pm2)">🔄 서버 재시작</div>
          <div id="kp-update" class="menu_button" title="최신 버전 받아서 재배포 (git + npm + 재시작)">⬇ 업데이트</div>
        </div>
        <div id="kp-info" class="kp-update-info" style="display:none"></div>
        <div id="kp-help" class="kp-help" style="display:none"></div>
      </div>
    </div>
  </div>`;
  $('#extensions_settings2').append(settingsHtml);

  // 지팡이(확장) 메뉴 바로가기
  const menuItem = $(`
    <div id="kp-wand-item" class="list-group-item flex-container flexGap5 interactable" tabindex="0" title="키퍼의 방 열기">
      <span>⚿</span><span>키퍼의 방</span>
    </div>`);
  $('#extensionsMenu').append(menuItem);
  menuItem.on('click', openParlor);

  $('#kp-open').on('click', openParlor);
  $('#kp-recheck').on('click', refresh);

  $('#kp-restart').on('click', async () => {
    const info = $('#kp-info').show().text('서버 재시작 중…');
    try {
      await sysPost('restart');
      info.text('✅ 서버를 재시작했습니다.');
      setTimeout(refresh, 1500);
    } catch (err) {
      info.text(`⚠️ 재시작 실패: ${err.message}`);
    }
  });

  $('#kp-update').on('click', async () => {
    if (!confirm('최신 버전으로 업데이트할까요?\n(git pull → npm install → 플러그인/확장 재복사 → 서버 재시작)')) return;
    const info = $('#kp-info').show().text('업데이트 중… (최대 2분)');
    try {
      const data = await sysPost('update');
      info.html('✅ 업데이트 완료 — 서버 재시작됨.<br><small>플러그인/확장 파일도 갱신됐습니다. 완전 반영은 ST 재시작 + 새로고침 후.</small>'
        + (data.output ? `<pre>${$('<i>').text(data.output).html()}</pre>` : ''));
      setTimeout(refresh, 1500);
    } catch (err) {
      info.text(`⚠️ 업데이트 실패: ${err.message}`);
    }
  });

  async function refresh() {
    $('#kp-status').text('상태 확인 중…');
    const help = $('#kp-help');
    const info = await fetchInfo();
    if (!info) {
      $('#kp-status').html('⚠️ ST 플러그인이 없습니다');
      help.html(
        '서버에서:<br>' +
        '<code>cp ~/keepers-parlor/st-plugin/index.js ~/SillyTavern/plugins/keepers-parlor.js</code><br>' +
        '+ <code>config.yaml</code>에 <code>enableServerPlugins: true</code> → ST 재시작'
      ).show();
      return;
    }
    let status = { running: false };
    try {
      const res = await fetch(`${PLUGIN_BASE}/status`);
      if (res.ok) status = await res.json();
    } catch { /* 아래에서 꺼짐 처리 */ }
    if (status.running) {
      const url = gameUrl();
      $('#kp-status').html(`🟢 게임 서버 작동 중 — v${status.version || '?'} · <a href="${url}" target="_blank">${url}</a>`);
      help.hide();
    } else {
      $('#kp-status').html('🔴 게임 서버가 꺼져 있습니다');
      help.html('🔄 서버 재시작 버튼을 누르거나, 서버에서 <code>pm2 restart keepers-parlor</code> (처음이면 설치설명서 B-1)').show();
    }
  }
  refresh();
});
