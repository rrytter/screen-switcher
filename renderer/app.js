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
const monName = (m) => (m.hwId && state.monitorNames[m.hwId]) || (m.devicePath && state.monitorNames[m.devicePath]) || m.name || m.model;
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

  renderLaunch(saved);
  renderLayout();
  renderMonitors();
  renderAudio();
}

// lien / commande pour lancer la scène depuis le Stream Deck (basés sur le nom enregistré)
async function renderLaunch(saved) {
  const show = !!saved;
  document.querySelector('.launch').classList.toggle('hidden', !show);
  if (!show) return;
  const { url } = await window.api.sceneCommand(saved.name);
  $('#scene-url').textContent = url;
}
async function copyLaunch(kind) {
  const saved = state.scenes.find((x) => x.id === draft.id);
  if (!saved) return;
  const r = await window.api.sceneCommand(saved.name);
  await window.api.copy(kind === 'url' ? r.url : r.command);
  toast(kind === 'url' ? 'Lien copié' : 'Commande copiée');
}

// Écrans actifs + écrans branchés mais désactivés (sans position ni \\.\DISPLAYn)
function allScreens() {
  const byPath = {};
  for (const [hwId, p] of Object.entries(state.devicePaths || {})) byPath[p] = hwId;
  const inactive = (hw.targets || []).filter((t) => !t.active)
    .map((t) => ({ inactive: true, devicePath: t.devicePath, name: t.name, hwId: byPath[t.devicePath] || null, model: (t.devicePath.split('#')[1] || '') }));
  return [...hw.monitors, ...inactive];
}
const sameScreen = (ref, m) => !!ref && ((ref.hwId && ref.hwId === m.hwId) || (ref.devicePath && ref.devicePath === m.devicePath));
const displayState = (m) => { const d = (draft.displays || []).find((x) => x.devicePath && x.devicePath === m.devicePath); return d ? d.enabled : undefined; };

function renderLayout() {
  const box = $('#layout');
  box.innerHTML = '';
  const active = hw.monitors;
  if (!active.length) { box.innerHTML = '<div class="empty" style="margin-top:55px">Détection des écrans…</div>'; return; }
  // les écrans désactivés sont dessinés en pointillés à droite des autres
  let maxRight = Math.max(...active.map((m) => m.x + m.width));
  const minY0 = Math.min(...active.map((m) => m.y));
  const boxes = active.map((m) => ({ m, x: m.x, y: m.y, w: m.width, h: m.height }));
  for (const m of allScreens().filter((s) => s.inactive)) { boxes.push({ m, x: maxRight + 200, y: minY0, w: 1920, h: 1080 }); maxRight += 2120; }
  const minX = Math.min(...boxes.map((b) => b.x)), minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w)), maxY = Math.max(...boxes.map((b) => b.y + b.h));
  const W = box.clientWidth - 20, H = box.clientHeight - 20;
  const k = Math.min(W / (maxX - minX), H / (maxY - minY));
  const offX = 10 + (W - (maxX - minX) * k) / 2, offY = 10 + (H - (maxY - minY) * k) / 2;
  for (const { m, x, y, w, h } of boxes) {
    const d = document.createElement('div');
    const ds = displayState(m);
    const off = m.inactive ? ds !== true : ds === false;
    const setsPrimary = !off && sameScreen(draft.primary, m);
    const inp = off ? null : (draft.inputs || []).find((i) => i.hwId && i.hwId === m.hwId);
    d.className = 'mon' + (off ? ' off' : '') + (setsPrimary || inp || ds !== undefined ? ' changed' : '');
    Object.assign(d.style, { left: offX + (x - minX) * k + 'px', top: offY + (y - minY) * k + 'px', width: w * k - 4 + 'px', height: h * k - 4 + 'px' });
    const t = document.createElement('div'); t.className = 't'; t.textContent = monName(m);
    d.append(t);
    const tag = (txt, cls) => { const b = document.createElement('div'); b.className = cls; b.textContent = txt; d.append(b); };
    if (ds === false) tag('Désactivé', 'tag');
    else if (ds === true && m.inactive) tag('Activé', 'tag');
    else if (m.inactive) tag('désactivé (inchangé)', 's');
    if (setsPrimary) tag('Écran principal', 'tag');
    if (inp) tag(`Source : ${inputName(inp.value, m)}`, 'tag');
    if (!off && !setsPrimary && !inp && ds === undefined) tag('inchangé', 's');
    box.append(d);
  }
}

function setDisplay(m, value) {
  draft.displays = (draft.displays || []).filter((d) => d.devicePath !== m.devicePath);
  if (value !== '') draft.displays.push({ devicePath: m.devicePath, name: monName(m), enabled: value === 'on' });
  // un écran désactivé ne peut pas être principal
  if (value === 'off' && sameScreen(draft.primary, m)) draft.primary = null;
  renderLayout(); renderMonitors();
}

