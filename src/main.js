const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, Notification, shell, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { Native } = require('./native');
const { expectedRead } = require('./profiles');
const I18n = require('./i18n');
const t = I18n.t;

const ROOT = path.join(__dirname, '..');
// packaged app: code lives in app.asar, but PowerShell and Windows (.ico icon) need real files
// → native/ and assets/ are extracted to app.asar.unpacked (see "asarUnpack" in package.json)
const UNPACKED = ROOT.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked');
const native = new Native(path.join(UNPACKED, 'native'));
// fixed config folder (%APPDATA%\screen-switcher) whatever the productName: dev and installed builds share scenes
// SS_USER_DATA (dev): separate data folder → test instance independent from the installed app
app.setPath('userData', process.env.SS_USER_DATA || path.join(app.getPath('appData'), 'screen-switcher'));
const configPath = () => path.join(app.getPath('userData'), 'config.json');

let win = null;
let tray = null;
let config = { scenes: [], monitorNames: {}, settings: { notify: true }, lastSceneId: null };
let shortcutStatus = {};   // sceneId -> 'ok' | 'conflict' | 'invalid'
let hardware = null;       // last result of native.list()
let applying = false;

// ---------------------------------------------------------------- config
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    config = { ...config, ...c, settings: { ...config.settings, ...(c.settings || {}) } };
    return true;
  } catch { return false; }
}
function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
}
const uid = () => Math.random().toString(36).slice(2, 10);

// Default scenes built from the hardware detected on first launch
function seedScenes(hw) {
  const acers = hw.monitors.filter((m) => m.model.startsWith('ACR')).sort((a, b) => a.x - b.x);
  const pj = hw.monitors.find((m) => m.model.startsWith('BNQ'));
  const audio = (needle) => hw.audio.find((a) => a.name.includes(needle));
  const scenes = [];
  if (acers.length >= 2) {
    const [L, R] = acers;
    config.monitorNames[L.hwId] = t('seed.leftAcer');
    config.monitorNames[R.hwId] = t('seed.rightAcer');
    const inp = (m, v) => ({ hwId: m.hwId, device: m.device, value: v });
    // Acer ED270U P: non-standard codes — 0x11 = DisplayPort, 0x0F = HDMI 2 port (see MODEL_PROFILES)
    scenes.push({ id: uid(), name: 'PC', shortcut: 'Control+Alt+F1', inputs: [inp(L, 0x11), inp(R, 0x11)] });
    scenes.push({ id: uid(), name: 'Laptop', shortcut: 'Control+Alt+F2', inputs: [inp(L, 0x0f), inp(R, 0x0f)] });
  }
  if (pj && acers.length) {
    config.monitorNames[pj.hwId] = t('seed.benq');
    const pjDisplay = (enabled) => (pj.devicePath ? [{ devicePath: pj.devicePath, name: pj.name, enabled }] : []);
    const bureau = { id: uid(), name: t('seed.desk'), shortcut: 'Control+Alt+B', inputs: [], displays: pjDisplay(false),
      primary: { hwId: acers[0].hwId, device: acers[0].device }, audio: hw.audio.find((a) => a.isDefault && !a.name.includes('BenQ')) || audio('Haut-parleurs') || audio('Speakers') || null };
    const proj = { id: uid(), name: t('seed.projector'), shortcut: 'Control+Alt+P', inputs: [], displays: pjDisplay(true),
      primary: { hwId: pj.hwId, device: pj.device }, audio: audio('BenQ') || null };
    if (proj.audio) proj.audio = { id: proj.audio.id, name: proj.audio.name };
    if (bureau.audio) bureau.audio = { id: bureau.audio.id, name: bureau.audio.name };
    scenes.push(proj, bureau);
  }
  config.scenes = scenes;
}

// ---------------------------------------------------------------- scenes
// Displays are stored by hardware ID (hwId) and/or devicePath (\\?\DISPLAY#BNQ4D03#…).
// A disabled display has no \\.\DISPLAYn: the helper finds it by devicePath after enabling it.
function setHardware(hw) {
  hardware = hw;
  config.devicePaths = config.devicePaths || {};
  for (const m of hw.monitors || []) if (m.hwId && m.devicePath) config.devicePaths[m.hwId] = m.devicePath;
  return hw;
}
function resolveRef(ref) {
  if (!ref) return null;
  const mons = hardware ? hardware.monitors : [];
  const m = mons.find((x) => ref.hwId && x.hwId === ref.hwId) || mons.find((x) => ref.devicePath && x.devicePath === ref.devicePath)
    || (!ref.hwId && !ref.devicePath ? mons.find((x) => x.device === ref.device) : null);
  return {
    device: m ? m.device : ref.device || null,
    devicePath: ref.devicePath || (m && m.devicePath) || (config.devicePaths || {})[ref.hwId] || null,
  };
}

