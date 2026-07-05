// ── SillyTavern 데이터 리더 (discord-bridge st-reader 포팅, CJS) ──
// ST 설치 폴더(stPath)의 파일을 직접 읽는다. 서버가 ST와 같은 머신에 있어야 함.
const fs = require('fs');
const path = require('path');

let stPath = '';
let defaultPath = ''; // 플러그인 모드: ST 프로세스의 cwd (설정 경로가 비어 있으면 이걸 사용)

function setDefaultPath(p) { defaultPath = p || ''; if (!stPath) stPath = defaultPath; }
function setPath(p) { stPath = p || defaultPath; }
function currentPath() { return stPath; }
function available() { return !!stPath && fs.existsSync(stPath); }

function dataDir(...parts) { return path.join(stPath, 'data', 'default-user', ...parts); }
function firstExisting(cands) { for (const c of cands) if (fs.existsSync(c)) return c; return null; }
function readJSONFile(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function getSettings() {
  const p = firstExisting([dataDir('settings.json'), path.join(stPath, 'settings.json')]);
  return (p && readJSONFile(p)) || {};
}

function getSecrets() {
  const p = firstExisting([dataDir('secrets.json'), path.join(stPath, 'secrets.json')]);
  return (p && readJSONFile(p)) || {};
}

// ── 커넥션 프로필 ─────────────────────────────────────────────
function listConnectionProfiles() {
  const cm = getSettings().extension_settings?.connectionManager;
  if (!cm?.profiles?.length) return [];
  return cm.profiles.map(p => ({
    id: p.id, name: p.name, api: p.api || '', model: p.model || '',
    preset: p.preset || '', selected: p.id === cm.selectedProfile,
  }));
}

// secrets.json: api_key_*: [{id, value, label, active}] 배열 구조
function getSecretByID(secretId) {
  if (!secretId) return null;
  const secrets = getSecrets();
  for (const [, val] of Object.entries(secrets)) {
    if (Array.isArray(val)) {
      const entry = val.find(e => e && e.id === secretId);
      if (entry) return entry.value;
    }
  }
  if (typeof secrets[secretId] === 'string') return secrets[secretId];
  return null;
}

function getConnectionProfile(profileNameOrId) {
  const cm = getSettings().extension_settings?.connectionManager;
  if (!cm?.profiles?.length) throw new Error('ST ConnectionManager 프로필이 없습니다.');
  let profile = null;
  if (profileNameOrId) {
    profile = cm.profiles.find(p => p.name === profileNameOrId || p.id === profileNameOrId);
  }
  if (!profile) profile = cm.profiles.find(p => p.id === cm.selectedProfile) || cm.profiles[0];
  if (!profile) throw new Error('사용할 ST 프로필을 찾을 수 없습니다.');
  return { ...profile, apiKey: getSecretByID(profile['secret-id']) };
}

// ── 프리셋 (항목 단위 — 마커 제외, prompt_order 순서) ───────────
function getPresetEntries(presetName) {
  if (!presetName) return [];
  const p = firstExisting([
    dataDir('OpenAI Settings', `${presetName}.json`),
    path.join(stPath, 'public', 'OpenAI Settings', `${presetName}.json`),
  ]);
  const preset = p && readJSONFile(p);
  if (!preset?.prompts) return [];

  const byId = {};
  for (const pr of preset.prompts) byId[pr.identifier] = pr;

  let entries = null;
  if (Array.isArray(preset.prompt_order) && preset.prompt_order.length) {
    const ord = preset.prompt_order.find(o => o.character_id === 100001)
      || preset.prompt_order[preset.prompt_order.length - 1];
    entries = ord?.order;
  }
  if (!entries) entries = preset.prompts.map(pr => ({ identifier: pr.identifier, enabled: pr.enabled !== false }));

  const out = [];
  for (const e of entries) {
    const pr = byId[e.identifier];
    if (!pr || pr.marker) continue;
    const content = (pr.content || '').trim();
    if (!content) continue;
    out.push({
      identifier: pr.identifier,
      name: pr.name || pr.identifier,
      enabled: e.enabled !== false,
      content,
    });
  }
  return out;
}

function getPresetPromptsByName(presetName) {
  return getPresetEntries(presetName).filter(e => e.enabled).map(e => e.content).join('\n\n');
}

// ── 페르소나 ──────────────────────────────────────────────────
// 실제 ST 구조 (discord-bridge에서 확인됨):
// power_user.persona_descriptions[아바타].connections = [{ type:'character', id:'캐릭터.png' }, ...]
function normalizeConnections(conns) {
  if (!Array.isArray(conns)) return [];
  return conns
    .map(c => (typeof c === 'string' ? c : (c && c.type === 'character' ? c.id : '')))
    .filter(Boolean)
    .map(String);
}

function listPersonas() {
  const pu = getSettings().power_user || {};
  const personas = pu.personas || {};
  const descs = pu.persona_descriptions || {};
  return Object.entries(personas).map(([avatar, name]) => ({
    avatar, name,
    description: descs[avatar]?.description || '',
    connections: normalizeConnections(descs[avatar]?.connections),
  }));
}

// 페르소나에 연결(커넥션)된 캐릭터 집합 (아바타 파일명 + 확장자 없는 이름 둘 다)
function getConnectedCharacterSet() {
  const set = new Set();
  for (const p of listPersonas()) {
    for (const c of p.connections) {
      set.add(c);
      set.add(c.replace(/\.[^/.]+$/, ''));
    }
  }
  return set;
}

function getPersonaAvatarPath(avatar) {
  if (!avatar) return null;
  return firstExisting([
    dataDir('User Avatars', avatar),
    path.join(stPath, 'public', 'User Avatars', avatar),
  ]);
}

// ── 캐릭터 카드 ───────────────────────────────────────────────
function getCharactersDir() {
  return firstExisting([dataDir('characters'), path.join(stPath, 'public', 'characters')]);
}

// PNG 텍스트 청크에서 카드 페이로드 수집 — tEXt + iTXt(비압축), 'ccv3'(V3) 우선 'chara'(V2) 폴백
function readPngCardChunks(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504E47) return null;
  const found = {}; // key → base64 payload
  let offset = 8;
  while (offset + 8 < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd <= buf.length && (type === 'tEXt' || type === 'iTXt')) {
      const chunk = buf.subarray(dataStart, dataEnd);
      const nullIdx = chunk.indexOf(0);
      if (nullIdx !== -1) {
        const key = chunk.toString('ascii', 0, nullIdx);
        if (key === 'chara' || key === 'ccv3') {
          if (type === 'tEXt') {
            found[key] = chunk.toString('ascii', nullIdx + 1);
          } else {
            // iTXt: keyword\0 compFlag(1) compMethod(1) lang\0 translated\0 text
            const compFlag = chunk[nullIdx + 1];
            if (compFlag === 0) {
              let p = nullIdx + 3;
              p = chunk.indexOf(0, p) + 1;  // lang 건너뜀
              p = chunk.indexOf(0, p) + 1;  // translated 건너뜀
              if (p > 0) found[key] = chunk.toString('utf8', p);
            }
          }
        }
      }
    }
    offset = dataEnd + 4;
  }
  return found;
}

