const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { Native } = require('./native');
const { expectedRead } = require('./profiles');

const ROOT = path.join(__dirname, '..');
const native = new Native(path.join(ROOT, 'native'));
const configPath = () => path.join(app.getPath('userData'), 'config.json');

let win = null;
let tray = null;
let config = { scenes: [], monitorNames: {}, settings: { notify: true }, lastSceneId: null };
let shortcutStatus = {};   // sceneId -> 'ok' | 'conflict' | 'invalid'
let hardware = null;       // dernier résultat de native.list()
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

// Scènes par défaut construites à partir du matériel détecté au 1er lancement
function seedScenes(hw) {
  const acers = hw.monitors.filter((m) => m.model.startsWith('ACR')).sort((a, b) => a.x - b.x);
  const pj = hw.monitors.find((m) => m.model.startsWith('BNQ'));
  const audio = (needle) => hw.audio.find((a) => a.name.includes(needle));
  const scenes = [];
  if (acers.length >= 2) {
    const [L, R] = acers;
    config.monitorNames[L.hwId] = 'Acer gauche';
    config.monitorNames[R.hwId] = 'Acer droit';
    const inp = (m, v) => ({ hwId: m.hwId, device: m.device, value: v });
    // Acer ED270U P : codes non standard — 0x11 = DisplayPort, 0x0F = port HDMI 2 (voir MODEL_PROFILES)
    scenes.push({ id: uid(), name: 'PC', shortcut: 'Control+Alt+F1', inputs: [inp(L, 0x11), inp(R, 0x11)] });
    scenes.push({ id: uid(), name: 'Laptop', shortcut: 'Control+Alt+F2', inputs: [inp(L, 0x0f), inp(R, 0x0f)] });
  }
  if (pj && acers.length) {
    config.monitorNames[pj.hwId] = 'Projecteur BenQ';
    const bureau = { id: uid(), name: 'Bureau', shortcut: 'Control+Alt+B', inputs: [],
      primary: { hwId: acers[0].hwId, device: acers[0].device }, audio: hw.audio.find((a) => a.isDefault && !a.name.includes('BenQ')) || audio('Haut-parleurs') || null };
    const proj = { id: uid(), name: 'Projecteur', shortcut: 'Control+Alt+P', inputs: [],
      primary: { hwId: pj.hwId, device: pj.device }, audio: audio('BenQ') || null };
    if (proj.audio) proj.audio = { id: proj.audio.id, name: proj.audio.name };
    if (bureau.audio) bureau.audio = { id: bureau.audio.id, name: bureau.audio.name };
    scenes.push(proj, bureau);
  }
  config.scenes = scenes;
}

// ---------------------------------------------------------------- scènes
// Les écrans sont mémorisés par ID matériel ; on retrouve leur \\.\DISPLAYn actuel
function resolveDevice(ref) {
  if (!ref) return null;
  const mons = hardware ? hardware.monitors : [];
  const m = mons.find((x) => x.hwId === ref.hwId) || mons.find((x) => x.device === ref.device);
  return m ? m.device : ref.device;
}