async function applyScene(id) {
  const scene = config.scenes.find((s) => s.id === id);
  if (!scene) throw new Error(t('main.sceneNotFound'));
  if (applying) return;
  applying = true;
  try {
    if (!hardware) setHardware(await native.list(false));
    // An input is skipped only if the monitor already reports it AND the last command the app
    // sent to this monitor was the same: right after a switch the Acer sometimes reports a stale
    // value, so reading alone is not enough.
    const lastInputs = config.lastInputs || {};
    const displayModes = config.displayModes || {};
    const targets = (scene.inputs || []).filter((i) => i.value != null);
    const displays = (scene.displays || []).filter((d) => d.devicePath && typeof d.enabled === 'boolean');
    const payload = {
      primary: resolveRef(scene.primary),
      audio: scene.audio ? scene.audio.id : null,
      // saved = exact path + modes stored when disabling (resolution, refresh rate, position)
      displays: displays.map((d) => ({ devicePath: d.devicePath, enabled: d.enabled, saved: d.enabled ? displayModes[d.devicePath] || null : null })),
      inputs: targets.map((i) => {
        const model = (i.hwId || '').split('\\')[1] || '';
        const trust = lastInputs[i.hwId] === undefined || lastInputs[i.hwId] === i.value;
        return { ...resolveRef(i), value: i.value, skipIfRead: trust ? expectedRead(model, i.value, config.inputProfiles) : null };
      }),
    };
    let res, applyError = null;
    try {
      res = await native.apply(payload);
      for (const i of targets) lastInputs[i.hwId] = i.value;
      config.lastInputs = lastInputs;
    } catch (e) {
      res = e.result;           // partial error: keep the stored modes anyway
      applyError = e;
    } finally {
      if (payload.primary || displays.length) setHardware(await native.list(false).catch(() => hardware));
    }
    if (res && res.savedModes) {
      for (const [p, blob] of Object.entries(res.savedModes)) if (blob) displayModes[p] = blob;
      config.displayModes = displayModes;
      saveConfig();
    }
    if (applyError) throw applyError;
    console.log('[apply]', scene.name, JSON.stringify(res || {}));
    config.lastSceneId = scene.id;
    saveConfig();
    refreshTray();
    notify(t('main.applied', { name: scene.name }), '');
    win?.webContents.send('state', publicState());
    win?.webContents.send('hardware', hardware);
  } catch (e) {
    notify(t('main.failed'), e.message, true);
    throw e;
  } finally {
    applying = false;
  }
}

function notify(title, body, force = false) {
  if (!force && !config.settings.notify) return;
  if (Notification.isSupported()) new Notification({ title, body, silent: true, icon: iconPath(64) }).show();
}

// ---------------------------------------------------------------- raccourcis
function registerShortcuts() {
  globalShortcut.unregisterAll();
  shortcutStatus = {};
  const seen = new Set();
  for (const s of config.scenes) {
    if (!s.shortcut) continue;
    if (seen.has(s.shortcut)) { shortcutStatus[s.id] = 'duplicate'; continue; }
    seen.add(s.shortcut);
    try {
      const ok = globalShortcut.register(s.shortcut, () => applyScene(s.id).catch(() => {}));
      shortcutStatus[s.id] = ok ? 'ok' : 'conflict';
    } catch {
      shortcutStatus[s.id] = 'invalid';
    }
  }
  console.log('[shortcuts]', config.scenes.filter((s) => s.shortcut).map((s) => `${s.name}=${s.shortcut}:${shortcutStatus[s.id]}`).join(' | '));
}

// ---------------------------------------------------------------- UI
const iconPath = (sz) => path.join(UNPACKED, 'assets', `icon-${sz}.png`);
const ICO = path.join(UNPACKED, 'assets', 'icon.ico');
const APP_ID = 'ScreenSwitcher.App';
const LOGIN_NAME = 'Screen Switcher';           // name of the registry "Run" entry
const OLD_LOGIN_NAME = 'local.screen-switcher'; // former name (= former AppUserModelID)

// Windows takes the icon (taskbar, notifications) from the shortcut carrying the same AppUserModelID.
// Without it, when run from source, electron.exe's icon shows. Created/updated on every launch.
function ensureStartMenuShortcut() {
  if (process.platform !== 'win32') return;
  const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Screen Switcher.lnk');
  const opts = {
    target: process.execPath, args: app.isPackaged ? '' : `"${ROOT}"`, cwd: app.isPackaged ? path.dirname(process.execPath) : ROOT,
    icon: ICO, iconIndex: 0, appUserModelId: APP_ID, description: t('main.shortcutDesc'),
  };
  try {
    const cur = fs.existsSync(lnk) ? shell.readShortcutLink(lnk) : null;
    const same = cur && cur.target === opts.target && cur.args === opts.args && cur.icon === opts.icon && cur.appUserModelId === APP_ID;
    if (!same) shell.writeShortcutLink(lnk, cur ? 'replace' : 'create', opts);
  } catch (e) {
    console.log('[shortcut]', e.message);
  }
}

