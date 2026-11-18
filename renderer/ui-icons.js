// UI icons (strokes, 24×24, color = currentColor)
const UI_ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>',
  play: '<path d="M8 5l11 7-11 7z"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8"/>',
  speaker: '<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
  palette: '<path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.5-.8 1.5-1.5 0-1.2-1-1.5-1-2.5 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.1-4-7.5-9-7.5z"/><path d="M7.5 11h.01M10 7.5h.01M14.5 7.5h.01"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  zap: '<path d="M13 3L4 14h7l-1 7 9-11h-7z"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  wand: '<path d="M4 20L15 9M14 4v2M19 9h2M18.5 5.5L17 7M10 4.5l.5 1.5M19.5 13.5L18 13"/><path d="M13 7l4 4"/>',
};

function uiIcon(name) {
  return `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${UI_ICONS[name] || ''}</svg>`;
}

// <button data-icon="plus">Text</button> → icon inserted before the text
function applyUiIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (!el.querySelector(':scope > svg.i')) el.insertAdjacentHTML('afterbegin', uiIcon(el.dataset.icon));
  }
}
