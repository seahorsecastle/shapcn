// The popup. Plain DOM. Each menu row shows its style on a small live icon, drawn by the shapcn engine.
import { registerIcons, defineMorphIcon, HOVER_STYLES, PRESS_STYLES, iconToSVG } from './engine.js';
import { heart, thumbsUp, shapes } from '../../package/lucide.js';

const DEFAULTS = { enabled: true, hover: 'wiggle', click: 'pop', strength: 1.5, offSites: [] };
const LABEL = { none: 'None', wiggle: 'Wiggle', grow: 'Grow', bend: 'Bend', bold: 'Bold', cascade: 'Cascade', move: 'Move', pop: 'Pop', squash: 'Squash', 'squat-jump': 'Squat jump', burst: 'Burst' };
let cur = { ...DEFAULTS };
// `?host=name` sets the site by hand (used when the popup is opened as a plain page, for example in tests).
let host = TEST_HOOKS ? new URLSearchParams(location.search).get('host') || '' : ''; // the ?host= override is for tests only

registerIcons({ heart, 'thumbs-up': thumbsUp });
defineMorphIcon();
const $ = (id) => document.getElementById(id);

// the shapcn mark: Lucide `shapes`, ink on yellow
$('mark').innerHTML = iconToSVG(shapes, { size: 18, color: '#14130F' });

function icon(name, attrs) {
  const el = document.createElement('morph-icon');
  el.setAttribute('name', name);
  el.setAttribute('size', '20');
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}

// Save to chrome.storage.sync. Every field has a revision that counts the edits you made. A failed write shows a message,
// reads what is stored, and puts that value back only into fields you have not edited since that save started.
const rev = {};
function fail(e, snap) {
  $('status').textContent = 'Could not save: ' + ((e && e.message) || 'storage error') + '.';
  const readFail = (err) => {
    $('status').textContent = 'Could not save, and could not read the saved settings: ' + ((err && err.message) || 'storage error') + '.';
  };
  try {
    chrome.storage.sync.get(DEFAULTS, (v) => {
      if (chrome.runtime.lastError) return readFail(chrome.runtime.lastError);
      for (const k of Object.keys(snap)) if (rev[k] === snap[k]) cur[k] = v[k] === undefined ? DEFAULTS[k] : v[k];
      refresh();
    });
  } catch (err) {
    readFail(err);
  }
}
function save(patch) {
  const snap = {};
  for (const k of Object.keys(patch)) {
    rev[k] = (rev[k] || 0) + 1;
    snap[k] = rev[k];
  }
  Object.assign(cur, patch);
  try {
    Promise.resolve(chrome.storage.sync.set(patch)).catch((e) => fail(e, snap));
  } catch (e) {
    fail(e, snap);
  }
}

function buildMenu(kind) {
  const list = kind === 'hover' ? HOVER_STYLES : PRESS_STYLES;
  const menu = $(kind + '-menu');
  menu.textContent = '';
  for (const v of ['none', ...list]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'opt';
    b.setAttribute('role', 'option');
    b.dataset.value = v;
    b.setAttribute('aria-selected', String(cur[kind] === v));
    b.tabIndex = cur[kind] === v ? 0 : -1; // one tab stop: the chosen option. Arrow keys move inside the list.
    const ic = document.createElement('span');
    ic.className = 'ic';
    const attrs = v === 'none' ? {} : kind === 'hover' ? { hover: v, 'hover-strength': cur.strength } : { press: v, 'press-strength': cur.strength };
    ic.appendChild(icon(kind === 'hover' ? 'heart' : 'thumbs-up', attrs));
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = LABEL[v];
    b.append(ic, nm);
    b.addEventListener('click', () => {
      save({ [kind]: v });
      refresh();
      toggle(kind, false);
      $(kind).focus();
    });
    menu.appendChild(b);
  }
  if (!menu.querySelector('[tabindex="0"]')) menu.firstElementChild.tabIndex = 0;
}

