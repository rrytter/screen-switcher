// Regenerates assets/icon-*.png and assets/icon.ico from assets/src/*.svg
// npx electron scripts/render-icons.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const A = path.join(__dirname, '..', 'assets');
// 16 to 32 px: simplified drawing (readable in the notification area)
const SIZES = { 16: 'icon-small', 20: 'icon-small', 24: 'icon-small', 32: 'icon-small', 48: 'icon', 64: 'icon', 128: 'icon', 256: 'icon' };
const KEEP_PNG = [16, 32, 48, 64, 256];
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, backgroundColor: '#00000000', webPreferences: { offscreen: true } });
  const pngs = {};
  for (const [sz, src] of Object.entries(SIZES)) {
    const n = +sz, big = n * 4;
    const svg = fs.readFileSync(path.join(A, 'src', src + '.svg'), 'utf8').replace(/width="\d+" height="\d+"/, `width="${big}" height="${big}"`);
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`));
    await new Promise((r) => setTimeout(r, 150));
    const img = (await win.webContents.capturePage({ x: 0, y: 0, width: big, height: big })).resize({ width: n, height: n, quality: 'best' });
    pngs[n] = img.toPNG();
    if (KEEP_PNG.includes(n)) fs.writeFileSync(path.join(A, `icon-${n}.png`), pngs[n]);
  }
  // .ico: header + directory + PNG images (accepted by Windows Vista+)
  const sizes = Object.keys(pngs).map(Number).sort((a, b) => a - b);
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let off = head.length;
  sizes.forEach((n, i) => {
    const e = 6 + 16 * i, d = pngs[n];
    head.writeUInt8(n >= 256 ? 0 : n, e); head.writeUInt8(n >= 256 ? 0 : n, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(d.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += d.length;
  });
  fs.writeFileSync(path.join(A, 'icon.ico'), Buffer.concat([head, ...sizes.map((n) => pngs[n])]));
  console.log('icons:', sizes.join(', '));
  app.quit();
});
