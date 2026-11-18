// Rend les SVG de assets/ en PNG 1x et @2x dans le dossier du plugin.
// Lancer avec l'Electron du projet principal : npm run images
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const out = {
  'icon.svg': 'imgs/actions/scene/icon',
  'key.svg': 'imgs/actions/scene/key',
  'category-icon.svg': 'imgs/plugin/category-icon',
  'marketplace.svg': 'imgs/plugin/marketplace',
};
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, backgroundColor: "#00000000", webPreferences: { offscreen: true } });
  for (const [src, dst] of Object.entries(out)) {
    const svg = fs.readFileSync(path.join(root, 'assets', src), 'utf8');
    const w = +svg.match(/width="(\d+)"/)[1], h = +svg.match(/height="(\d+)"/)[1];
    for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
      const s = svg.replace(/width="\d+" height="\d+"/, `width="${w * scale * 2}" height="${h * scale * 2}"`);
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent;overflow:hidden">${s}</body></html>`));
      await new Promise((r) => setTimeout(r, 200));
      const img = (await win.webContents.capturePage({ x: 0, y: 0, width: w * scale * 2, height: h * scale * 2 }))
        .resize({ width: w * scale, height: h * scale, quality: 'best' });
      const file = path.join(root, 'com.rrytter.screenswitcher.sdPlugin', dst + suffix + '.png');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, img.toPNG());
      console.log(path.relative(root, file), img.getSize(), 'alpha(0,0)=' + img.toBitmap()[3]);
    }
  }
  app.quit();
});