function readPngCharacterCard(filePath) {
  const found = readPngCardChunks(filePath);
  if (!found) return null;
  for (const key of ['ccv3', 'chara']) {
    if (!found[key]) continue;
    try {
      return JSON.parse(Buffer.from(found[key], 'base64').toString('utf-8'));
    } catch { /* 다음 키 시도 */ }
  }
  return null;
}

function cardField(card, field) {
  return card?.[field] || card?.data?.[field] || '';
}

function listCharacters() {
  const dir = getCharactersDir();
  if (!dir) return [];
  const connected = getConnectedCharacterSet();
  const out = [];
  for (const file of fs.readdirSync(dir)) {
    try {
      let card = null;
      if (file.endsWith('.png')) card = readPngCharacterCard(path.join(dir, file));
      else if (file.endsWith('.json')) card = readJSONFile(path.join(dir, file));
      if (!card) continue;
      const name = cardField(card, 'name');
      if (!name) continue;
      const charId = file.replace(/\.[^/.]+$/, '');
      out.push({
        avatar: file, name,
        descriptionPreview: String(cardField(card, 'description')).slice(0, 120),
        world: card?.data?.extensions?.world || '',
        hasBook: !!card?.data?.character_book?.entries,
        hasCharm: !!findCharmFile(charId),
        isPng: file.endsWith('.png'),
        connected: connected.has(file) || connected.has(charId) || connected.has(name),
      });
    } catch { /* 깨진 카드 스킵 */ }
  }
  return out.sort((a, b) => (b.connected - a.connected) || a.name.localeCompare(b.name, 'ko'));
}

