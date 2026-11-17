// Interface d'édition des scènes
const $ = (s) => document.querySelector(s);
const INPUTS = [
  [0x0f, 'DisplayPort 1'], [0x10, 'DisplayPort 2'], [0x11, 'HDMI 1'], [0x12, 'HDMI 2'],
  [0x13, 'HDMI 3'], [0x1b, 'USB-C'], [0x03, 'DVI 1'], [0x01, 'VGA 1'],
];
// MODEL_PROFILES vient de src/profiles.js (chargé avant ce script)
const toHex = (v) => `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;
const profileOf = (m) => (m && MODEL_PROFILES[m.model]) || null;
const inputsFor = (m) => (profileOf(m) ? profileOf(m).inputs : INPUTS);
const inputName = (v, m) => (inputsFor(m).find(([c]) => c === v) || [, toHex(v)])[1];
const STATUS_TEXT = {
  conflict: ['Déjà utilisé par une autre application', 'bad'],
  duplicate: ['Déjà utilisé par une autre scène', 'bad'],
  invalid: ['Combinaison non supportée', 'bad'],
};

let state = null;      // état du process principal
let hw = { monitors: [], audio: [] };
let selId = null;
let draft = null;      // copie éditée de la scène sélectionnée
let capturing = false;

// ------------------------------------------------------------ utilitaires
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add('hidden'), err ? 6000 : 2500);
}
const prettyKeys = (acc) => (acc || '').replace(/Control/g, 'Ctrl').replace(/\+/g, ' + ');
const monName = (m) => state.monitorNames[m.hwId] || m.name || m.model;
const clone = (o) => JSON.parse(JSON.stringify(o));
const uid = () => Math.random().toString(36).slice(2, 10);

// ------------------------------------------------------------ liste
function renderList() {
  const ul = $('#scene-list');
  ul.innerHTML = '';
  for (const s of state.scenes) {
    const li = document.createElement('li');
    li.className = (s.id === selId ? 'sel ' : '') + (s.id === state.lastSceneId ? 'active' : '');
    li.title = s.id === state.lastSceneId ? 'Dernière scène appliquée' : '';
    const dot = document.createElement('span'); dot.className = 'dot';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = s.name || '(sans nom)';
    li.append(dot, nm);
    if (s.shortcut) {
      const k = document.createElement('span');
      k.className = 'kbd ' + (state.shortcutStatus[s.id] || '');
      k.textContent = prettyKeys(s.shortcut);
      li.append(k);
    }
    // réordonner par glisser-déposer
    li.draggable = true;
    li.ondragstart = (e) => { e.dataTransfer.setData('text/plain', s.id); e.dataTransfer.effectAllowed = 'move'; li.classList.add('dragging'); };
    li.ondragend = () => li.classList.remove('dragging');
    li.ondragover = (e) => {
      e.preventDefault();
      const after = e.offsetY > li.clientHeight / 2;
      li.classList.toggle('drop-before', !after); li.classList.toggle('drop-after', after);
    };
    li.ondragleave = () => li.classList.remove('drop-before', 'drop-after');
    li.ondrop = (e) => {
      e.preventDefault();
      const after = li.classList.contains('drop-after');
      li.classList.remove('drop-before', 'drop-after');
      moveScene(e.dataTransfer.getData('text/plain'), s.id, after);
    };
    li.onclick = () => select(s.id);
    li.ondblclick = () => applySaved(s.id);
    ul.append(li);
  }
}

async function moveScene(fromId, toId, after) {
  if (!fromId || fromId === toId) return;
  const scenes = state.scenes.slice();
  const from = scenes.findIndex((x) => x.id === fromId);
  if (from < 0) return;
  const [moved] = scenes.splice(from, 1);
  let to = scenes.findIndex((x) => x.id === toId);
  if (after) to += 1;
  scenes.splice(to, 0, moved);
  state = await window.api.save({ scenes });
  renderList();
}

function select(id) {
  if (capturing) stopCapture();
  selId = id;
  const s = state.scenes.find((x) => x.id === id);
  draft = s ? clone(s) : null;
  render();
}

// ------------------------------------------------------------ éditeur
function render() {
  renderList();
  $('#empty').classList.toggle('hidden', !!draft);
  $('#form').classList.toggle('hidden', !draft);
  $('#opt-autostart').checked = state.autostart;
  $('#opt-notify').checked = state.settings.notify;
  if (!draft) return;

  $('#f-name').value = draft.name || '';
  $('#f-shortcut').textContent = capturing ? 'Tape la combinaison… (Échap pour annuler)' : (prettyKeys(draft.shortcut) || 'Aucun — cliquer pour définir');
  $('#f-shortcut').classList.toggle('capturing', capturing);
  const saved = state.scenes.find((x) => x.id === draft.id);
  const st = $('#shortcut-status');
  // on n'affiche que les problèmes (raccourci pris, en double…) ou un changement non enregistré
  const status = saved && saved.shortcut === draft.shortcut ? STATUS_TEXT[state.shortcutStatus[draft.id]] : null;
  if (status) { st.textContent = status[0]; st.className = status[1]; }
  else { st.textContent = draft.shortcut && (!saved || saved.shortcut !== draft.shortcut) ? 'Enregistre pour activer' : ''; st.className = 'muted'; }

  renderLayout();
  renderMonitors();
  renderAudio();
}

function renderLayout() {
  const box = $('#layout');
  box.innerHTML = '';
  const mons = hw.monitors;
  if (!mons.length) { box.innerHTML = '<div class="empty" style="margin-top:55px">Détection des écrans…</div>'; return; }
  const minX = Math.min(...mons.map((m) => m.x)), minY = Math.min(...mons.map((m) => m.y));
  const maxX = Math.max(...mons.map((m) => m.x + m.width)), maxY = Math.max(...mons.map((m) => m.y + m.height));
  const W = box.clientWidth - 20, H = box.clientHeight - 20;
  const k = Math.min(W / (maxX - minX), H / (maxY - minY));
  const offX = 10 + (W - (maxX - minX) * k) / 2, offY = 10 + (H - (maxY - minY) * k) / 2;
  for (const m of mons) {
    const d = document.createElement('div');
    const setsPrimary = !!draft.primary && draft.primary.hwId === m.hwId;
    const inp = (draft.inputs || []).find((i) => i.hwId === m.hwId);
    d.className = 'mon' + (setsPrimary || inp ? ' changed' : '');
    Object.assign(d.style, {
      left: offX + (m.x - minX) * k + 'px', top: offY + (m.y - minY) * k + 'px',
      width: m.width * k - 4 + 'px', height: m.height * k - 4 + 'px',
    });
    const t = document.createElement('div'); t.className = 't'; t.textContent = monName(m);
    d.append(t);
    const tag = (txt, cls) => { const b = document.createElement('div'); b.className = cls; b.textContent = txt; d.append(b); };
    if (setsPrimary) tag('Écran principal', 'tag');
    if (inp) tag(`Source : ${inputName(inp.value, m)}`, 'tag');
    if (!setsPrimary && !inp) tag('inchangé', 's');
    box.append(d);
  }
}

function renderMonitors() {
  const tb = $('#monitor-rows');
  tb.innerHTML = '';
  for (const m of hw.monitors) {
    const tr = document.createElement('tr');

    // nom modifiable
    const c1 = document.createElement('td');
    const alias = document.createElement('input');
    alias.className = 'alias'; alias.value = monName(m); alias.title = m.hwId;
    alias.onchange = async () => {
      const names = { ...state.monitorNames, [m.hwId]: alias.value.trim() || undefined };
      state = await window.api.save({ monitorNames: names });
      renderLayout();
    };
    const sub = document.createElement('div'); sub.className = 'sub';
    sub.textContent = `${m.name || m.model} · ${m.device.replace('\\\\.\\', '')} · ${m.width}×${m.height} ${m.hz} Hz`;
    c1.append(alias, sub);

    // écran principal
    const c2 = document.createElement('td');
    const lab = document.createElement('label'); lab.className = 'radio';
    const r = document.createElement('input'); r.type = 'radio'; r.name = 'primary'; r.value = m.hwId;
    r.checked = !!draft.primary && draft.primary.hwId === m.hwId;
    r.onchange = () => { draft.primary = { hwId: m.hwId, device: m.device }; renderLayout(); };
    lab.append(r, document.createTextNode(m.primary ? ' (actuel)' : ''));
    c2.append(lab);

    // source d'entrée
    const c3 = document.createElement('td');
    const cell = document.createElement('div'); cell.className = 'input-cell';
    const sel = document.createElement('select');
    const cur = (draft.inputs || []).find((i) => i.hwId === m.hwId);
    if (!m.ddc) {
      sel.append(new Option('DDC/CI non disponible', '')); sel.disabled = true;
      if (cur) { sel.append(new Option(`${inputName(cur.value, m)} (enregistrée)`, cur.value)); sel.value = cur.value; sel.disabled = false; }
    } else if (profileOf(m)) {
      sel.append(new Option('Ne pas changer', ''));
      for (const [c, n] of profileOf(m).inputs) sel.append(new Option(`${n} (${toHex(c)})`, c));
      if (cur && !profileOf(m).inputs.some(([c]) => c === cur.value)) sel.append(new Option(`${toHex(cur.value)} (enregistrée)`, cur.value));
      sel.append(new Option('Autre (code hexa)…', 'custom'));
      sel.value = cur ? String(cur.value) : '';
      sel.title = `Codes adaptés à ce modèle (${m.model}) — ${profileOf(m).note}`;
    } else {
      sel.append(new Option('Ne pas changer', ''));
      const announced = new Set(m.ddcInputs || []);
      const values = new Set(INPUTS.map(([c]) => c));
      for (const [c, n] of INPUTS) sel.append(new Option(n + (announced.has(c) ? ' ✓' : ''), c));
      for (const c of announced) if (!values.has(c)) sel.append(new Option(inputName(c, m) + ' ✓', c));
      if (cur && !values.has(cur.value) && !announced.has(cur.value)) sel.append(new Option(inputName(cur.value, m), cur.value));
      sel.append(new Option('Autre (code hexa)…', 'custom'));
      sel.value = cur ? String(cur.value) : '';
      sel.title = '✓ = annoncée par l\'écran (la liste de l\'écran est souvent incomplète)';
    }
    const hex = document.createElement('input');
    hex.className = 'hex hidden'; hex.placeholder = '0x12';
    sel.onchange = () => {
      hex.classList.toggle('hidden', sel.value !== 'custom');
      if (sel.value === 'custom') { hex.focus(); return; }
      setInput(m, sel.value === '' ? null : Number(sel.value));
    };
    hex.onchange = () => {
      const v = parseInt(hex.value.replace(/^0x/i, ''), 16);
      if (Number.isFinite(v) && v > 0 && v < 256) setInput(m, v); else toast('Code invalide (ex. 0x12)', true);
    };
    cell.append(sel, hex);
    c3.append(cell);

    tr.append(c1, c2, c3);
    tb.append(tr);
  }
  document.querySelector('tfoot input[name=primary]').checked = !draft.primary;
}

function setInput(m, value) {
  draft.inputs = (draft.inputs || []).filter((i) => i.hwId !== m.hwId);
  if (value != null) draft.inputs.push({ hwId: m.hwId, device: m.device, value });
  renderLayout();
}

function renderAudio() {
  const sel = $('#f-audio');
  sel.innerHTML = '';
  sel.append(new Option('Ne pas changer', ''));
  for (const a of hw.audio) sel.append(new Option(a.name + (a.isDefault ? '  (actuelle)' : ''), a.id));
  if (draft.audio && !hw.audio.some((a) => a.id === draft.audio.id)) sel.append(new Option(`${draft.audio.name} (non branchée)`, draft.audio.id));
  sel.value = draft.audio ? draft.audio.id : '';
}

// ------------------------------------------------------------ capture du raccourci
function keyFromCode(e) {
  const c = e.code;
  let m;
  if ((m = c.match(/^Key([A-Z])$/))) return m[1];
  if ((m = c.match(/^Digit(\d)$/))) return m[1];
  if ((m = c.match(/^F(\d{1,2})$/))) return 'F' + m[1];
  if ((m = c.match(/^Numpad(\d)$/))) return 'num' + m[1];
  const map = {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Space: 'Space', Enter: 'Enter',
    Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown', NumpadAdd: 'numadd', NumpadSubtract: 'numsub',
    NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec', Pause: 'MediaPlayPause',
    ScrollLock: 'Scrolllock', PrintScreen: 'PrintScreen',
  };
  return map[c] || null;
}

async function startCapture() { capturing = true; await window.api.capture(true); render(); }
async function stopCapture() { capturing = false; state = await window.api.capture(false); render(); }

window.addEventListener('keydown', (e) => {
  if (!capturing) return;
  e.preventDefault(); e.stopPropagation();
  if (e.code === 'Escape') { stopCapture(); return; }
  const key = keyFromCode(e);
  if (!key) return;                                   // touche de modification seule
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  if (!mods.length && !/^F\d+$/.test(key)) { toast('Ajoute Ctrl, Alt, Maj ou Win (sauf pour les touches F1–F24)', true); return; }
  draft.shortcut = [...mods, key].join('+');
  stopCapture();
}, true);

// ------------------------------------------------------------ actions
async function saveDraft() {
  draft.name = $('#f-name').value.trim() || 'Sans nom';
  const aid = $('#f-audio').value;
  draft.audio = aid ? { id: aid, name: (hw.audio.find((a) => a.id === aid) || draft.audio || {}).name } : null;
  const scenes = state.scenes.map((s) => (s.id === draft.id ? clone(draft) : s));
  if (!scenes.some((s) => s.id === draft.id)) scenes.push(clone(draft));
  state = await window.api.save({ scenes });
  const st = state.shortcutStatus[draft.id];
  if (st && st !== 'ok') toast(`Scène enregistrée, mais raccourci inactif : ${STATUS_TEXT[st][0].toLowerCase()}`, true);
  else toast('Scène enregistrée');
  render();
}

async function applySaved(id) {
  try { await window.api.apply(id); toast('Scène appliquée'); }
  catch (e) { toast(e.message.replace(/^Error invoking remote method '\w+': (Error: )?/, ''), true); }
  state = await window.api.state();
  hw = await window.api.hardware().catch(() => hw);
  render();
}

$('#btn-new').onclick = () => {
  draft = { id: uid(), name: 'Nouvelle scène', shortcut: '', inputs: [], primary: null, audio: null };
  selId = draft.id;
  render();
  $('#f-name').select();
};
$('#btn-save').onclick = saveDraft;
$('#btn-apply').onclick = async () => { await saveDraft(); await applySaved(draft.id); };
$('#btn-delete').onclick = async () => {
  if (!confirm(`Supprimer la scène « ${draft.name} » ?`)) return;
  const scenes = state.scenes.filter((s) => s.id !== draft.id);
  state = await window.api.save({ scenes });
  select(null);
};
$('#f-shortcut').onclick = () => (capturing ? stopCapture() : startCapture());
$('#btn-clear-shortcut').onclick = () => { draft.shortcut = ''; render(); };
$('#f-name').oninput = (e) => { draft.name = e.target.value; };
$('#f-audio').onchange = (e) => {
  const a = hw.audio.find((x) => x.id === e.target.value);
  draft.audio = a ? { id: a.id, name: a.name } : null;
};
document.querySelector('tfoot input[name=primary]').onchange = () => { draft.primary = null; renderLayout(); };
$('#btn-refresh').onclick = async () => {
  $('#btn-refresh').disabled = true;
  try { hw = await window.api.hardware(); render(); } finally { $('#btn-refresh').disabled = false; }
};
$('#opt-autostart').onchange = async (e) => { state.autostart = await window.api.autostart(e.target.checked); render(); };
$('#opt-notify').onchange = async (e) => { state = await window.api.save({ settings: { notify: e.target.checked } }); };
window.addEventListener('resize', () => draft && renderLayout());
window.api.onState((s) => { state = s; render(); });

// ------------------------------------------------------------ init
(async () => {
  state = await window.api.state();
  selId = state.scenes[0] ? state.scenes[0].id : null;
  draft = selId ? clone(state.scenes[0]) : null;
  render();
  try { hw = await window.api.hardware(); } catch (e) { toast('Détection impossible : ' + e.message, true); }
  render();
})();
