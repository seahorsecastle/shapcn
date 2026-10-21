// registerSVGs: parse plain SVG markup into the engine's icon format and register it.
import { registerIcons, registerFamily } from './core.js';

const SHAPES = new Set(['path', 'line', 'polyline', 'polygon', 'circle', 'ellipse', 'rect']);
const DROP = new Set(['class', 'id', 'style', 'xmlns', 'xml:space', 'transform-origin']);
const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

// Split the arguments of a path command. Arc flags may be written without separators ("00-2"). Returns null when the text is not numbers.
function argsOf(cmd, str) {
  const out = [];
  const isArc = cmd === 'A' || cmd === 'a';
  const sep = /^[\s,]*/;
  let i = 0;
  for (;;) {
    i += sep.exec(str.slice(i))[0].length;
    if (i >= str.length) return out;
    const p = isArc ? out.length % 7 : -1;
    if (p === 3 || p === 4) {
      if (str[i] !== '0' && str[i] !== '1') return null;
      out.push(str[i]);
      i++;
      continue;
    }
    const m = new RegExp('^' + NUM.source).exec(str.slice(i));
    if (!m) return null;
    out.push(m[0]);
    i += m[0].length;
  }
}

function fmt(n) {
  return String(Math.round(n * 1e4) / 1e4);
}

// Scale the numbers of a path `d` by k. Arc flags and the arc rotation are not scaled.
function scalePath(d, k) {
  const out = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([^MmLlHhVvCcSsQqTtAaZz]+)/g;
  let cmd = '';
  let m;
  while ((m = re.exec(d))) {
    if (m[1]) {
      cmd = m[1];
      out.push(cmd);
      continue;
    }
    const nums = argsOf(cmd, m[2]) || [];
    if (cmd === 'A' || cmd === 'a') {
      const sc = [];
      for (let i = 0; i < nums.length; i++) {
        const p = i % 7; // rx ry rot large sweep x y
        sc.push(p === 2 || p === 3 || p === 4 ? nums[i] : fmt(Number(nums[i]) * k));
      }
      out.push(sc.join(' '));
    } else {
      out.push(nums.map((x) => fmt(Number(x) * k)).join(' '));
    }
  }
  return out.join('');
}

