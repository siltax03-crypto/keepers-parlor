/**
 * SillyTavern Server Plugin — keepers-parlor
 *
 * 키퍼의 방 게임 서버를 ST 확장 화면에서 관리하기 위한 플러그인.
 * discord-bridge-config와 같은 역할: 상태 조회 / 재시작 / 업데이트.
 *
 * 게임 접속은 ST를 거치지 않는다 — 서버 자기 주소로 직접: http://<서버주소>:4020
 *
 * 설치: cp st-plugin/index.js ~/SillyTavern/plugins/keepers-parlor.js
 * 마운트 경로: /api/plugins/keepers-parlor
 *
 * 환경변수:
 *   KEEPERS_PARLOR_PATH — keepers-parlor 폴더 경로 (기본: ST와 형제 폴더 ../keepers-parlor)
 *   KEEPERS_PARLOR_URL  — 게임 서버 내부 주소 (기본: http://127.0.0.1:4020)
 *   PM2_NAME_PARLOR     — pm2 프로세스 이름 (기본: keepers-parlor)
 */

const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

// 플러그인은 ST 루트에서 실행된다 (./start.sh 기준 cwd = ST 루트)
const ST_ROOT = process.cwd();
const PARLOR_PATH = process.env.KEEPERS_PARLOR_PATH || path.join(ST_ROOT, '..', 'keepers-parlor');
const TARGET = (process.env.KEEPERS_PARLOR_URL || 'http://127.0.0.1:4020').replace(/\/$/, '');
const PM2_NAME = process.env.PM2_NAME_PARLOR || 'keepers-parlor';

const info = {
  id: 'keepers-parlor',
  name: '키퍼의 방 (Keeper\'s Parlor)',
  description: 'AI 키퍼 TRPG 테이블 — 게임 서버 관리 (상태/재시작/업데이트).',
};

// 서버 접속 정보 (확장이 "테이블 열기" 주소를 만들 때 사용)
function getInfo(req, res) {
  let port = 4020;
  try { port = Number(new URL(TARGET).port) || 4020; } catch { /* 기본값 */ }
  res.json({ target: TARGET, port, path: PARLOR_PATH, pm2Name: PM2_NAME });
}

// 게임 서버 작동 상태 (플러그인이 서버 안에서 대신 확인)
async function getStatus(req, res) {
  try {
    const r = await fetch(`${TARGET}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return res.json({ running: false });
    const h = await r.json();
    res.json({ running: true, version: h.version || '?' });
  } catch {
    res.json({ running: false });
  }
}

// 서버 재시작 (pm2)
function postRestart(req, res) {
  exec(`pm2 restart ${PM2_NAME}`, { timeout: 15000 }, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ error: (stderr || err.message || '').trim() || 'pm2 restart 실패' });
    }
    res.json({ ok: true, output: (stdout || '').trim() });
  });
}

// 업데이트: git → npm install → 플러그인/확장 재복사 → 서버 재시작
function postUpdate(req, res) {
  const pluginDest = path.join(ST_ROOT, 'plugins', 'keepers-parlor.js');
  const extCandidates = [
    path.join(ST_ROOT, 'data', 'default-user', 'extensions', 'keepers-parlor'),
    path.join(ST_ROOT, 'public', 'scripts', 'extensions', 'third-party', 'keepers-parlor'),
  ];
  const extDir = extCandidates.find(p => fs.existsSync(p)) || extCandidates[0];

  const cmd = [
    `cd "${PARLOR_PATH}"`,
    'git fetch origin',
    'git checkout main',
    'git reset --hard origin/main',
    'npm --prefix server install --no-audit --no-fund',
    `cp st-plugin/index.js "${pluginDest}"`,
    `mkdir -p "${extDir}"`,
    `cp st-ext/manifest.json st-ext/index.js st-ext/style.css "${extDir}/"`,
    `pm2 restart ${PM2_NAME}`,
  ].join(' && ');

  exec(cmd, { timeout: 120000, shell: '/bin/bash' }, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ error: (stderr || err.message || '').trim(), output: (stdout || '').trim() });
    }
    res.json({ ok: true, output: (stdout || '').trim() });
  });
}

async function init(router) {
  router.get('/info', getInfo);
  router.get('/status', getStatus);
  router.post('/restart', postRestart);
  router.post('/update', postUpdate);
  console.log(`[keepers-parlor] 플러그인 로드됨 — 서버: ${TARGET}, 경로: ${PARLOR_PATH}`);
}

async function exit() {}

module.exports = { info, init, exit };
