// Scene icons (Stream Deck-style key tiles), shared by the UI (<script>)
// and the Stream Deck plugin (imported through rollup).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SceneIcons = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // White line drawings in a 144×144 square (drawing area ~ y 20–104, the label goes below).
  const GLYPHS = {
    monitor: '<rect x="30" y="20" width="84" height="58" rx="7"/><path d="M72 78v14M52 94h40"/>',
    dual: '<rect x="10" y="28" width="58" height="42" rx="6"/><rect x="76" y="28" width="58" height="42" rx="6"/><path d="M39 70v12M27 86h24M105 70v12M93 86h24"/>',
    'monitor-laptop': '<rect x="12" y="24" width="62" height="44" rx="6"/><path d="M43 68v12M31 84h24"/><rect x="86" y="44" width="42" height="30" rx="3"/><path d="M80 82h54"/>',
    laptop: '<rect x="34" y="24" width="76" height="52" rx="5"/><path d="M20 88h104"/>',
    projector: '<path d="M80 62L130 34V104L80 76Z" fill="#fff" fill-opacity=".2" stroke="none"/><rect x="14" y="50" width="66" height="38" rx="9"/><circle cx="60" cy="69" r="10"/><path d="M26 88v6M70 88v6"/><circle cx="29" cy="62" r="2" fill="#fff"/>',
    tv: '<rect x="18" y="20" width="108" height="64" rx="6"/><path d="M48 96h48"/>',
    gamepad: '<path d="M46 40h52a24 24 0 0 1 24 24v6a18 18 0 0 1-32 11l-6-7H60l-6 7a18 18 0 0 1-32-11v-6a24 24 0 0 1 24-24z"/><path d="M44 54v14M37 61h14"/><circle cx="94" cy="56" r="2.5" fill="#fff"/><circle cx="103" cy="65" r="2.5" fill="#fff"/>',
    headphones: '<path d="M30 92V70a42 42 0 0 1 84 0v22"/><rect x="24" y="74" width="20" height="30" rx="6"/><rect x="100" y="74" width="20" height="30" rx="6"/>',
    moon: '<path d="M98 76A36 36 0 1 1 66 26a28 28 0 0 0 32 50z"/>',
    unknown: '<circle cx="72" cy="56" r="34"/><path d="M60 46a12 12 0 1 1 16 11c-3 1-4 4-4 7"/><circle cx="72" cy="76" r="2" fill="#fff"/>',
  };
  const GLYPH_NAMES = {
    monitor: 'Display', dual: 'Two displays', 'monitor-laptop': 'Display + laptop', laptop: 'Laptop',
    projector: 'Projector', tv: 'TV', gamepad: 'Console', headphones: 'Headphones', moon: 'Night',
  };
  const COLORS = {
    blue: ['#3b82f6', '#1e3a8a'], teal: ['#14b8a6', '#134e4a'], green: ['#22c55e', '#14532d'],
    amber: ['#f59e0b', '#9a3412'], red: ['#ef4444', '#7f1d1d'], pink: ['#ec4899', '#831843'],
    violet: ['#8b5cf6', '#3b0764'], slate: ['#64748b', '#1e293b'],
  };
  const COLOR_NAMES = {
    blue: 'Bleu', teal: "Vert d'eau", green: 'Vert', amber: 'Orange', red: 'Rouge', pink: 'Rose', violet: 'Violet', slate: 'Gris',
  };
  const DEFAULT_COLOR = {
    monitor: 'blue', dual: 'violet', 'monitor-laptop': 'teal', laptop: 'teal', projector: 'amber',
    tv: 'pink', gamepad: 'red', headphones: 'green', moon: 'slate', unknown: 'slate',
  };

  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  /** Guesses a drawing from the scene name. */
  function guessGlyph(name) {
    const n = norm(name);
    if (/projec/.test(n)) return 'projector';
    if (/switch|console|jeu|game|xbox|playstation|ps5/.test(n)) return 'gamepad';
    if (/\btv\b|tele/.test(n)) return 'tv';
    if (/casque|headphone|headset/.test(n)) return 'headphones';
    if (/nuit|night|veille/.test(n)) return 'moon';
    if (/laptop|portable/.test(n)) return /pc|\+|bureau|desk/.test(n) ? 'monitor-laptop' : 'laptop';
    if (/bureau|desk|double|dual/.test(n)) return 'dual';
    return 'monitor';
  }

  /**
   * Effective icon and color: explicit choice (not "auto") > scene setting > automatic.
   * @param scene { name, icon?, color? }
   * @param over  { icon?, color? } override (e.g. settings of a Stream Deck key)
   */
  function lookOf(scene, over) {
    const pick = (a, b) => (a && a !== 'auto' ? a : b && b !== 'auto' ? b : null);
    const glyph = pick(over && over.icon, scene && scene.icon) || guessGlyph(scene && scene.name);
    const color = pick(over && over.color, scene && scene.color) || DEFAULT_COLOR[glyph] || 'blue';
    return { glyph: GLYPHS[glyph] ? glyph : 'monitor', color: COLORS[color] ? color : 'blue' };
  }

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);
  let seq = 0;

  /**
   * SVG of a tile.
   * @param look  { glyph, color }
   * @param opts  { label?: text under the drawing, dim?: darken, size?: px }
   */
  function tileSvg(look, opts) {
    const o = opts || {};
    const [top, bottom] = COLORS[look.color] || COLORS.blue;
    const id = 'ss' + (++seq).toString(36);
    let text = o.label != null ? String(o.label).trim() : null;
    // without a label, the drawing is centered vertically
    const vb = text == null ? '0 -10 144 144' : '0 0 144 144';
    let label = '';
    if (text != null) {
      if (text.length > 16) text = text.slice(0, 15) + '…';
      const fs = text.length <= 8 ? 22 : text.length <= 11 ? 19 : 16;
      label = `<text x="72" y="126" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="600" font-size="${fs}" fill="#fff">${esc(text)}</text>`;
    }
    const size = o.size ? ` width="${o.size}" height="${o.size}"` : ' width="144" height="144"';
    const y0 = text == null ? -10 : 0;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"${size}>` +
      `<defs><linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>` +
      `<radialGradient id="${id}h" cx="0.5" cy="0" r="0.9"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>` +
      `<rect y="${y0}" width="144" height="144" fill="url(#${id}g)"/><rect y="${y0}" width="144" height="144" fill="url(#${id}h)"/>` +
      `<g fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[look.glyph] || GLYPHS.monitor}</g>` +
      label + (o.dim ? `<rect y="${y0}" width="144" height="144" fill="#000" fill-opacity=".55"/>` : '') +
      '</svg>';
  }

  return { GLYPHS, GLYPH_NAMES, COLORS, COLOR_NAMES, DEFAULT_COLOR, guessGlyph, lookOf, tileSvg };
});
