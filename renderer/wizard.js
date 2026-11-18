// Assistant des sources d'entrée (DDC/CI) : vérifie les codes standard d'un écran,
// sinon balaye une plage de codes en demandant à l'utilisateur ce que l'écran affiche.
// Le résultat est enregistré comme profil du modèle (config.inputProfiles), prioritaire sur MODEL_PROFILES.
const Wizard = (() => {
  const WAIT = 2500; // laisse l'écran basculer (1–2 s en général) avant de demander / lire
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  // codes vus chez certains constructeurs hors norme (LG notamment)
  const VENDOR = [0x90, 0x91, 0x92, 0xc0, 0xc1, 0xc2, 0xd0, 0xd1, 0xd2];
  const STAGES = {
    mccs: { codes: range(0x01, 0x1f), label: 'Recherche approfondie', hint: '~2 min' },
    vendor: { codes: VENDOR, label: 'Codes constructeurs', hint: '~30 s' },
    full: { codes: range(0x20, 0xff).filter((c) => !VENDOR.includes(c)), label: 'Tout balayer', hint: '~10 min' },
  };

  let w = null; // état de l'assistant ouvert
  const box = () => document.querySelector('#wizard .dialog');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const used = () => w.ports.filter((p) => p.role !== 'off');
  const pcPort = () => w.ports.find((p) => p.role === 'pc');
  const rect = (m) => ({ x: m.x, y: m.y, width: m.width, height: m.height });

  function open(m) {
    const prof = profileOf(m);
    w = {
      m, ref: { hwId: m.hwId, device: m.device, devicePath: m.devicePath },
      // rôle de chaque entrée standard : off (non branchée) / pc (ce PC) / other (autre appareil)
      ports: INPUTS.map(([code, label]) => ({ code, label, role: 'off' })),
      learned: !!(state.inputProfiles || {})[m.model],
      hadProfile: !!prof,
    };
    // pré-remplissage : entrée actuelle = ce PC si l'écran suit la norme
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
    w.found = {};       // libellé d'entrée → { code, read } (l'écran a basculé dessus)
    w.weak = {};        // code → libellé : « rien n'a changé » alors que l'écran montrait cette entrée
    w.black = new Set();// codes → écran noir / pas de signal
    w.log = [];
    w.current = pcPort() ? pcPort().label : null; // entrée affichée en ce moment
    w.tried = new Set();
    w.done = new Set(); // étapes de recherche déjà faites
  }

  async function close() {
    if (w && w.running) { w.abort = true; return; }
    document.querySelector('#wizard').classList.add('hidden');
    document.removeEventListener('keydown', onKey, true);
    w = null;
  }

  // ------------------------------------------------------------ écran 1 : préparation
  async function intro() {
    const onIt = await window.api.windowOnMonitor(rect(w.m)).catch(() => false);
    const rows = w.ports.map((p, i) => `
      <tr><td>${esc(p.label)} <span class="muted">(${toHex(p.code)})</span></td>
      <td><select data-port="${i}">
        <option value="off"${p.role === 'off' ? ' selected' : ''}>Non branchée</option>
        <option value="pc"${p.role === 'pc' ? ' selected' : ''}>Ce PC</option>
        <option value="other"${p.role === 'other' ? ' selected' : ''}>Autre appareil</option>
      </select></td></tr>`).join('');
    box().innerHTML = `
      <h3>${uiIcon('wand')} Assistant des sources — ${esc(monName(w.m))} <span class="muted">${esc(w.m.model || '')}</span></h3>
      ${onIt ? `<div class="warn">Cette fenêtre est sur l'écran à tester : vous ne la verrez plus quand il changera de source.
        <button class="btn small" id="wz-move">Déplacer sur un autre écran</button></div>` : ''}
      <p>L'assistant envoie des codes à l'écran et vous indiquez ce qu'il affiche (la plupart des écrans affichent le nom de l'entrée en changeant).</p>
      <ul class="tips">
        <li>Allumez les appareils branchés sur cet écran (laptop, console…).</li>
        <li>Coupez la <b>détection automatique de source</b> dans le menu de l'écran.</li>
      </ul>
      <p class="muted">Entrées de l'écran : indiquez celles qui sont branchées.</p>
      <table class="wz-ports">${rows}</table>
      <div class="wz-foot">
        ${w.learned ? '<button class="btn ghost" id="wz-reset">Revenir aux codes standard</button>' : ''}
        <span class="grow"></span>
        <button class="btn ghost" id="wz-cancel">Annuler</button>
        <button class="btn primary" id="wz-start" data-icon="play">Vérifier les codes standard</button>
      </div>`;
    applyUiIcons(box());
    for (const s of box().querySelectorAll('select[data-port]')) {
      s.onchange = () => {
        const p = w.ports[+s.dataset.port];
        if (s.value === 'pc') for (const q of w.ports) if (q.role === 'pc') q.role = 'other'; // un seul « ce PC »
        p.role = s.value;
        intro();
      };
    }
    const ok = used().length >= 2 && !!pcPort();
    const start = box().querySelector('#wz-start');
    start.disabled = !ok;
    if (!ok) start.title = 'Indiquez au moins deux entrées branchées, dont celle de ce PC';
    start.onclick = () => { resetResults(); quickCheck(); };
    box().querySelector('#wz-cancel').onclick = close;
    const mv = box().querySelector('#wz-move');
    if (mv) mv.onclick = async () => { await window.api.windowMoveAway(rect(w.m)); intro(); };
    const rs = box().querySelector('#wz-reset');
    if (rs) rs.onclick = async () => {
      state = await window.api.saveInputProfile(w.m.model, null);
      toast('Codes standard rétablis'); close(); render();
    };
  }

  // ------------------------------------------------------------ envoi des codes
  // Vérification rapide : code standard de chaque entrée utilisée, celle de ce PC en dernier (retour au PC)
  async function quickCheck() {
    const order = [...used().filter((p) => p.role !== 'pc'), pcPort()];
    await run(order.map((p) => ({ code: p.code, expect: p.label })), 'Vérification des codes standard');
    summary();
  }

  async function search(stage) {
    w.done.add(stage);
    // on ne saute que les codes déjà attribués à une entrée : un « rien n'a changé » de la vérification
    // rapide (ex. code envoyé alors que l'écran montrait déjà cette entrée) doit être retesté
    const known = new Set(Object.values(w.found).map((f) => f.code));
    const codes = STAGES[stage].codes.filter((c) => !known.has(c));
    await run(codes.map((code) => ({ code })), STAGES[stage].label, true);
    await verifyWeak();
    summary();
  }

  // « Rien n'a changé » est ambigu (code ignoré, ou code de l'entrée déjà affichée) :
  // on revérifie depuis une autre entrée les codes candidats des entrées encore introuvables.
  async function verifyWeak() {
    const missing = used().filter((p) => !w.found[p.label]).map((p) => p.label);
    const steps = [];
    for (const [code, label] of Object.entries(w.weak)) {
      if (!missing.includes(label)) continue;
      const from = Object.entries(w.found).find(([l]) => l !== label);
      if (from) steps.push({ pre: from[1].code, code: +code });
    }
    if (steps.length) await run(steps, 'Vérification des codes douteux');
  }

  async function run(steps, title, stopWhenComplete = false) {
    w.running = true; w.abort = false;
    try {
      for (let i = 0; i < steps.length && !w.abort; i++) {
        const s = steps[i];
        if (s.pre !== undefined) {
          // passage préalable sur une autre entrée (code déjà validé), sans question
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
    // entrée non cochée dans la préparation : l'écran a changé, mais rien à retenir
    if (ans === 'elsewhere') { w.current = '?'; delete w.weak[code]; return; }
    if (ans === 'same' || ans === w.current) {
      if (w.current) w.weak[code] = w.current; else w.black.add(code);
      return;
    }
    // l'écran a basculé sur l'entrée « ans »
    if (!w.found[ans]) w.found[ans] = { code, read };
    delete w.weak[code];
    w.current = ans;
  }

  function showProbe(title, s, i, n, busy) {
    const answers = used().map((p, k) => `<button class="btn wz-ans" data-ans="${esc(p.label)}" ${busy ? 'disabled' : ''}>
        <kbd>${k + 1}</kbd>${esc(p.label)} <span class="muted">${p.role === 'pc' ? 'ce PC' : 'autre appareil'}</span></button>`).join('');
    box().innerHTML = `
      <h3>${uiIcon('wand')} ${esc(title)} <span class="muted">${i + 1} / ${n}</span></h3>
      <div class="wz-progress"><div style-width="${Math.round((i / n) * 100)}"></div></div>
      <p class="wz-code">Code envoyé : <b>${toHex(s.code)}</b>${s.expect ? ` <span class="muted">(standard pour ${esc(s.expect)})</span>` : ''}</p>
      <p>${busy ? 'Changement de source en cours…' : 'Qu\'affiche l\'écran maintenant ?'}</p>
      <div class="wz-answers">${answers}
        <button class="btn wz-ans" data-ans="same" ${busy ? 'disabled' : ''}><kbd>Espace</kbd>Rien n'a changé</button>
        <button class="btn wz-ans" data-ans="black" ${busy ? 'disabled' : ''}><kbd>N</kbd>Écran noir / pas de signal</button>
        <button class="btn wz-ans" data-ans="elsewhere" ${busy ? 'disabled' : ''}><kbd>A</kbd>Une autre entrée</button>
      </div>
      <div class="wz-foot"><span class="grow"></span><button class="btn ghost" id="wz-stop" data-ans="stop"><kbd>Échap</kbd>Arrêter</button></div>`;
    // largeur de la barre (pas de style inline : CSP)
    const bar = box().querySelector('.wz-progress div');
    bar.style.width = bar.getAttribute('style-width') + '%';
  }

  let answer = null; // résolveur de la question en cours
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

  // ------------------------------------------------------------ résultat
  function summary() {
    const ports = used();
    const missing = ports.filter((p) => !w.found[p.label]);
    const allStd = !missing.length && ports.every((p) => w.found[p.label].code === p.code);
    const rows = ports.map((p) => {
      const f = w.found[p.label];
      const st = !f ? '<span class="bad">introuvable</span>'
        : f.code === p.code ? `<span class="ok">${toHex(f.code)} ✓ standard</span>` : `<span class="warn-t">${toHex(f.code)}</span> <span class="muted">(standard : ${toHex(p.code)})</span>`;
      return `<tr><td>${esc(p.label)} <span class="muted">${p.role === 'pc' ? 'ce PC' : ''}</span></td><td>${st}</td></tr>`;
    }).join('');
    const blackNote = missing.length && w.black.size
      ? `<p class="muted">Écran noir obtenu avec ${[...w.black].map(toHex).join(', ')} : une entrée dont l'appareil est éteint ? Allumez-le puis relancez l'assistant.</p>` : '';
    const next = Object.keys(STAGES).filter((k) => !w.done.has(k));
    const searchBtns = missing.length ? next.slice(0, 1).map((k) =>
      `<button class="btn primary" data-stage="${k}" data-icon="refresh">${STAGES[k].label} <span class="muted-l">${STAGES[k].hint}</span></button>`).join('') : '';
    const pc = pcPort();
    const back = w.current !== pc.label && !w.found[pc.label]
      ? `<div class="warn">L'écran n'est pas revenu sur ce PC et aucun code n'y mène : remettez-le sur ce PC avec ses boutons.</div>` : '';
    box().innerHTML = `
      <h3>${uiIcon('wand')} Résultat — ${esc(monName(w.m))}</h3>
      ${allStd ? '<p class="ok-box">Les codes standard fonctionnent avec cet écran : rien à régler.</p>'
        : missing.length ? `<p>${missing.length === ports.length ? 'Aucune entrée trouvée.' : 'Une partie des entrées a été trouvée.'}${next.length ? ' Vous pouvez élargir la recherche.' : ' Ces entrées ne sont pas pilotables par DDC/CI sur cet écran.'}</p>`
        : '<p>Cet écran utilise des codes non standard : ils seront utilisés pour ce modèle.</p>'}
      <table class="wz-ports">${rows}</table>
      ${blackNote}${back}
      <div class="wz-foot">
        <button class="btn ghost" id="wz-copy" data-icon="link" title="Pour partager le résultat (issue GitHub)">Copier le rapport</button>
        <span class="grow"></span>
        ${searchBtns}
        <button class="btn${missing.length && next.length ? ' ghost' : ' primary'}" id="wz-finish" data-icon="save">Terminer</button>
      </div>`;
    applyUiIcons(box());
    for (const b of box().querySelectorAll('[data-stage]')) b.onclick = () => search(b.dataset.stage);
    box().querySelector('#wz-copy').onclick = async () => { await window.api.copy(JSON.stringify(report(), null, 2)); toast('Rapport copié'); };
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
      note: 'codes trouvés par l\'assistant' + (missing.length ? ` — ${missing.join(', ')} non pilotable` : ''),
      learned: new Date().toISOString().slice(0, 10),
    };
  }

  function report() {
    return { model: w.m.model, name: w.m.name, profile: buildProfile(), log: w.log.map((l) => ({ code: toHex(l.code), answer: l.answer, read: l.read >= 0 ? toHex(l.read) : null })) };
  }

  async function finish() {
    const ports = used();
    const prof = buildProfile();
    // profil inutile si tout est standard (codes écrits = codes lus) : on garde la norme
    const standard = ports.every((p) => w.found[p.label] && w.found[p.label].code === p.code)
      && Object.entries(prof.readBack).every(([c, r]) => +c === r);
    if (prof.inputs.length) {
      state = await window.api.saveInputProfile(w.m.model, standard ? null : prof);
      toast(standard ? 'Codes standard confirmés' : `Codes enregistrés pour ${w.m.model}`);
    }
    // retour sur ce PC si on connaît le code
    const pc = w.found[pcPort().label];
    if (pc && w.current !== pcPort().label) await window.api.testInput(w.ref, pc.code).catch(() => {});
    close();
    render();
  }

  return { open, close };
})();