function refreshTray() {
  if (!tray) return;
  const last = config.scenes.find((s) => s.id === config.lastSceneId);
  tray.setToolTip(`Screen Switcher${last ? ' — ' + last.name : ''}`);
  const sceneItems = config.scenes.map((s) => ({
    label: s.name + (s.shortcut ? `\t${s.shortcut.replace(/Control/g, 'Ctrl')}` : ''),
    type: 'radio',
    checked: s.id === config.lastSceneId,
    click: () => applyScene(s.id).catch(() => {}),
  }));
  tray.setContextMenu(Menu.buildFromTemplate([
    ...(sceneItems.length ? sceneItems : [{ label: t('tray.none'), enabled: false }]),
    { type: 'separator' },
    { label: t('tray.edit'), click: showWindow },
    { label: t('tray.quit'), click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

function showWindow() {
  if (win) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1240, height: 800, minWidth: 1180, minHeight: 600,
    title: 'Screen Switcher', icon: ICO, autoHideMenuBar: true, backgroundColor: '#1e1e1e',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  // Without this, the taskbar shows electron.exe's icon (when run from source)
  win.setAppDetails({
    appId: APP_ID, appIconPath: ICO, appIconIndex: 0, relaunchDisplayName: 'Screen Switcher',
    relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${ROOT}"`,
  });
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  win.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; });
}

function publicState() {
  return {
    scenes: config.scenes, monitorNames: config.monitorNames, settings: config.settings, devicePaths: config.devicePaths || {},
    lastSceneId: config.lastSceneId, shortcutStatus, inputProfiles: config.inputProfiles || {},
    lang: I18n.getLang(), systemLang: I18n.detect(app.getLocale()),
    autostart: isAutostart(),
  };
}

// Language: "language" setting (system / en / fr); "system" = Windows language (English if unsupported)
function applyLang() {
  const l = config.settings && config.settings.language;
  I18n.setLang(l && l !== 'system' ? l : I18n.detect(app.getLocale()));
}

// ---------------------------------------------------------------- IPC
ipcMain.handle('state', () => publicState());
ipcMain.handle('hardware', async () => setHardware(await native.list(true)));
ipcMain.handle('apply', (_e, id) => applyScene(id));
ipcMain.handle('save', (_e, patch) => {
  if (patch.scenes) config.scenes = patch.scenes;
  if (patch.monitorNames) config.monitorNames = patch.monitorNames;
  if (patch.settings) config.settings = { ...config.settings, ...patch.settings };
  if (patch.settings && 'language' in patch.settings) applyLang();
  if (config.lastSceneId && !config.scenes.some((s) => s.id === config.lastSceneId)) config.lastSceneId = null;
  saveConfig();
  registerShortcuts();
  refreshTray();
  return publicState();
});
// in development, electron.exe must receive the project path
const loginArgs = () => (app.isPackaged ? ['--hidden'] : [ROOT, '--hidden']);
// Autostart: value under HKCU\...\Run, managed directly
// (on Windows, Electron's getLoginItemSettings only finds an entry by AppUserModelID)
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const reg = (args) => execFileSync('reg', args, { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const loginCommand = () => [process.execPath, ...loginArgs()].map((a) => (a.startsWith('--') ? a : `"${a}"`)).join(' ');
function readRun(name) { try { return reg(['query', RUN_KEY, '/v', name]); } catch { return null; } }
const isAutostart = () => { const out = readRun(LOGIN_NAME); return !!out && out.includes(process.execPath); };
function setAutostart(on) {
  if (on) reg(['add', RUN_KEY, '/v', LOGIN_NAME, '/t', 'REG_SZ', '/d', loginCommand(), '/f']);
  else if (readRun(LOGIN_NAME)) reg(['delete', RUN_KEY, '/v', LOGIN_NAME, '/f']);
}
ipcMain.handle('autostart', (_e, on) => { setAutostart(!!on); return isAutostart(); });
// migrate the old entry (named after the old AppUserModelID)
function migrateAutostart() {
  try {
    if (readRun(OLD_LOGIN_NAME)) { reg(['delete', RUN_KEY, '/v', OLD_LOGIN_NAME, '/f']); setAutostart(true); }
  } catch (e) { console.log('[autostart]', e.message); }
}
// while capturing a shortcut, global shortcuts are disabled
ipcMain.handle('capture', (_e, on) => { on ? globalShortcut.unregisterAll() : registerShortcuts(); return publicState(); });

// ---------------------------------------------------------------- triggering a scene from outside
// Two forms, for an external launcher (programmable keypad, shortcut, script…):
//   electron.exe <project> --scene "PC"     ("Open" action)
//   screenswitcher://scene/PC               ("Website" action / link)
// If the app is already running, the new instance forwards its arguments and exits (second-instance).
const PROTOCOL = 'screenswitcher';
const normName = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

function sceneFromArgv(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scene' && argv[i + 1]) return argv[i + 1];
    if (a.startsWith('--scene=')) return a.slice(8);
    if (a.toLowerCase().startsWith(`${PROTOCOL}://`)) {
      const m = a.slice(PROTOCOL.length + 3).replace(/\/+$/, '').match(/^scene\/(.+)$/i);
      if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
    }
  }
  return null;
}

function applySceneByName(name) {
  const scene = config.scenes.find((s) => s.id === name) || config.scenes.find((s) => normName(s.name) === normName(name));
  if (!scene) { notify(t('main.sceneNotFound'), t('main.noScene', { name }), true); return; }
  applyScene(scene.id).catch(() => {});
}

function registerProtocol() {
  try {
    if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
    else app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [ROOT]);
  } catch (e) { console.log('[protocol]', e.message); }
}

ipcMain.handle('scene-command', (_e, name) => ({
  command: `"${process.execPath}" ${app.isPackaged ? '' : `"${ROOT}" `}--scene "${name}"`,
  url: `${PROTOCOL}://scene/${encodeURIComponent(name)}`,
}));
ipcMain.handle('copy', (_e, text) => { clipboard.writeText(String(text)); return true; });
// "Test" button: the last sent value changes, so the next scene must not skip this monitor
ipcMain.handle('test-input', async (_e, ref, value) => {
  await native.setInput(resolveRef(ref), value);
  config.lastInputs = { ...(config.lastInputs || {}), [ref.hwId]: value };
  saveConfig();
  return true;
});

// ---------------------------------------------------------------- input wizard
// sends a code, waits for the monitor to switch and returns the input read back (-1 if no answer)
ipcMain.handle('ddc-probe', async (_e, ref, value, waitMs = 2500) => {
  const r = await native.probe(resolveRef(ref), value, waitMs);
  config.lastInputs = { ...(config.lastInputs || {}), [ref.hwId]: value };
  saveConfig();
  return r;
});
// profile found by the wizard for a model (null = back to standard / built-in codes)
ipcMain.handle('save-input-profile', (_e, model, profile) => {
  const all = { ...(config.inputProfiles || {}) };
  if (profile) all[model] = profile; else delete all[model];
  config.inputProfiles = all;
  saveConfig();
  return publicState();
});
// Is the window on the tested display? (rectangle in physical pixels, like display positions)
const physRect = (r) => screen.dipToScreenRect(win, r);
const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
ipcMain.handle('window-on-monitor', (_e, mon) => !!win && overlap(physRect(win.getBounds()), mon));
// moves the window to a display other than the tested one
ipcMain.handle('window-move-away', (_e, mon) => {
  if (!win) return false;
  const target = screen.getAllDisplays().find((d) => !overlap(screen.dipToScreenRect(null, d.bounds), mon));
  if (!target) return false;
  if (win.isMaximized()) win.unmaximize();
  const wa = target.workArea, b = win.getBounds();
  const w = Math.min(b.width, wa.width), h = Math.min(b.height, wa.height);
  win.setBounds({ x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - h) / 2), width: w, height: h });
  return true;
});

// ---------------------------------------------------------------- startup
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const name = sceneFromArgv(argv);
    if (name) applySceneByName(name); else showWindow();
  });
  app.whenReady().then(async () => {
    // language: setting, else Windows language (French if fr-*), else English
    applyLang();
    app.setAppUserModelId(APP_ID);
    ensureStartMenuShortcut();
    migrateAutostart();
    registerProtocol();
    tray = new Tray(nativeImage.createFromPath(iconPath(32)));
    tray.on('click', showWindow);
    const hadConfig = loadConfig();
    applyLang();
    try {
      setHardware(await native.list(false));
      if (!hadConfig) { seedScenes(hardware); saveConfig(); }
    } catch (e) {
      notify('Screen Switcher', t('main.helperFail', { msg: e.message }), true);
    }
    registerShortcuts();
    refreshTray();
    const startScene = sceneFromArgv(process.argv);
    if (startScene) applySceneByName(startScene);
    else if (!process.argv.includes('--hidden')) showWindow();
  });
  app.on('window-all-closed', () => { /* stay in the notification area */ });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); native.stop(); });
}