function renderMonitors() {
  const tb = $('#monitor-rows');
  tb.innerHTML = '';
  for (const m of allScreens()) {
    const tr = document.createElement('tr');
    const ds = displayState(m);
    const willBeOff = m.inactive ? ds !== true : ds === false;

    // nom modifiable (mémorisé par hwId et par devicePath, pour le retrouver écran désactivé)
    const c1 = document.createElement('td');
    const alias = document.createElement('input');
    alias.className = 'alias'; alias.value = monName(m); alias.title = m.devicePath || m.hwId;
    alias.onchange = async () => {
      const v = alias.value.trim() || undefined;
      const names = { ...state.monitorNames };
      if (m.hwId) names[m.hwId] = v;
      if (m.devicePath) names[m.devicePath] = v;
      state = await window.api.save({ monitorNames: names });
      renderLayout();
    };
    const sub = document.createElement('div'); sub.className = 'sub';
    sub.textContent = m.inactive ? `${m.name || m.model} · désactivé actuellement`
      : `${m.name || m.model} · ${m.device.replace('\\\\.\\', '')} · ${m.width}×${m.height} ${m.hz} Hz`;
    c1.append(alias, sub);

    // affichage : activé / désactivé
    const cD = document.createElement('td');
    const dsel = document.createElement('select');
    dsel.append(new Option('Ne pas changer', ''), new Option('Activé', 'on'), new Option('Désactivé', 'off'));
    dsel.value = ds === true ? 'on' : ds === false ? 'off' : '';
    if (!m.devicePath) { dsel.disabled = true; dsel.title = 'Identifiant d\'écran introuvable'; }
    dsel.onchange = () => setDisplay(m, dsel.value);
    cD.append(dsel);

    // écran principal
    const c2 = document.createElement('td');
    const lab = document.createElement('label'); lab.className = 'radio';
    const r = document.createElement('input'); r.type = 'radio'; r.name = 'primary'; r.value = m.devicePath || m.hwId;
    r.checked = sameScreen(draft.primary, m);
    r.disabled = willBeOff;
    r.title = willBeOff ? 'Active l\'écran pour pouvoir le rendre principal' : '';
    r.onchange = () => { draft.primary = { hwId: m.hwId || undefined, device: m.device || undefined, devicePath: m.devicePath || undefined }; renderLayout(); };
    lab.append(r, document.createTextNode(m.primary ? ' (actuel)' : ''));
    c2.append(lab);

    // source d'entrée
    const c3 = document.createElement('td');
    const cell = document.createElement('div'); cell.className = 'input-cell';
    const sel = document.createElement('select');
    const cur = (draft.inputs || []).find((i) => i.hwId && i.hwId === m.hwId);
    if (m.inactive) {
      sel.append(new Option('Écran désactivé', '')); sel.disabled = true;
    } else if (!m.ddc && !profileOf(m) && !cur) {
      // aucun écho DDC à la détection (écran sur une autre source, DDC/CI coupé dans son menu, dock qui ne le transmet pas…)
      sel.append(new Option('DDC/CI non détecté', ''));
      for (const [c, n] of INPUTS) sel.append(new Option(n, c));
      sel.append(new Option('Autre (code hexa)…', 'custom'));
      sel.value = '';
      sel.title = 'L\'écran n\'a pas répondu à la détection. Active DDC/CI dans son menu, puis « Actualiser la détection » ; tu peux quand même essayer un code avec « Tester ».';
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
    // « Tester » : envoie le code tout de suite pour trouver les bons codes d'un écran
    const test = document.createElement('button');
    test.className = 'btn ghost small'; test.textContent = 'Tester';
    test.title = 'Envoie ce code à l\'écran maintenant (pour vérifier quelle source il sélectionne)';
    const refreshTest = () => { test.disabled = !!m.inactive || !(draft.inputs || []).some((i) => i.hwId === m.hwId); };
    test.onclick = async () => {
      const i = (draft.inputs || []).find((x) => x.hwId === m.hwId);
      if (!i) return;
      test.disabled = true;
      try { await window.api.testInput({ hwId: m.hwId, device: m.device, devicePath: m.devicePath }, i.value); toast(`${toHex(i.value)} envoyé à ${monName(m)}`); }
      catch (e) { toast(e.message.replace(/^Error invoking remote method '[\w-]+': (Error: )?/, ''), true); }
      finally { test.disabled = false; }
    };
    sel.onchange = () => {
      hex.classList.toggle('hidden', sel.value !== 'custom');
      if (sel.value === 'custom') { hex.focus(); return; }
      setInput(m, sel.value === '' ? null : Number(sel.value));
      test.disabled = sel.value === '';
    };
    hex.onchange = () => {
      const v = parseInt(hex.value.replace(/^0x/i, ''), 16);
      if (Number.isFinite(v) && v > 0 && v < 256) { setInput(m, v); test.disabled = false; } else toast('Code invalide (ex. 0x12)', true);
    };
    refreshTest();
    cell.append(sel, hex, test);
    c3.append(cell);

    tr.append(c1, cD, c2, c3);
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
  draft = { id: uid(), name: 'Nouvelle scène', shortcut: '', inputs: [], primary: null, audio: null, displays: [] };
  selId = draft.id;
  render();
  $('#f-name').select();
};
$('#btn-save').onclick = saveDraft;
$('#btn-copy-url').onclick = () => copyLaunch('url');
$('#btn-copy-cmd').onclick = () => copyLaunch('cmd');
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
// détection rapide envoyée après chaque scène (sans les infos DDC, coûteuses) : on garde celles qu'on avait
window.api.onHardware((h) => {
  if (!h) return;
  const prev = Object.fromEntries(hw.monitors.map((m) => [m.hwId, m]));
  const keep = (m) => (prev[m.hwId] ? { ...m, ddc: prev[m.hwId].ddc, ddcInputs: prev[m.hwId].ddcInputs, ddcCaps: prev[m.hwId].ddcCaps } : m);
  hw = { ...h, monitors: h.monitors.map(keep) };
  const missingDdc = h.monitors.some((m) => !prev[m.hwId]);
  render();
  if (missingDdc) window.api.hardware().then((full) => { hw = full; render(); }).catch(() => {});
});

// ------------------------------------------------------------ init
(async () => {
  state = await window.api.state();
  selId = state.scenes[0] ? state.scenes[0].id : null;
  draft = selId ? clone(state.scenes[0]) : null;
  render();
  try { hw = await window.api.hardware(); } catch (e) { toast('Détection impossible : ' + e.message, true); }
  render();
})();
