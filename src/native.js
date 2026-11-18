// Bridge to the persistent PowerShell helper (native/helper.ps1).
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

class Native {
  constructor(nativeDir) {
    this.nativeDir = nativeDir;
    this.pending = new Map();
    this.nextId = 1;
    this.proc = null;
    this.ready = null;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      this.proc = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(this.nativeDir, 'helper.ps1'),
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

      const rl = readline.createInterface({ input: this.proc.stdout });
      rl.on('line', (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.id === 0) { msg.ok ? resolve() : reject(new Error(msg.error)); return; }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.ok) { p.resolve(msg.result); return; }
        const err = new Error(msg.error || 'Unknown error');
        err.result = msg.result;   // partial result (e.g. display modes stored despite an audio error)
        p.reject(err);
      });
      let stderr = '';
      this.proc.stderr.on('data', (d) => { stderr += d.toString(); });
      this.proc.on('exit', (code) => {
        const err = new Error(`PowerShell helper stopped (code ${code}) ${stderr.trim()}`);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        this.proc = null;
        this.ready = null;
        reject(err);
      });
    });
    return this.ready;
  }

  async call(cmd, args = {}) {
    await this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }

  list(ddc = true) { return this.call('list', { ddc }); }
  apply(scene) { return this.call('apply', { scene }); }
  setInput(ref, value) { return this.call('input', { ...ref, value }); }
  probe(ref, value, waitMs) { return this.call('probe', { ...ref, value, waitMs }); }
  stop() { if (this.proc) this.proc.kill(); }
}

module.exports = { Native };
