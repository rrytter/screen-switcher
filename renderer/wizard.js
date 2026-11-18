// Input source wizard (DDC/CI): checks a monitor's standard codes, otherwise scans a range
// of codes and asks the user what the monitor shows. The result is saved as the model's
// profile (config.inputProfiles), which takes precedence over MODEL_PROFILES.
const Wizard = (() => {
  const WAIT = 2500; // lets the monitor switch (usually 1–2 s) before asking / reading
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  // non-standard codes seen with some vendors (LG in particular)
  const VENDOR = [0x90, 0x91, 0x92, 0xc0, 0xc1, 0xc2, 0xd0, 0xd1, 0xd2];
  const STAGES = {
    mccs: { codes: range(0x01, 0x1f), label: 'wiz.stage.mccs', hint: '~2 min' },
    vendor: { codes: VENDOR, label: 'wiz.stage.vendor', hint: '~30 s' },
    full: { codes: range(0x20, 0xff).filter((c) => !VENDOR.includes(c)), label: 'wiz.stage.full', hint: '~10 min' },
  };

  let w = null; // state of the open wizard
  const box = () => document.querySelector('#wizard .dialog');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const used = () => w.ports.filter((p) => p.role !== 'off');
  const pcPort = () => w.ports.find((p) => p.role === 'pc');
  const rect = (m) => ({ x: m.x, y: m.y, width: m.width, height: m.height });

  function open(m) {
    const prof = profileOf(m);
    w = {
      m, ref: { hwId: m.hwId, device: m.device, devicePath: m.devicePath },
      // role of each standard input: off (not connected) / pc (this PC) / other (other device)
      ports: INPUTS.map(([code, label]) => ({ code, label, role: 'off' })),
      learned: !!(state.inputProfiles || {})[m.model],
      hadProfile: !!prof,
    };
    // prefill: current input = this PC if the monitor follows the standard
    if (!prof && m.currentInput >= 0) {
      const p = w.ports.find((x) => x.code === m.currentInput);
      if (p) p.role = 'pc';
    }
    resetResults();
    document.querySelector('#wizard').classList.remove('hidden');
    document.addEventListener('keydown', onKey, true);
    intro();
  }

  function resetResults() {
    w.found = {};       // input label → { code, read } (the monitor switched to it)
    w.weak = {};        // code → label: "nothing changed" while the monitor was showing that input
    w.black = new Set();// codes → black screen / no signal
    w.log = [];
    w.current = pcPort() ? pcPort().label : null; // input currently shown
    w.tried = new Set();
    w.done = new Set(); // search stages already done
  }

  async function close() {
    if (w && w.running) { w.abort = true; return; }
    document.querySelector('#wizard').classList.add('hidden');
    document.removeEventListener('keydown', onKey, true);
    w = null;
  }

  // ------------------------------------------------------------ step 1: setup
  async function intro() {
    const onIt = await window.api.windowOnMonitor(rect(w.m)).catch(() => false);
    const rows = w.ports.map((p, i) => `
      <tr><td>${esc(p.label)} <span class="muted">(${toHex(p.code)})</span></td>
      <td><select data-port="${i}">
        <option value="off"${p.role === 'off' ? ' selected' : ''}>${t('wiz.role.off')}</option>
        <option value="pc"${p.role === 'pc' ? ' selected' : ''}>${t('wiz.role.pc')}</option>
        <option value="other"${p.role === 'other' ? ' selected' : ''}>${t('wiz.role.other')}</option>
      </select></td></tr>`).join('');
    box().innerHTML = `
      <h3>${uiIcon('wand')} ${esc(t('wiz.title', { name: monName(w.m) }))} <span class="muted">${esc(w.m.model || '')}</span></h3>
      ${onIt ? `<div class="warn">${t('wiz.onIt')}
        <button class="btn small" id="wz-move">${t('wiz.move')}</button></div>` : ''}
      <p>${t('wiz.intro')}</p>
      <ul class="tips">
        <li>${t('wiz.tip1')}</li>
        <li>${t('wiz.tip2')}</li>
      </ul>
      <p class="muted">${t('wiz.portsHint')}</p>
      <table class="wz-ports">${rows}</table>
      <div class="wz-foot">
        ${w.learned ? `<button class="btn ghost" id="wz-reset">${t('wiz.reset')}</button>` : ''}
        <span class="grow"></span>
        <button class="btn ghost" id="wz-cancel">${t('wiz.cancel')}</button>
        <button class="btn primary" id="wz-start" data-icon="play">${t('wiz.start')}</button>
      </div>`;
    applyUiIcons(box());
    for (const s of box().querySelectorAll('select[data-port]')) {
      s.onchange = () => {
        const p = w.ports[+s.dataset.port];
        if (s.value === 'pc') for (const q of w.ports) if (q.role === 'pc') q.role = 'other'; // only one "this PC"
        p.role = s.value;
        intro();
      };
    }
    const ok = used().length >= 2 && !!pcPort();
    const start = box().querySelector('#wz-start');
    start.disabled = !ok;
    if (!ok) start.title = t('wiz.needTwo');
    start.onclick = () => { resetResults(); quickCheck(); };
    box().querySelector('#wz-cancel').onclick = close;
    const mv = box().querySelector('#wz-move');
    if (mv) mv.onclick = async () => { await window.api.windowMoveAway(rect(w.m)); intro(); };
    const rs = box().querySelector('#wz-reset');
    if (rs) rs.onclick = async () => {
      state = await window.api.saveInputProfile(w.m.model, null);
      toast(t('wiz.resetDone')); close(); render();
    };
  }

  // ------------------------------------------------------------ sending codes
  // Quick check: standard code of each used input, this PC's last (to come back to the PC)
  async function quickCheck() {
    const order = [...used().filter((p) => p.role !== 'pc'), pcPort()];
    await run(order.map((p) => ({ code: p.code, expect: p.label })), t('wiz.quick'));
    summary();
  }

  async function search(stage) {
    w.done.add(stage);
    // only skip codes already assigned to an input: a "nothing changed" from the quick check
    // (e.g. code sent while the monitor was already showing that input) must be retested
    const known = new Set(Object.values(w.found).map((f) => f.code));
    const codes = STAGES[stage].codes.filter((c) => !known.has(c));
    await run(codes.map((code) => ({ code })), t(STAGES[stage].label), true);
    await verifyWeak();
    summary();
  }

  // "Nothing changed" is ambiguous (code ignored, or code of the input already shown):
  // candidate codes of inputs still missing are re-checked from another input.
  async function verifyWeak() {
    const missing = used().filter((p) => !w.found[p.label]).map((p) => p.label);
    const steps = [];
    for (const [code, label] of Object.entries(w.weak)) {
      if (!missing.includes(label)) continue;
      const from = Object.entries(w.found).find(([l]) => l !== label);
      if (from) steps.push({ pre: from[1].code, code: +code });
    }
    if (steps.length) await run(steps, t('wiz.doubtful'));
  }

  async function run(steps, title, stopWhenComplete = false) {
    w.running = true; w.abort = false;
    try {
      for (let i = 0; i < steps.length && !w.abort; i++) {
        const s = steps[i];
        if (s.pre !== undefined) {
          // switch to another input first (already validated code), without asking
          await window.api.probe(w.ref, s.pre, WAIT);
          w.current = Object.keys(w.found).find((l) => w.found[l].code === s.pre) || null;
        }
        showProbe(title, s, i, steps.length, true);
        const r = await window.api.probe(w.ref, s.code, WAIT).catch((e) => ({ error: e.message }));
        if (r.error) { toast(r.error, true); break; }
        const ans = await ask(title, s, i, steps.length);
        if (ans === 'stop') { w.abort = true; break; }
        record(s.code, ans, r.read);
        if (stopWhenComplete && used().every((p) => w.found[p.label])) break;
      }
    } finally { w.running = false; }
  }

  function record(code, ans, read) {
    w.tried.add(code);
    w.log.push({ code, answer: ans, read });
    if (ans === 'black') { w.black.add(code); w.current = null; return; }
    // input not selected during setup: the monitor changed, but nothing to keep
    if (ans === 'elsewhere') { w.current = '?'; delete w.weak[code]; return; }
    if (ans === 'same' || ans === w.current) {
      if (w.current) w.weak[code] = w.current; else w.black.add(code);
      return;
    }
    // the monitor switched to input "ans"
    if (!w.found[ans]) w.found[ans] = { code, read };
    delete w.weak[code];
    w.current = ans;
  }

  function showProbe(title, s, i, n, busy) {
    const answers = used().map((p, k) => `<button class="btn wz-ans" data-ans="${esc(p.label)}" ${busy ? 'disabled' : ''}>
        <kbd>${k + 1}</kbd>${esc(p.label)} <span class="muted">${p.role === 'pc' ? t('wiz.thisPc') : t('wiz.otherDev')}</span></button>`).join('');
    box().innerHTML = `
      <h3>${uiIcon('wand')} ${esc(title)} <span class="muted">${i + 1} / ${n}</span></h3>
      <div class="wz-progress"><div style-width="${Math.round((i / n) * 100)}"></div></div>
      <p class="wz-code">${t('wiz.sent')} <b>${toHex(s.code)}</b>${s.expect ? ` <span class="muted">${esc(t('wiz.stdFor', { name: s.expect }))}</span>` : ''}</p>
      <p>${busy ? t('wiz.switching') : t('wiz.question')}</p>
      <div class="wz-answers">${answers}
        <button class="btn wz-ans" data-ans="same" ${busy ? 'disabled' : ''}><kbd>${t('key.space')}</kbd>${t('wiz.same')}</button>
        <button class="btn wz-ans" data-ans="black" ${busy ? 'disabled' : ''}><kbd>N</kbd>${t('wiz.black')}</button>
        <button class="btn wz-ans" data-ans="elsewhere" ${busy ? 'disabled' : ''}><kbd>A</kbd>${t('wiz.elsewhere')}</button>
      </div>
      <div class="wz-foot"><span class="grow"></span><button class="btn ghost" id="wz-stop" data-ans="stop"><kbd>${t('key.esc')}</kbd>${t('wiz.stop')}</button></div>`;
    // bar width (no inline style: CSP)
    const bar = box().querySelector('.wz-progress div');
    bar.style.width = bar.getAttribute('style-width') + '%';
  }

  let answer = null; // resolver of the current question
  function ask(title, s, i, n) {
    showProbe(title, s, i, n, false);
    return new Promise((resolve) => {
      answer = (v) => { answer = null; resolve(v); };
      for (const b of box().querySelectorAll('[data-ans]')) b.onclick = () => answer && answer(b.dataset.ans);
    });
  }

  function onKey(e) {
    if (!w) return;
    if (e.key === 'Escape') { e.preventDefault(); if (answer) answer('stop'); else if (!w.running) close(); return; }
    if (!answer) return;
    const u = used();
    if (/^[1-9]$/.test(e.key) && u[+e.key - 1]) { e.preventDefault(); answer(u[+e.key - 1].label); }
    else if (e.key === ' ') { e.preventDefault(); answer('same'); }
    else if (e.key.toLowerCase() === 'n') { e.preventDefault(); answer('black'); }
    else if (e.key.toLowerCase() === 'a') { e.preventDefault(); answer('elsewhere'); }
  }

  // ------------------------------------------------------------ result
  function summary() {
    const ports = used();
    const missing = ports.filter((p) => !w.found[p.label]);
    const allStd = !missing.length && ports.every((p) => w.found[p.label].code === p.code);
    const rows = ports.map((p) => {
      const f = w.found[p.label];
      const st = !f ? `<span class="bad">${t('wiz.notFound')}</span>`
        : f.code === p.code ? `<span class="ok">${toHex(f.code)} ${t('wiz.std')}</span>` : `<span class="warn-t">${toHex(f.code)}</span> <span class="muted">${t('wiz.stdWas', { code: toHex(p.code) })}</span>`;
      return `<tr><td>${esc(p.label)} <span class="muted">${p.role === 'pc' ? t('wiz.thisPc') : ''}</span></td><td>${st}</td></tr>`;
    }).join('');
    const blackNote = missing.length && w.black.size
      ? `<p class="muted">${t('wiz.blackNote', { codes: [...w.black].map(toHex).join(', ') })}</p>` : '';
    const next = Object.keys(STAGES).filter((k) => !w.done.has(k));
    const searchBtns = missing.length ? next.slice(0, 1).map((k) =>
      `<button class="btn primary" data-stage="${k}" data-icon="refresh">${t(STAGES[k].label)} <span class="muted-l">${STAGES[k].hint}</span></button>`).join('') : '';
    const pc = pcPort();
    const back = w.current !== pc.label && !w.found[pc.label]
      ? `<div class="warn">${t('wiz.notBack')}</div>` : '';
    box().innerHTML = `
      <h3>${uiIcon('wand')} ${esc(t('wiz.result', { name: monName(w.m) }))}</h3>
      ${allStd ? `<p class="ok-box">${t('wiz.allStd')}</p>`
        : missing.length ? `<p>${missing.length === ports.length ? t('wiz.noneFound') : t('wiz.someFound')}${next.length ? t('wiz.widen') : t('wiz.notControllable')}</p>`
        : `<p>${t('wiz.nonStd')}</p>`}
      <table class="wz-ports">${rows}</table>
      ${blackNote}${back}
      <div class="wz-foot">
        <button class="btn ghost" id="wz-copy" data-icon="link" title="${t('wiz.copy.title')}">${t('wiz.copy')}</button>
        <span class="grow"></span>
        ${searchBtns}
        <button class="btn${missing.length && next.length ? ' ghost' : ' primary'}" id="wz-finish" data-icon="save">${t('wiz.finish')}</button>
      </div>`;
    applyUiIcons(box());
    for (const b of box().querySelectorAll('[data-stage]')) b.onclick = () => search(b.dataset.stage);
    box().querySelector('#wz-copy').onclick = async () => { await window.api.copy(JSON.stringify(report(), null, 2)); toast(t('wiz.copied')); };
    box().querySelector('#wz-finish').onclick = finish;
  }

  function buildProfile() {
    const ports = used().filter((p) => w.found[p.label]);
    const readBack = {};
    for (const p of ports) { const f = w.found[p.label]; if (f.read >= 0) readBack[f.code] = f.read; }
    const missing = used().filter((p) => !w.found[p.label]).map((p) => p.label);
    return {
      inputs: ports.map((p) => [w.found[p.label].code, p.label]),
      readBack,
      // note in both languages (shown in the input list tooltip)
      note: Object.fromEntries(['en', 'fr'].map((l) => [l, I18n.STRINGS[l]['wiz.note']
        + (missing.length ? ' — ' + I18n.STRINGS[l]['wiz.noteMissing'].replace('{inputs}', missing.join(', ')) : '')])),
      learned: new Date().toISOString().slice(0, 10),
    };
  }

  function report() {
    return { model: w.m.model, name: w.m.name, profile: buildProfile(), log: w.log.map((l) => ({ code: toHex(l.code), answer: l.answer, read: l.read >= 0 ? toHex(l.read) : null })) };
  }

  async function finish() {
    const ports = used();
    const prof = buildProfile();
    // no profile needed if everything is standard (written codes = codes read back): keep the standard
    const standard = ports.every((p) => w.found[p.label] && w.found[p.label].code === p.code)
      && Object.entries(prof.readBack).every(([c, r]) => +c === r);
    if (prof.inputs.length) {
      state = await window.api.saveInputProfile(w.m.model, standard ? null : prof);
      toast(standard ? t('wiz.confirmed') : t('wiz.savedFor', { model: w.m.model }));
    }
    // back to this PC if its code is known
    const pc = w.found[pcPort().label];
    if (pc && w.current !== pcPort().label) await window.api.testInput(w.ref, pc.code).catch(() => {});
    close();
    render();
  }

  return { open, close };
})();