function focusOption(menu, opt) {
  for (const o of menu.querySelectorAll('.opt')) o.tabIndex = o === opt ? 0 : -1;
  opt.focus();
}
for (const kind of ['hover', 'click']) {
  $(kind + '-menu').addEventListener('keydown', (e) => {
    const menu = e.currentTarget;
    const opts = Array.from(menu.querySelectorAll('.opt'));
    const i = opts.indexOf(document.activeElement);
    let n = -1;
    if (e.key === 'ArrowDown') n = Math.min(opts.length - 1, i + 1);
    else if (e.key === 'ArrowUp') n = Math.max(0, i - 1);
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = opts.length - 1;
    else if (e.key === 'Escape') {
      e.stopPropagation();
      toggle(kind, false);
      $(kind).focus();
      return;
    } else return;
    e.preventDefault();
    if (n >= 0 && opts[n]) focusOption(menu, opts[n]);
  });
}

function toggle(kind, open) {
  const menu = $(kind + '-menu');
  const want = open === undefined ? menu.hidden : open;
  for (const k of ['hover', 'click']) {
    $(k + '-menu').hidden = !(want && k === kind);
    $(k).setAttribute('aria-expanded', String(want && k === kind));
  }
  if (want) {
    buildMenu(kind);
    const sel = menu.querySelector('[aria-selected="true"]');
    if (sel) sel.focus();
  }
}

function refresh() {
  $('enabled').checked = !!cur.enabled;
  $('siteoff').checked = host ? cur.offSites.includes(host) : false;
  $('siteoff').disabled = !host;
  $('host').textContent = host || 'No page (open a website tab)';
  $('hover').querySelector('.cur').textContent = LABEL[cur.hover] || cur.hover;
  $('click').querySelector('.cur').textContent = LABEL[cur.click] || cur.click;
  $('strength').value = String(cur.strength);
  $('sval').textContent = Number(cur.strength).toFixed(1);
  const t = $('try');
  t.textContent = '';
  const attrs = { size: '22', 'hover-strength': cur.strength, 'press-strength': cur.strength };
  attrs.hover = cur.hover !== 'none' ? cur.hover : 'grow';
  attrs.press = cur.click !== 'none' ? cur.click : 'pop';
  t.appendChild(icon('heart', attrs));
}

$('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
$('siteoff').addEventListener('change', (e) => {
  if (!host) return;
  const set = new Set(cur.offSites);
  if (e.target.checked) set.add(host);
  else {
    set.delete(host);
    set.delete(host.replace(/^www\./, ''));
  }
  save({ offSites: [...set] });
});
for (const k of ['hover', 'click']) $(k).addEventListener('click', () => toggle(k));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    for (const k of ['hover', 'click']) {
      if (!$(k + '-menu').hidden) {
        toggle(k, false);
        $(k).focus();
      }
    }
  }
});
// The slider: while it moves, only the preview changes. The value is saved when the drag ends (change), or 400 ms after the last move.
let strengthTimer = 0;
$('strength').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  cur.strength = v;
  rev.strength = (rev.strength || 0) + 1; // an edit: a late failure of an older save must not overwrite it
  $('sval').textContent = v.toFixed(1);
  for (const el of document.querySelectorAll('morph-icon')) {
    if (el.hasAttribute('hover-strength')) el.setAttribute('hover-strength', String(v));
    if (el.hasAttribute('press-strength')) el.setAttribute('press-strength', String(v));
  }
  clearTimeout(strengthTimer);
  strengthTimer = setTimeout(() => save({ strength: v }), 400); // the value of this move, kept in the pending save
});
$('strength').addEventListener('change', (e) => {
  clearTimeout(strengthTimer);
  save({ strength: Number(e.target.value) });
});

try {
  chrome.storage.sync.get(DEFAULTS, (v) => {
    cur = { ...DEFAULTS, ...v };
    refresh();
  });
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || tab.id == null) return;
    chrome.tabs.sendMessage(tab.id, { type: 'shapcn:info' }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      host = host || res.hostname || '';
      refresh();
      $('status').textContent = res.icons === 1 ? '1 icon on this page can come alive.' : res.icons + ' icons on this page can come alive.';
    });
  });
} catch (e) {
  refresh();
}
refresh();
