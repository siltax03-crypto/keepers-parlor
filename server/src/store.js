// ── JSON 파일 저장소 ────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function dirOf(kind) {
  const p = path.join(DATA_DIR, kind);
  ensureDir(p);
  return p;
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function safeName(id) {
  return String(id).replace(/[^a-z0-9_-]/gi, '');
}

function readJSON(kind, id) {
  const f = path.join(dirOf(kind), safeName(id) + '.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function writeJSON(kind, id, obj) {
  const f = path.join(dirOf(kind), safeName(id) + '.json');
  fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8');
  return obj;
}

function deleteJSON(kind, id) {
  const f = path.join(dirOf(kind), safeName(id) + '.json');
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

function listJSON(kind) {
  const dir = dirOf(kind);
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const DEFAULT_SETTINGS = {
  provider: 'gemini',
  gemini: { apiKey: '', model: 'gemini-3.1-pro' },
  claude: { apiKey: '', model: 'claude-sonnet-5' },
  st: { path: '', profile: '', usePreset: true, presetDisabled: [], presetExtra: [] },
  theme: 'classic',
  playerDice: true, // 내 탐사자의 판정은 내가 굴린다 (판정 요청 시 일시정지)
  pace: 'beat',     // beat = 대화형(자주 멈춤) / flow = 쭉 진행
  narration: 'novel', // novel = 소설체(-했다) / polite = 경어체(-합니다)
};

function getSettings() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(SETTINGS_FILE)) return { ...DEFAULT_SETTINGS };
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return {
      ...DEFAULT_SETTINGS, ...s,
      gemini: { ...DEFAULT_SETTINGS.gemini, ...(s.gemini || {}) },
      claude: { ...DEFAULT_SETTINGS.claude, ...(s.claude || {}) },
      st: { ...DEFAULT_SETTINGS.st, ...(s.st || {}) },
    };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

function saveSettings(s) {
  ensureDir(DATA_DIR);
  const merged = getSettings();
  if (s.provider) merged.provider = s.provider;
  if (s.theme) merged.theme = s.theme;
  if (typeof s.playerDice === 'boolean') merged.playerDice = s.playerDice;
  if (s.pace) merged.pace = s.pace;
  if (s.narration) merged.narration = s.narration;
  if (s.gemini) merged.gemini = { ...merged.gemini, ...s.gemini };
  if (s.claude) merged.claude = { ...merged.claude, ...s.claude };
  if (s.st) merged.st = { ...merged.st, ...s.st };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

module.exports = { newId, readJSON, writeJSON, deleteJSON, listJSON, getSettings, saveSettings };