async function applyScene(id) {
  const scene = config.scenes.find((s) => s.id === id);
  if (!scene) throw new Error('Scène introuvable');
  if (applying) return;
  applying = true;
  try {
    if (!hardware) hardware = await native.list(false);
    // On ne saute une source que si l'écran annonce déjà la bonne ET que la dernière commande
    // envoyée par l'app à cet écran était la même : juste après une bascule, l'Acer annonce
    // parfois une valeur périmée, donc la lecture seule ne suffit pas.
    const lastInputs = config.lastInputs || {};
    const targets = (scene.inputs || []).filter((i) => i.value != null);
    const payload = {
      primary: resolveDevice(scene.primary),
      audio: scene.audio ? scene.audio.id : null,
      inputs: targets.map((i) => {
        const model = (i.hwId || '').split('\\')[1] || '';
        const trust = lastInputs[i.hwId] === undefined || lastInputs[i.hwId] === i.value;
        return { device: resolveDevice(i), value: i.value, skipIfRead: trust ? expectedRead(model, i.value) : null };
      }),
    };
    let res;
    try {
      res = await native.apply(payload);
      for (const i of targets) lastInputs[i.hwId] = i.value;
      config.lastInputs = lastInputs;
    } finally {
      if (payload.primary) hardware = await native.list(false).catch(() => hardware);
    }
    console.log('[apply]', scene.name, JSON.stringify(res || {}));
    config.lastSceneId = scene.id;
    saveConfig();
    refreshTray();
    notify(`Scène « ${scene.name} »`, '');
    win?.webContents.send('state', publicState());
  } catch (e) {
    notify('Échec de la scène', e.message, true);
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
const iconPath = (sz) => path.join(ROOT, 'assets', `icon-${sz}.png`);
const ICO = path.join(ROOT, 'assets', 'icon.ico');
const APP_ID = 'ScreenSwitcher.App';
const LOGIN_NAME = 'Screen Switcher';           // nom de l'entrée « Run » du registre
const OLD_LOGIN_NAME = 'local.screen-switcher'; // ancien nom (= ancien AppUserModelID)

// Windows prend l'icône (barre des tâches, notifications) du raccourci qui porte le même AppUserModelID.
// Sans lui, lancé depuis le code source, on voit l'icône d'electron.exe. Créé/mis à jour à chaque lancement.
function ensureStartMenuShortcut() {
  if (process.platform !== 'win32') return;
  const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Screen Switcher.lnk');
  const opts = {
    target: process.execPath, args: app.isPackaged ? '' : `"${ROOT}"`, cwd: ROOT,
    icon: ICO, iconIndex: 0, appUserModelId: APP_ID, description: 'Scènes d\'affichage et raccourcis',
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
    ...(sceneItems.length ? sceneItems : [{ label: 'Aucune scène', enabled: false }]),
    { type: 'separator' },
    { label: 'Modifier les scènes…', click: showWindow },
    { label: 'Quitter', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

function showWindow() {
  if (win) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1080, height: 720, minWidth: 820, minHeight: 560,
    title: 'Screen Switcher', icon: ICO, autoHideMenuBar: true, backgroundColor: '#0f1115',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  // Sans ça, la barre des tâches affiche l'icône d'electron.exe (lancement depuis le code source)
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
    scenes: config.scenes, monitorNames: config.monitorNames, settings: config.settings,
    lastSceneId: config.lastSceneId, shortcutStatus,
    autostart: isAutostart(),
  };
}

// ---------------------------------------------------------------- IPC
ipcMain.handle('state', () => publicState());
ipcMain.handle('hardware', async () => { hardware = await native.list(true); return hardware; });
ipcMain.handle('apply', (_e, id) => applyScene(id));
ipcMain.handle('save', (_e, patch) => {
  if (patch.scenes) config.scenes = patch.scenes;
  if (patch.monitorNames) config.monitorNames = patch.monitorNames;
  if (patch.settings) config.settings = { ...config.settings, ...patch.settings };
  if (config.lastSceneId && !config.scenes.some((s) => s.id === config.lastSceneId)) config.lastSceneId = null;
  saveConfig();
  registerShortcuts();
  refreshTray();
  return publicState();
});
// en mode développement, electron.exe doit recevoir le chemin du projet
const loginArgs = () => (app.isPackaged ? ['--hidden'] : [ROOT, '--hidden']);
// Démarrage automatique : valeur dans HKCU\...\Run, gérée directement
// (sous Windows, getLoginItemSettings d'Electron ne retrouve une entrée que par l'AppUserModelID)
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
// migration de l'ancienne entrée (nommée d'après l'ancien AppUserModelID)
function migrateAutostart() {
  try {
    if (readRun(OLD_LOGIN_NAME)) { reg(['delete', RUN_KEY, '/v', OLD_LOGIN_NAME, '/f']); setAutostart(true); }
  } catch (e) { console.log('[autostart]', e.message); }
}
// pendant la capture d'un raccourci, on désactive les raccourcis globaux
ipcMain.handle('capture', (_e, on) => { on ? globalShortcut.unregisterAll() : registerShortcuts(); return publicState(); });

// ---------------------------------------------------------------- démarrage
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_ID);
    ensureStartMenuShortcut();
    migrateAutostart();
    tray = new Tray(nativeImage.createFromPath(iconPath(32)));
    tray.on('click', showWindow);
    const hadConfig = loadConfig();
    try {
      hardware = await native.list(false);
      if (!hadConfig) { seedScenes(hardware); saveConfig(); }
    } catch (e) {
      notify('Screen Switcher', 'Helper natif indisponible : ' + e.message, true);
    }
    registerShortcuts();
    refreshTray();
    if (!process.argv.includes('--hidden')) showWindow();
  });
  app.on('window-all-closed', () => { /* reste dans la zone de notification */ });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); native.stop(); });
}