function getCharacter(avatarOrName) {
  const dir = getCharactersDir();
  if (!dir) throw new Error('ST 캐릭터 폴더를 찾을 수 없습니다.');
  // 1) 아바타 파일명으로 직접
  const direct = path.join(dir, avatarOrName);
  if (avatarOrName.match(/\.(png|json)$/i) && fs.existsSync(direct)) {
    const card = avatarOrName.endsWith('.png') ? readPngCharacterCard(direct) : readJSONFile(direct);
    if (card) { card.avatar = avatarOrName; return card; }
  }
  // 2) 이름으로 스캔
  for (const file of fs.readdirSync(dir)) {
    try {
      let card = null;
      if (file.endsWith('.png')) card = readPngCharacterCard(path.join(dir, file));
      else if (file.endsWith('.json')) card = readJSONFile(path.join(dir, file));
      if (card && cardField(card, 'name') === avatarOrName) {
        card.avatar = file;
        return card;
      }
    } catch { /* skip */ }
  }
  throw new Error(`ST 캐릭터를 찾을 수 없습니다: ${avatarOrName}`);
}

function getCharacterAvatarPath(avatarFile) {
  const dir = getCharactersDir();
  if (!dir || !avatarFile) return null;
  const p = path.join(dir, path.basename(avatarFile));
  return fs.existsSync(p) ? p : null;
}

// ── 로어북 ────────────────────────────────────────────────────
function getWorldInfo(worldName) {
  if (!worldName) return [];
  const dir = firstExisting([dataDir('worlds'), path.join(stPath, 'public', 'worlds')]);
  if (!dir) return [];
  const data = readJSONFile(path.join(dir, `${worldName}.json`));
  if (!data?.entries) return [];
  const entries = typeof data.entries === 'object' ? Object.values(data.entries) : data.entries;
  return entries.filter(e => e && !e.disable && e.content);
}

function getCharacterBook(card) {
  const book = card?.data?.character_book;
  if (!book?.entries) return [];
  const entries = typeof book.entries === 'object' ? Object.values(book.entries) : book.entries;
  return entries.filter(e => e && !e.disable && e.content);
}

// ── CHARM 메모리 ──────────────────────────────────────────────
function findCharmFile(charId) {
  const safe = String(charId).replace(/[^a-zA-Z0-9_\-]/g, '_');
  return firstExisting([
    dataDir('user', 'files', `charm-memory-${safe}.json`),
    dataDir('files', `charm-memory-${safe}.json`),
    path.join(stPath, 'public', 'user', 'files', `charm-memory-${safe}.json`),
  ]);
}

function getCharmMemory(charId) {
  const p = findCharmFile(charId);
  return p ? readJSONFile(p) : null;
}

// pinned 우선, 중요도순 상위 50개 + 최근 타임라인 5개 (discord-bridge와 동일)
function buildCharmDigest(charmData) {
  if (!charmData) return '';
  const lines = [];
  if (charmData.memories?.length) {
    const active = charmData.memories
      .filter(m => m && (m.strength > 0.3 || m.pinned))
      .sort((a, b) => {
        if (!!a.pinned !== !!b.pinned) return b.pinned ? 1 : -1;
        return (b.importance || 0) - (a.importance || 0);
      })
      .slice(0, 50);
    for (const m of active) if (m.text?.trim()) lines.push(m.text.trim());
  }
  if (charmData.timeline?.length) {
    const recent = [...charmData.timeline]
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 5);
    for (const t of recent) {
      const text = t.text || t.summary || t.content || '';
      if (text.trim()) lines.push(text.trim());
    }
  }
  return lines.join('\n');
}

// ── KPC용 캐릭터 컨텍스트 조립 (카드 + 로어북 + 참메모리) ───────
const CONTEXT_CAP = 14000; // 턴마다 주입되는 KPC 스냅샷 기본 상한 (시트 생성은 cap 옵션으로 더 크게)

