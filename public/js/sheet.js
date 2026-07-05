// ── CoC 7e 탐사자 시트 편집기 ───────────────────────────────────
'use strict';

const SHEET_STATS = ['STR', 'CON', 'SIZ', 'DEX', 'APP', 'INT', 'POW', 'EDU'];
const SHEET_STAT_LABEL = {
  STR: '근력', CON: '건강', SIZ: '크기', DEX: '민첩',
  APP: '외모', INT: '지능', POW: '정신력', EDU: '교육',
};

function sheetDerive(stats) {
  const hpMax = Math.floor((stats.CON + stats.SIZ) / 10);
  const mpMax = Math.floor(stats.POW / 5);
  const sum = stats.STR + stats.SIZ;
  let db = '0';
  if (sum <= 64) db = '-2'; else if (sum <= 84) db = '-1';
  else if (sum <= 124) db = '0'; else if (sum <= 164) db = '+1d4'; else db = '+1d6';
  let mov = 8;
  if (stats.DEX < stats.SIZ && stats.STR < stats.SIZ) mov = 7;
  else if (stats.DEX > stats.SIZ && stats.STR > stats.SIZ) mov = 9;
  return { hpMax, mpMax, sanStart: stats.POW, db, mov };
}

// 시트 편집 폼 생성 — { root, setData(inv), getData() }
function createSheetEditor(initial) {
  const root = el('div', { class: 'sheet-editor' });
  let skillRows = [];

  // 기본 정보
  const nameIn = el('input', { class: 'in', placeholder: '이름', maxlength: '40' });
  const occIn = el('input', { class: 'in', placeholder: '직업', maxlength: '40' });
  const ageIn = el('input', { class: 'in in-num', type: 'number', min: '15', max: '99', placeholder: '나이' });
  const genderIn = el('input', { class: 'in', placeholder: '성별', maxlength: '20' });
  root.appendChild(el('div', { class: 'sheet-sec' },
    el('h4', {}, '기본 정보'),
    el('div', { class: 'sheet-grid-2' },
      field('이름', nameIn), field('직업', occIn), field('나이', ageIn), field('성별', genderIn)),
  ));

  // 특성치
  const statIns = {};
  const statGrid = el('div', { class: 'stat-grid' });
  for (const s of SHEET_STATS) {
    statIns[s] = el('input', { class: 'in in-num stat-in', type: 'number', min: '1', max: '99', 'data-stat': s });
    statIns[s].addEventListener('input', refreshDerived);
    statGrid.appendChild(el('div', { class: 'stat-cell' },
      el('div', { class: 'stat-name' }, SHEET_STAT_LABEL[s], el('span', { class: 'stat-eng' }, ' ' + s)),
      statIns[s],
      el('div', { class: 'stat-halves', 'data-halves': s }, ''),
    ));
  }
  const luckIn = el('input', { class: 'in in-num stat-in', type: 'number', min: '0', max: '99' });
  statGrid.appendChild(el('div', { class: 'stat-cell stat-luck' },
    el('div', { class: 'stat-name' }, '행운', el('span', { class: 'stat-eng' }, ' LUCK')),
    luckIn, el('div', { class: 'stat-halves' }, '')));
  const derivedBox = el('div', { class: 'derived-box' });
  root.appendChild(el('div', { class: 'sheet-sec' },
    el('h4', {}, '특성치'), statGrid, derivedBox));

  // 기능
  const skillList = el('div', { class: 'skill-grid' });
  const addName = el('input', { class: 'in', placeholder: '기능 이름', maxlength: '30' });
  const addVal = el('input', { class: 'in in-num', type: 'number', min: '0', max: '99', placeholder: '수치' });
  const addBtn = el('button', { class: 'btn btn-ghost btn-sm', onclick: () => {
    const n = addName.value.trim();
    const v = parseInt(addVal.value, 10);
    if (!n || isNaN(v)) return;
    addSkillRow(n, v);
    addName.value = ''; addVal.value = '';
  } }, '＋ 추가');
  root.appendChild(el('div', { class: 'sheet-sec' },
    el('h4', {}, '기능'),
    skillList,
    el('div', { class: 'skill-add' }, addName, addVal, addBtn),
  ));

  // 배경
  const bgIn = el('textarea', { class: 'in', rows: '3', placeholder: '외모, 성격, 배경 이야기… (키퍼가 참고합니다)' });
  root.appendChild(el('div', { class: 'sheet-sec' },
    el('h4', {}, '배경'), bgIn));

  function field(label, input) {
    return el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), input);
  }

  function addSkillRow(name, value) {
    const valIn = el('input', { class: 'in in-num', type: 'number', min: '0', max: '99', value: String(value) });
    const row = el('div', { class: 'skill-row' },
      el('span', { class: 'skill-name', title: name }, name),
      valIn,
      el('button', { class: 'skill-del', title: '삭제', onclick: () => {
        skillRows = skillRows.filter(r => r.row !== row);
        row.remove();
      } }, '✕'),
    );
    skillRows.push({ row, name, valIn });
    skillList.appendChild(row);
  }

  function refreshDerived() {
    const stats = {};
    for (const s of SHEET_STATS) stats[s] = parseInt(statIns[s].value, 10) || 0;
    const d = sheetDerive(stats);
    derivedBox.innerHTML = '';
    const items = [['체력', d.hpMax], ['MP', d.mpMax], ['SAN 시작', d.sanStart], ['피해 보너스', d.db], ['이동력', d.mov]];
    for (const [k, v] of items) {
      derivedBox.appendChild(el('div', { class: 'derived-item' },
        el('span', { class: 'derived-k' }, k), el('span', { class: 'derived-v' }, String(v))));
    }
    root.querySelectorAll('.stat-halves[data-halves]').forEach(hv => {
      const v = stats[hv.dataset.halves] || 0;
      hv.textContent = `절반 ${Math.floor(v / 2)} · 1/5 ${Math.floor(v / 5)}`;
    });
  }

  function setData(inv) {
    nameIn.value = inv.name || '';
    occIn.value = inv.occupation || '';
    ageIn.value = inv.age || '';
    genderIn.value = inv.gender || '';
    bgIn.value = inv.background || '';
    for (const s of SHEET_STATS) statIns[s].value = inv.stats?.[s] ?? 50;
    luckIn.value = inv.luck ?? 50;
    skillRows = [];
    skillList.innerHTML = '';
    const skills = inv.skills || {};
    for (const name of Object.keys(skills).sort((a, b) => a.localeCompare(b, 'ko'))) {
      addSkillRow(name, skills[name]);
    }
    refreshDerived();
  }

  function getData() {
    const stats = {};
    for (const s of SHEET_STATS) stats[s] = parseInt(statIns[s].value, 10) || 50;
    const skills = {};
    for (const r of skillRows) {
      const v = parseInt(r.valIn.value, 10);
      if (!isNaN(v)) skills[r.name] = v;
    }
    return {
      name: nameIn.value.trim() || '무명',
      occupation: occIn.value.trim(),
      age: parseInt(ageIn.value, 10) || 25,
      gender: genderIn.value.trim(),
      background: bgIn.value.trim(),
      stats, luck: parseInt(luckIn.value, 10) || 50, skills,
    };
  }

  if (initial) setData(initial);
  return { root, setData, getData };
}