const LENGTH_ATTRS = new Set(['cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'stroke-width']);

function scaleAttrs(tag, attrs, k) {
  if (k === 1) return attrs;
  const o = {};
  for (const key of Object.keys(attrs)) {
    const v = attrs[key];
    if (key === 'd' && tag === 'path') o[key] = scalePath(v, k);
    else if (key === 'points') o[key] = (v.match(NUM) || []).map((x) => fmt(Number(x) * k)).join(' ');
    else if (LENGTH_ATTRS.has(key) && Number.isFinite(Number(v))) o[key] = fmt(Number(v) * k);
    else o[key] = v;
  }
  return o;
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
  return attrs;
}

const ARGS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

// Throws when `d` is not a valid path (bad character, no leading M, wrong number of arguments).
function checkPath(d, name) {
  const bad = (why) => {
    throw new Error('registerSVGs: icon "' + name + '" has an invalid path "' + d + '" (' + why + ').');
  };
  if (/[^MmLlHhVvCcSsQqTtAaZz0-9eE.,+\s-]/.test(d)) bad('unexpected character');
  const re = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  if (!/^\s*[Mm]/.test(d)) bad('must start with M');
  let m;
  let seen = 0;
  while ((m = re.exec(d))) {
    seen++;
    const need = ARGS[m[1].toUpperCase()];
    const list = argsOf(m[1].toUpperCase(), m[2]);
    if (!list) bad('bad number');
    const count = list.length;
    if (need === 0 ? count !== 0 : count === 0 || count % need !== 0) bad('wrong number of values for ' + m[1]);
  }
  if (!seen) bad('no commands');
}

const f = (v) => fmt(Number(v) || 0);

// A fill icon is a set of path elements. Convert the other shapes to the same form.
function shapeToPath(tag, a) {
  const keep = {};
  const GEO = new Set(['cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'points', 'x1', 'y1', 'x2', 'y2']);
  for (const k of Object.keys(a)) if (!GEO.has(k)) keep[k] = a[k];
  let d = '';
  if (tag === 'circle' || tag === 'ellipse') {
    const cx = Number(a.cx) || 0;
    const cy = Number(a.cy) || 0;
    const rx = Number(tag === 'circle' ? a.r : a.rx !== undefined ? a.rx : a.ry);
    const ry = Number(tag === 'circle' ? a.r : a.ry !== undefined ? a.ry : a.rx);
    if (!(rx > 0 && ry > 0)) return null;
    d = 'M' + f(cx - rx) + ' ' + f(cy) + 'a' + f(rx) + ' ' + f(ry) + ' 0 1 0 ' + f(2 * rx) + ' 0a' + f(rx) + ' ' + f(ry) + ' 0 1 0 ' + f(-2 * rx) + ' 0z';
  } else if (tag === 'rect') {
    const x = Number(a.x) || 0;
    const y = Number(a.y) || 0;
    const w = Number(a.width);
    const h = Number(a.height);
    if (!(w > 0 && h > 0)) return null;
    let rx = a.rx !== undefined ? Number(a.rx) : a.ry !== undefined ? Number(a.ry) : 0;
    let ry = a.ry !== undefined ? Number(a.ry) : rx;
    rx = Math.min(Math.max(rx, 0), w / 2);
    ry = Math.min(Math.max(ry, 0), h / 2);
    if (rx > 0 && ry > 0) {
      d = 'M' + f(x + rx) + ' ' + f(y) + 'h' + f(w - 2 * rx) + 'a' + f(rx) + ' ' + f(ry) + ' 0 0 1 ' + f(rx) + ' ' + f(ry) + 'v' + f(h - 2 * ry) + 'a' + f(rx) + ' ' + f(ry) + ' 0 0 1 ' + f(-rx) + ' ' + f(ry) + 'h' + f(-(w - 2 * rx)) + 'a' + f(rx) + ' ' + f(ry) + ' 0 0 1 ' + f(-rx) + ' ' + f(-ry) + 'v' + f(-(h - 2 * ry)) + 'a' + f(rx) + ' ' + f(ry) + ' 0 0 1 ' + f(rx) + ' ' + f(-ry) + 'z';
    } else {
      d = 'M' + f(x) + ' ' + f(y) + 'h' + f(w) + 'v' + f(h) + 'h' + f(-w) + 'z';
    }
  } else if (tag === 'polygon' || tag === 'polyline') {
    const p = (a.points || '').match(NUM) || [];
    if (p.length < 6) return null;
    d = 'M' + p.slice(0, 2).join(' ');
    for (let i = 2; i + 1 < p.length; i += 2) d += 'L' + p[i] + ' ' + p[i + 1];
    d += 'z';
  } else {
    return null; // a line has no area
  }
  keep.d = d;
  return ['path', keep];
}

/** Parse one SVG string to { nodes, viewBox } (nodes in the 24 grid). */
export function parseSVG(markup, name = '?', kind = 'stroke') {
  const root = /<svg\b([^>]*)>/i.exec(markup);
  if (!root) throw new Error('registerSVGs: no <svg> element.');
  const rootAttrs = parseAttrs(root[1]);
  let vb = [0, 0, 24, 24];
  if (rootAttrs.viewBox) {
    vb = rootAttrs.viewBox.trim().split(/[\s,]+/).map(Number);
  } else if (rootAttrs.width && rootAttrs.height) {
    vb = [0, 0, parseFloat(rootAttrs.width), parseFloat(rootAttrs.height)];
  }
  if (vb.length !== 4 || !vb.every(Number.isFinite) || !(vb[2] > 0)) throw new Error('registerSVGs: bad viewBox.');
  if (vb[0] !== 0 || vb[1] !== 0) throw new Error('registerSVGs: a viewBox with a non-zero origin is not supported.');
  const k = 24 / vb[2];
  const body = markup.slice(root.index + root[0].length).replace(/<!--[\s\S]*?-->/g, '').replace(/<(defs|title|desc|style|metadata)\b[\s\S]*?<\/\1>/gi, '');
  const nodes = [];
  const re = /<([A-Za-z]+)\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(body))) {
    const tag = m[1].toLowerCase();
    if (!SHAPES.has(tag)) continue;
    const raw = parseAttrs(m[2]);
    const attrs = {};
    for (const key of Object.keys(raw)) if (!DROP.has(key) && !key.startsWith('data-')) attrs[key] = raw[key];
    if (tag === 'path') checkPath(attrs.d || '', name);
    const node = [tag, scaleAttrs(tag, attrs, k)];
    if (kind === 'fill') {
      const p = tag === 'path' ? node : shapeToPath(tag, node[1]);
      if (p) nodes.push(p);
    } else {
      nodes.push(node);
    }
  }
  if (!nodes.length) throw new Error('registerSVGs: no drawable element (path, line, polyline, polygon, circle, ellipse, rect).');
  return { nodes, viewBox: vb, strokeWidth: rootAttrs['stroke-width'] !== undefined ? Number(rootAttrs['stroke-width']) * k : undefined };
}

/**
 * Register your own SVG icons.
 * `kind: 'stroke'` (default): outline icons on a 24 grid with stroke width 2. Names stay as given, the same as Lucide names.
 *   With `family: 'my-set'` the names become `my-set:<name>` and `strokeWidth`, `linecap`, `linejoin` apply to that family.
 * `kind: 'fill'`: solid icons. Names become `<family>:<name>` (default family `svg`).
 * @param {Object<string, string>} svgs  name to SVG markup
 * @param {{kind?: 'stroke'|'fill', family?: string, strokeWidth?: number, linecap?: string, linejoin?: string}} [opts]
 * @returns {string[]} the registered names
 */
export function registerSVGs(svgs, opts = {}) {
  if (!svgs || typeof svgs !== 'object' || Array.isArray(svgs)) throw new Error('registerSVGs expects an object of { name: svgString }');
  if (opts.kind !== undefined && opts.kind !== 'stroke' && opts.kind !== 'fill') throw new Error("registerSVGs: kind must be 'stroke' or 'fill' (got '" + opts.kind + "').");
  const kind = opts.kind === 'fill' ? 'fill' : 'stroke';
  const icons = {};
  let sw;
  for (const name of Object.keys(svgs)) {
    const p = parseSVG(String(svgs[name]), name, kind);
    icons[name] = p.nodes;
    if (sw === undefined) sw = p.strokeWidth;
  }
  const family = opts.family || (kind === 'fill' ? 'svg' : '');
  if (!family) {
    registerIcons(icons);
    return Object.keys(icons);
  }
  registerFamily({
    id: family,
    kind,
    viewBox: '0 0 24 24',
    strokeWidth: kind === 'fill' ? 0 : opts.strokeWidth ?? (Number.isFinite(sw) ? sw : 2),
    linecap: opts.linecap,
    linejoin: opts.linejoin,
    icons,
  });
  return Object.keys(icons).map((n) => family + ':' + n);
}
