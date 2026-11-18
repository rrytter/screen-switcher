// Scene editor UI
const $ = (s) => document.querySelector(s);
// UI language: set by the main process (setting, or Windows language) at startup
const t = I18n.t;
const INPUTS = [
  [0x0f, 'DisplayPort 1'], [0x10, 'DisplayPort 2'], [0x11, 'HDMI 1'], [0x12, 'HDMI 2'],
  [0x13, 'HDMI 3'], [0x1b, 'USB-C'], [0x03, 'DVI 1'], [0x01, 'VGA 1'],
];
// MODEL_PROFILES comes from src/profiles.js (loaded before this script)
const toHex = (v) => `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;
// profile found by the wizard (state.inputProfiles), else built-in profile (src/profiles.js)
const profileOf = (m) => (m && profileFor(m.model, state && state.inputProfiles)) || null;
const inputsFor = (m) => (profileOf(m) ? profileOf(m).inputs : INPUTS);
const inputName = (v, m) => (inputsFor(m).find(([c]) => c === v) || [, toHex(v)])[1];
const STATUS_TEXT = {
  conflict: () => [t('status.conflict'), 'bad'],
  duplicate: () => [t('status.duplicate'), 'bad'],
  invalid: () => [t('status.invalid'), 'bad'],
};
const statusText = (st) => (STATUS_TEXT[st] ? STATUS_TEXT[st]() : null);

let state = null;      // main process state
let hw = { monitors: [], audio: [] };
let selId = null;
let draft = null;      // edited copy of the selected scene
let capturing = false;

// ------------------------------------------------------------ helpers
// static texts of index.html (data-i18n, data-i18n-title, data-i18n-placeholder)
function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
}
function toast(msg, err = false) {
  const el = $('#toast');
  el.textContent = msg; el.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toast.h); toast.h = setTimeout(() => el.classList.add('hidden'), err ? 6000 : 2500);
}
const prettyKeys = (acc) => (acc || '').replace(/Control/g, 'Ctrl').replace(/\+/g, ' + ');
const monName = (m) => (m.hwId && state.monitorNames[m.hwId]) || (m.devicePath && state.monitorNames[m.devicePath]) || m.name || m.model;
const clone = (o) => JSON.parse(JSON.stringify(o));
const uid = () => Math.random().toString(36).slice(2, 10);

// ------------------------------------------------------------ list
function renderList() {
  const ul = $('#scene-list');
  ul.innerHTML = '';
  for (const s of state.scenes) {
    const li = document.createElement('li');
    li.className = (s.id === selId ? 'sel ' : '') + (s.id === state.lastSceneId ? 'active' : '');
    const tile = document.createElement('span'); tile.className = 'tile';
    tile.innerHTML = SceneIcons.tileSvg(SceneIcons.lookOf(s), { size: 34 });
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = s.name || t('unnamed');
    li.append(tile, nm);
    if (s.shortcut) {
      const k = document.createElement('span');
      k.className = 'kbd ' + (state.shortcutStatus[s.id] || '');
      k.textContent = prettyKeys(s.shortcut).replace(/ \+ /g, '+');
      li.append(k);
    }
    // reorder by drag and drop
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

// ------------------------------------------------------------ editor
function render() {
  renderList();
  $('#empty').classList.toggle('hidden', !!draft);
  $('#form').classList.toggle('hidden', !draft);
  $('#opt-autostart').checked = state.autostart;
  $('#opt-notify').checked = state.settings.notify;
  if (!draft) return;

  $('#f-name').value = draft.name || '';
  renderLook();
  $('#f-shortcut').textContent = capturing ? t('shortcut.capturing') : (prettyKeys(draft.shortcut) || t('shortcut.none'));
  $('#f-shortcut').classList.toggle('capturing', capturing);
  const saved = state.scenes.find((x) => x.id === draft.id);
  const st = $('#shortcut-status');
  // only show problems (shortcut taken, duplicate…) or an unsaved change
  const status = saved && saved.shortcut === draft.shortcut ? statusText(state.shortcutStatus[draft.id]) : null;
  if (status) { st.textContent = status[0]; st.className = status[1]; }
  else { st.textContent = draft.shortcut && (!saved || saved.shortcut !== draft.shortcut) ? t('shortcut.saveToActivate') : ''; st.className = 'muted'; }

  renderLaunch(saved);
  renderLayout();
  renderMonitors();
  renderAudio();
}

// scene icon (also used by the Stream Deck plugin)
function fillSelect(sel, keys, prefix) {
  if (sel.options.length) return;
  sel.append(new Option(t('look.auto'), 'auto'));
  for (const k of keys) sel.append(new Option(t(`${prefix}.${k}`), k));
}
function renderLook() {
  const guess = SceneIcons.lookOf({ name: draft.name });
  fillSelect($('#f-icon'), Object.keys(SceneIcons.GLYPH_NAMES), 'glyph');
  fillSelect($('#f-color'), Object.keys(SceneIcons.COLOR_NAMES), 'color');
  $('#f-icon').options[0].text = t('look.autoWith', { name: t(`glyph.${guess.glyph}`) });
  $('#f-icon').value = draft.icon || 'auto';
  const autoColor = SceneIcons.lookOf({ name: draft.name, icon: draft.icon }).color;
  $('#f-color').options[0].text = t('look.autoWith', { name: t(`color.${autoColor}`) });
  $('#f-color').value = draft.color || 'auto';
  $('#f-tile').innerHTML = SceneIcons.tileSvg(SceneIcons.lookOf(draft), { size: 44 });
}

// link / command to trigger the scene from an external launcher (based on the saved name)
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
  toast(kind === 'url' ? t('copied.url') : t('copied.cmd'));
}

// Active displays + connected but disabled displays (no position nor \\.\DISPLAYn)
function allScreens() {
  const byPath = {};
  for (const [hwId, p] of Object.entries(state.devicePaths || {})) byPath[p] = hwId;
  const inactive = (hw.targets || []).filter((x) => !x.active)
    .map((x) => ({ inactive: true, devicePath: x.devicePath, name: x.name, hwId: byPath[x.devicePath] || null, model: (x.devicePath.split('#')[1] || '') }));
  return [...hw.monitors, ...inactive];
}
const sameScreen = (ref, m) => !!ref && ((ref.hwId && ref.hwId === m.hwId) || (ref.devicePath && ref.devicePath === m.devicePath));
const displayState = (m) => { const d = (draft.displays || []).find((x) => x.devicePath && x.devicePath === m.devicePath); return d ? d.enabled : undefined; };

function renderLayout() {
  const box = $('#layout');
  box.innerHTML = '';
  const active = hw.monitors;
  if (!active.length) {
    const e = document.createElement('div'); e.className = 'empty detecting'; e.textContent = t('layout.detecting');
    box.append(e); return;
  }
  // disabled displays are drawn dashed, to the right of the others
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
    const tt = document.createElement('div'); tt.className = 't'; tt.textContent = monName(m);
    d.append(tt);
    const tag = (txt, cls) => { const b = document.createElement('div'); b.className = cls; b.textContent = txt; d.append(b); };
    if (ds === false) tag(t('tag.disabled'), 'tag');
    else if (ds === true && m.inactive) tag(t('tag.enabled'), 'tag');
    else if (m.inactive) tag(t('tag.offUnchanged'), 's');
    if (setsPrimary) tag(t('tag.primary'), 'tag');
    if (inp) tag(t('tag.source', { name: inputName(inp.value, m) }), 'tag');
    if (!off && !setsPrimary && !inp && ds === undefined) tag(t('tag.unchanged'), 's');
    box.append(d);
  }
}

function setDisplay(m, value) {
  draft.displays = (draft.displays || []).filter((d) => d.devicePath !== m.devicePath);
  if (value !== '') draft.displays.push({ devicePath: m.devicePath, name: monName(m), enabled: value === 'on' });
  // a disabled display cannot be primary
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

    // editable name (stored by hwId and by devicePath, to find it again while disabled)
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
    sub.textContent = m.inactive ? t('mon.offNow', { name: m.name || m.model })
      : `${m.name || m.model} · ${m.device.replace('\\\\.\\', '')} · ${m.width}×${m.height} ${m.hz} Hz`;
    c1.append(alias, sub);

    // state: enabled / disabled
    const cD = document.createElement('td');
    const dsel = document.createElement('select');
    dsel.append(new Option(t('noChange'), ''), new Option(t('tag.enabled'), 'on'), new Option(t('tag.disabled'), 'off'));
    dsel.value = ds === true ? 'on' : ds === false ? 'off' : '';
    if (!m.devicePath) { dsel.disabled = true; dsel.title = t('disp.noId'); }
    dsel.onchange = () => setDisplay(m, dsel.value);
    cD.append(dsel);

    // primary display
    const c2 = document.createElement('td');
    const lab = document.createElement('label'); lab.className = 'radio';
    const r = document.createElement('input'); r.type = 'radio'; r.name = 'primary'; r.value = m.devicePath || m.hwId;
    r.checked = sameScreen(draft.primary, m);
    r.disabled = willBeOff;
    r.title = willBeOff ? t('primary.enableFirst') : '';
    r.onchange = () => { draft.primary = { hwId: m.hwId || undefined, device: m.device || undefined, devicePath: m.devicePath || undefined }; renderLayout(); };
    lab.append(r, document.createTextNode(m.primary ? t('primary.current') : ''));
    c2.append(lab);

    // input source
    const c3 = document.createElement('td');
    const cell = document.createElement('div'); cell.className = 'input-cell';
    const sel = document.createElement('select');
    const cur = (draft.inputs || []).find((i) => i.hwId && i.hwId === m.hwId);
    if (m.inactive) {
      sel.append(new Option(t('input.displayOff'), '')); sel.disabled = true;
    } else if (!m.ddc && !profileOf(m) && !cur) {
      // no DDC answer during detection (monitor on another input, DDC/CI off in its menu, dock not passing it through…)
      sel.append(new Option(t('input.noDdc'), ''));
      for (const [c, n] of INPUTS) sel.append(new Option(n, c));
      sel.append(new Option(t('input.custom'), 'custom'));
      sel.value = '';
      sel.title = t('input.noDdc.title');
    } else if (profileOf(m)) {
      sel.append(new Option(t('noChange'), ''));
      for (const [c, n] of profileOf(m).inputs) sel.append(new Option(`${n} (${toHex(c)})`, c));
      if (cur && !profileOf(m).inputs.some(([c]) => c === cur.value)) sel.append(new Option(t('input.saved', { code: toHex(cur.value) }), cur.value));
      sel.append(new Option(t('input.custom'), 'custom'));
      sel.value = cur ? String(cur.value) : '';
      sel.title = t('input.profile.title', { model: m.model, note: I18n.pick(profileOf(m).note) || '' });
    } else {
      sel.append(new Option(t('noChange'), ''));
      const announced = new Set(m.ddcInputs || []);
      const values = new Set(INPUTS.map(([c]) => c));
      for (const [c, n] of INPUTS) sel.append(new Option(n + (announced.has(c) ? ' ✓' : ''), c));
      for (const c of announced) if (!values.has(c)) sel.append(new Option(inputName(c, m) + ' ✓', c));
      if (cur && !values.has(cur.value) && !announced.has(cur.value)) sel.append(new Option(inputName(cur.value, m), cur.value));
      sel.append(new Option(t('input.custom'), 'custom'));
      sel.value = cur ? String(cur.value) : '';
      sel.title = t('input.announced.title');
    }
    const hex = document.createElement('input');
    hex.className = 'hex hidden'; hex.placeholder = '0x12';
    // "Test": sends the code right away, to find a monitor's right codes
    const test = document.createElement('button');
    test.className = 'btn ghost small'; test.innerHTML = uiIcon('zap');
    test.append(t('btn.test'));
    test.title = t('btn.test.title');
    const refreshTest = () => { test.disabled = !!m.inactive || !(draft.inputs || []).some((i) => i.hwId === m.hwId); };
    test.onclick = async () => {
      const i = (draft.inputs || []).find((x) => x.hwId === m.hwId);
      if (!i) return;
      test.disabled = true;
      try { await window.api.testInput({ hwId: m.hwId, device: m.device, devicePath: m.devicePath }, i.value); toast(t('test.sent', { code: toHex(i.value), name: monName(m) })); }
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
      if (Number.isFinite(v) && v > 0 && v < 256) { setInput(m, v); test.disabled = false; } else toast(t('input.invalid'), true);
    };
    refreshTest();
    // wizard: checks the standard codes / searches this model's codes
    const wiz = document.createElement('button');
    wiz.className = 'btn ghost small icon-only'; wiz.innerHTML = uiIcon('wand');
    wiz.title = t('btn.wizard.title');
    wiz.disabled = !!m.inactive;
    wiz.onclick = () => Wizard.open(m);
    cell.append(sel, hex, test, wiz);
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
  sel.append(new Option(t('noChange'), ''));
  for (const a of hw.audio) sel.append(new Option(a.name + (a.isDefault ? t('audio.current') : ''), a.id));
  if (draft.audio && !hw.audio.some((a) => a.id === draft.audio.id)) sel.append(new Option(t('audio.unplugged', { name: draft.audio.name }), draft.audio.id));
  sel.value = draft.audio ? draft.audio.id : '';
}

// ------------------------------------------------------------ shortcut capture
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
  if (!key) return;                                   // modifier key alone
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  if (!mods.length && !/^F\d+$/.test(key)) { toast(t('shortcut.needMod'), true); return; }
  draft.shortcut = [...mods, key].join('+');
  stopCapture();
}, true);

// ------------------------------------------------------------ actions
async function saveDraft() {
  draft.name = $('#f-name').value.trim() || t('untitled');
  const aid = $('#f-audio').value;
  draft.audio = aid ? { id: aid, name: (hw.audio.find((a) => a.id === aid) || draft.audio || {}).name } : null;
  const scenes = state.scenes.map((s) => (s.id === draft.id ? clone(draft) : s));
  if (!scenes.some((s) => s.id === draft.id)) scenes.push(clone(draft));
  state = await window.api.save({ scenes });
  const st = state.shortcutStatus[draft.id];
  if (st && st !== 'ok') toast(t('saved.inactive', { reason: statusText(st)[0].toLowerCase() }), true);
  else toast(t('saved'));
  render();
}

async function applySaved(id) {
  try { await window.api.apply(id); toast(t('applied')); }
  catch (e) { toast(e.message.replace(/^Error invoking remote method '\w+': (Error: )?/, ''), true); }
  state = await window.api.state();
  hw = await window.api.hardware().catch(() => hw);
  render();
}

$('#btn-new').onclick = () => {
  draft = { id: uid(), name: t('new.scene'), shortcut: '', inputs: [], primary: null, audio: null, displays: [] };
  selId = draft.id;
  render();
  $('#f-name').select();
};
$('#btn-save').onclick = saveDraft;
$('#btn-copy-url').onclick = () => copyLaunch('url');
$('#btn-copy-cmd').onclick = () => copyLaunch('cmd');
$('#btn-apply').onclick = async () => { await saveDraft(); await applySaved(draft.id); };
$('#btn-delete').onclick = async () => {
  if (!confirm(t('confirm.delete', { name: draft.name }))) return;
  const scenes = state.scenes.filter((s) => s.id !== draft.id);
  state = await window.api.save({ scenes });
  select(null);
};
$('#f-shortcut').onclick = () => (capturing ? stopCapture() : startCapture());
$('#btn-clear-shortcut').onclick = () => { draft.shortcut = ''; render(); };
$('#f-name').oninput = (e) => { draft.name = e.target.value; renderLook(); };
$('#f-icon').onchange = (e) => { draft.icon = e.target.value === 'auto' ? undefined : e.target.value; renderLook(); };
$('#f-color').onchange = (e) => { draft.color = e.target.value === 'auto' ? undefined : e.target.value; renderLook(); };
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
// settings: modal window (language, autostart, notifications)
function openSettings() {
  const sel = $('#opt-lang');
  sel.innerHTML = '';
  sel.append(new Option(t('settings.system', { name: I18n.LANG_NAMES[state.systemLang] }), 'system'));
  for (const [k, v] of Object.entries(I18n.LANG_NAMES)) sel.append(new Option(v, k));
  sel.value = state.settings.language || 'system';
  $('#settings').classList.remove('hidden');
}
const closeSettings = () => $('#settings').classList.add('hidden');
$('#btn-settings').onclick = openSettings;
$('#settings-close').onclick = closeSettings;
$('#settings').onclick = (e) => { if (e.target.id === 'settings') closeSettings(); };
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#settings').classList.contains('hidden')) closeSettings(); });
// language change: the main process switches (menu, notifications), the UI reloads
$('#opt-lang').onchange = async (e) => {
  state = await window.api.save({ settings: { language: e.target.value } });
  try { sessionStorage.setItem('reopenSettings', '1'); } catch { /* no storage: the window stays closed */ }
  location.reload();
};
window.addEventListener('resize', () => draft && renderLayout());
window.api.onState((s) => { state = s; render(); });
// quick detection sent after each scene (without the costly DDC info): keep the DDC info we had
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
  I18n.setLang(state.lang);
  document.documentElement.lang = state.lang;
  applyI18n();     // before the icons: textContent replaces the content
  applyUiIcons();
  let reopen = false;
  try { reopen = sessionStorage.getItem('reopenSettings') === '1'; sessionStorage.removeItem('reopenSettings'); } catch { /* ignored */ }
  if (reopen) openSettings();
  selId = state.scenes[0] ? state.scenes[0].id : null;
  draft = selId ? clone(state.scenes[0]) : null;
  render();
  try { hw = await window.api.hardware(); } catch (e) { toast(t('detect.failed', { msg: e.message }), true); }
  render();
})();