// 읽기 전용 시트 뷰 (플레이 중 확인용)
function renderSheetView(inv) {
  const d = sheetDerive(inv.stats || {});
  const root = el('div', { class: 'sheet-view' });
  root.appendChild(el('div', { class: 'sheet-view-head' },
    el('strong', {}, inv.name),
    el('span', { class: 'muted' }, [inv.occupation, inv.age ? inv.age + '세' : '', inv.gender].filter(Boolean).join(' · '))));
  const sg = el('div', { class: 'stat-grid stat-grid-view' });
  for (const s of SHEET_STATS) {
    const v = inv.stats?.[s] ?? 0;
    sg.appendChild(el('div', { class: 'stat-cell' },
      el('div', { class: 'stat-name' }, SHEET_STAT_LABEL[s]),
      el('div', { class: 'stat-val' }, String(v)),
      el('div', { class: 'stat-halves' }, `${Math.floor(v / 2)} / ${Math.floor(v / 5)}`)));
  }
  sg.appendChild(el('div', { class: 'stat-cell stat-luck' },
    el('div', { class: 'stat-name' }, '행운'),
    el('div', { class: 'stat-val' }, String(inv.luck ?? 0)),
    el('div', { class: 'stat-halves' }, '')));
  root.appendChild(sg);
  root.appendChild(el('div', { class: 'derived-box' },
    [['체력', `${inv.hp ?? d.hpMax}/${inv.hpMax ?? d.hpMax}`], ['SAN', String(inv.san ?? d.sanStart)], ['MP', `${inv.mp ?? d.mpMax}/${inv.mpMax ?? d.mpMax}`], ['DB', inv.db || d.db], ['이동', String(inv.mov || d.mov)]]
      .map(([k, v]) => el('div', { class: 'derived-item' },
        el('span', { class: 'derived-k' }, k), el('span', { class: 'derived-v' }, v)))));
  const skills = inv.skills || {};
  const sl = el('div', { class: 'skill-grid skill-grid-view' });
  for (const name of Object.keys(skills).sort((a, b) => skills[b] - skills[a])) {
    sl.appendChild(el('div', { class: 'skill-row' },
      el('span', { class: 'skill-name' }, name),
      el('span', { class: 'skill-val' }, String(skills[name]))));
  }
  root.appendChild(el('div', { class: 'sheet-sec' }, el('h4', {}, '기능'), sl));
  if (inv.background) {
    root.appendChild(el('div', { class: 'sheet-sec' }, el('h4', {}, '배경'), el('p', { class: 'bg-text' }, inv.background)));
  }
  return root;
}