function buildCharacterContext(avatarOrName, { cap = CONTEXT_CAP } = {}) {
  const card = getCharacter(avatarOrName);
  const name = cardField(card, 'name');
  const parts = [];

  const desc = cardField(card, 'description');
  if (desc) parts.push(`[Description]\n${desc}`);
  const pers = cardField(card, 'personality');
  if (pers) parts.push(`[Personality]\n${pers}`);
  const scen = cardField(card, 'scenario');
  if (scen) parts.push(`[Scenario]\n${scen}`);
  const sys = cardField(card, 'system_prompt');
  if (sys) parts.push(`[System Prompt]\n${sys}`);
  const depth = card?.data?.extensions?.depth_prompt?.prompt;
  if (depth) parts.push(`[Depth Prompt]\n${depth}`);
  const first = cardField(card, 'first_mes');
  if (first) parts.push(`[First Message]\n${first}`);
  const alts = card?.data?.alternate_greetings;
  if (Array.isArray(alts) && alts.length) parts.push(`[Alternate Greeting]\n${alts[0]}`);
  const mes = cardField(card, 'mes_example');
  if (mes) parts.push(`[Example Dialogue]\n${mes}`);

  const loreParts = [];
  const bookEntries = getCharacterBook(card);
  if (bookEntries.length) loreParts.push(bookEntries.map(e => e.content).join('\n---\n'));
  const worldName = card?.data?.extensions?.world;
  const worldEntries = getWorldInfo(worldName);
  if (worldEntries.length) loreParts.push(worldEntries.map(e => e.content).join('\n---\n'));
  if (loreParts.length) parts.push(`[Lorebook]\n${loreParts.join('\n---\n')}`);

  const charId = (card.avatar || name).replace(/\.[^/.]+$/, '');
  const digest = buildCharmDigest(getCharmMemory(charId));
  if (digest) parts.push(`[Memories]\n${digest}`);

  let text = parts.join('\n\n');
  if (text.length > cap) text = text.slice(0, cap) + '\n…(길이 제한으로 잘림)';
  return { name, avatar: card.avatar || '', text };
}

// 카드 진단: 어떤 청크/필드를 읽었고 각각 몇 자인지
function debugCharacter(avatarOrName) {
  const card = getCharacter(avatarOrName);
  const dir = getCharactersDir();
  const file = card.avatar || avatarOrName;
  const p = dir ? path.join(dir, path.basename(String(file))) : null;
  let chunks = [];
  if (p && p.endsWith('.png') && fs.existsSync(p)) {
    const found = readPngCardChunks(p) || {};
    chunks = Object.keys(found);
  } else if (String(file).endsWith('.json')) {
    chunks = ['json'];
  }
  const fields = {};
  for (const f of ['description', 'personality', 'scenario', 'system_prompt', 'first_mes', 'mes_example']) {
    fields[f] = String(cardField(card, f) || '').length;
  }
  fields.depth_prompt = String(card?.data?.extensions?.depth_prompt?.prompt || '').length;
  fields.alternate_greetings = Array.isArray(card?.data?.alternate_greetings) ? card.data.alternate_greetings.length : 0;
  const ctx = buildCharacterContext(avatarOrName);
  return {
    avatar: card.avatar || '',
    name: cardField(card, 'name'),
    spec: card.spec || (card.data ? 'v2/v3' : 'v1'),
    chunks,
    fields,
    bookEntries: getCharacterBook(card).length,
    world: card?.data?.extensions?.world || '',
    charm: !!findCharmFile((card.avatar || String(avatarOrName)).replace(/\.[^/.]+$/, '')),
    contextLength: ctx.text.length,
    contextPreview: ctx.text.slice(0, 600),
  };
}

module.exports = {
  setPath, setDefaultPath, currentPath, available, debugCharacter,
  getSettings, getSecrets,
  listConnectionProfiles, getConnectionProfile, getPresetPromptsByName, getPresetEntries,
  listPersonas, getPersonaAvatarPath,
  listCharacters, getCharacter, getCharacterAvatarPath,
  getWorldInfo, getCharacterBook,
  getCharmMemory, buildCharmDigest, buildCharacterContext,
};
