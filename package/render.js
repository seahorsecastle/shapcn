// Morphicon renderer (round 6, fill entries in round 7, styled stroke entries in round 7b, plan width and caps in round 9b). Pure: no DOM in entriesToSVG. renderInto is a small DOM helper.
// It draws the entries of plan.frame(t) back to front, and hides the parts that go behind a closed shape.

const RN_NS = 'http://www.w3.org/2000/svg';
const RN_BOX = { x: -24, y: -24, w: 72, h: 72 }; // the mask area: well past the 24 x 24 viewBox
let rnCounter = 0;

const rnNum = (x) => String(Math.round(x * 1000) / 1000);

// Back to front: depth up, then key. Returns a new array.
function rnOrder(entries) {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.depth || 0) - (b.e.depth || 0) || a.i - b.i)
    .map((x) => x.e);
}

// For each entry of the sorted list: the entries in front of it that may hide it (mask mode).
// R10-2: with `twinOnly` (the option is 'none' but the plan has a closed twin) only the twin pairs of the plan hide anything.
function rnHiders(sorted, plan, o) {
  const out = sorted.map(() => []);
  const test = o.twinOnly && plan && typeof plan.twinOccludes === 'function' ? plan.twinOccludes : plan && plan.occludes;
  if (o.occlusion === 'none' || typeof test !== 'function') return out;
  for (let k = 0; k < sorted.length; k++) {
    const e = sorted[k];
    for (let m = k + 1; m < sorted.length; m++) {
      const f = sorted[m];
      if (!f.occluder || f.slot === e.slot) continue;
      if ((f.depth || 0) <= (e.depth || 0)) continue;
      if (test(f.slot, e.slot)) out[k].push(f);
    }
  }
  return out;
}

const rnMode = (m) => (m === 'mask' || m === 'fill' || m === 'none' ? m : null);

// Round 7: a missing `occlusion` option falls back to plan.occlusion (default 'none'), not to 'mask'.
function rnOptions(opts, plan) {
  const o = opts || {};
  let occlusion = rnMode(o.occlusion) || rnMode(plan && plan.occlusion) || 'none';
  // R10-2: a plan with a closed twin (`plan.masks`) always draws masks for its twin pairs, also with the option 'none'.
  const twinOnly = occlusion === 'none' && !!plan && plan.masks === true;
  if (twinOnly) occlusion = 'mask';
  return {
    occlusion,
    twinOnly,
    idPrefix: o.idPrefix || 'mo',
    strokeWidth: o.strokeWidth == null ? 2 : o.strokeWidth,
    baseWidth: o.baseWidth > 0 ? o.baseWidth : null,
    linecap: o.linecap || 'round',
    linejoin: o.linejoin || 'round',
    bg: o.bg || null,
  };
}

const rnFillValue = (o) => o.bg || 'var(--morph-bg, #fff)';

// Round 7b: two kinds of entry have `fill: true`.
//  - a region entry (a fill family: `region: true`, or any `fill` entry of a fill plan): fill currentColor, no stroke, nonzero rule;
//  - a styled stroke entry (a stroke family: an element with fill="currentColor"): fill and stroke, both currentColor,
//    with the stroke width of the entry (`strokeWidth`, 24-grid units). `fill: true` with `strokeWidth: 0` is fill only.
const rnIsRegion = (e, plan) => !!e.fill && (e.region === true || (!!plan && plan.fill === true));

// Does a stroke entry draw no stroke? (fill only)
const rnFillOnly = (e) => !!e.fill && e.strokeWidth === 0;

// R9b: the stroke width of a stroke entry in 24-grid units, absolute. An entry with its own width (`strokeWidth` > 0)
// draws exactly that width (the width already includes any width change over time, so `widthScale` is not applied again).
// Else the base width times `widthScale`. The base is `opts.baseWidth`, else `plan.strokeWidth` (the width of the plan's
// own family), else the wrapper width (`opts.strokeWidth`, default 2).
function rnWidth(e, plan, o) {
  if (e.strokeWidth > 0) return e.strokeWidth;
  const base = o.baseWidth || (plan && plan.strokeWidth > 0 ? plan.strokeWidth : o.strokeWidth);
  return base * (Number.isFinite(e.widthScale) ? e.widthScale : 1);
}

// The stroke-width attribute of a stroke entry, or null when the wrapper width (`opts.strokeWidth`) is right.
function rnWidthAttr(e, plan, o) {
  const w = rnWidth(e, plan, o);
  return Math.abs(w - o.strokeWidth) < 0.0005 ? null : rnNum(w);
}

// R9b: the cap and join attributes of a stroke entry, or null when the wrapper (`opts.linecap`, `opts.linejoin`, default round) is right.
const rnCap = (plan, o) => (plan && plan.linecap && plan.linecap !== o.linecap ? plan.linecap : null);
const rnJoin = (plan, o) => (plan && plan.linejoin && plan.linejoin !== o.linejoin ? plan.linejoin : null);

/**
 * The inner SVG markup of one frame. Put it inside an <svg viewBox="0 0 24 24"> that has the Lucide stroke
 * attributes (fill none, stroke, stroke-width, round caps and joins).
 * @param {{d: string, opacity: number, widthScale: number, key: number, slot: number, depth?: number, occluder?: boolean}[]} entries plan.frame(t)
 * @param {{occludes?: Function}} plan The plan that made the entries.
 * @param {{occlusion?: 'mask'|'fill'|'none', idPrefix?: string, strokeWidth?: number, baseWidth?: number, linecap?: string, linejoin?: string, bg?: string}} [opts]
 *   A missing `occlusion` uses `plan.occlusion` (default 'none'). A region entry (`fill: true, region: true`, or any fill
 *   entry of a plan with `plan.fill`) is drawn with fill currentColor, no stroke, and the nonzero rule. A stroke entry
 *   with `fill: true` is a filled stroke: fill and stroke, both currentColor; `strokeWidth: 0` there means fill only
 *   (stroke none). R9b: a stroke entry with `strokeWidth` > 0 draws exactly that width (24-grid units, absolute).
 *   Otherwise it draws `widthScale` times the base width: `opts.baseWidth`, else `plan.strokeWidth` (when above 0), else
 *   `opts.strokeWidth`. A path gets a `stroke-width` attribute only when its width differs from `opts.strokeWidth`.
 *   `plan.linecap` and `plan.linejoin` (round when missing) go on a path only when they differ from `opts.linecap` and
 *   `opts.linejoin` (default round). Put the same values on the wrapper svg.
 *   `idPrefix` makes the mask ids unique (use a different one for each svg on a page). `strokeWidth` is the stroke
 *   width of the wrapper svg (2). `baseWidth` overrides the base width. `bg` is a plain color for 'fill' mode
 *   (default `var(--morph-bg, #fff)`).
 * @returns {string}
 */
export function entriesToSVG(entries, plan, opts) {
  const o = rnOptions(opts, plan);
  const sorted = rnOrder(entries);
  const hiders = rnHiders(sorted, plan, o);
  let defs = '';
  let body = '';
  for (let k = 0; k < sorted.length; k++) {
    const e = sorted[k];
    let attrs = ' d="' + e.d + '"';
    if (e.opacity < 1) attrs += ' opacity="' + rnNum(e.opacity) + '"';
    if (rnIsRegion(e, plan)) {
      // R7: a fill entry (a region of a fill family). No stroke, no mask, no occlusion fill.
      body += '<path' + attrs + ' fill="currentColor" stroke="none" fill-rule="nonzero"/>';
      continue;
    }
    if (e.fill) attrs += rnFillOnly(e) ? ' fill="currentColor" stroke="none"' : ' fill="currentColor"';
    const wa = rnWidthAttr(e, plan, o);
    if (wa !== null && !rnFillOnly(e)) attrs += ' stroke-width="' + wa + '"';
    if (!rnFillOnly(e)) {
      const lc = rnCap(plan, o);
      const lj = rnJoin(plan, o);
      if (lc) attrs += ' stroke-linecap="' + lc + '"';
      if (lj) attrs += ' stroke-linejoin="' + lj + '"';
    }
    if (o.occlusion === 'mask' && hiders[k].length) {
      const id = o.idPrefix + '-' + e.key;
      defs +=
        '<mask id="' + id + '" maskUnits="userSpaceOnUse" x="' + RN_BOX.x + '" y="' + RN_BOX.y + '" width="' + RN_BOX.w + '" height="' + RN_BOX.h + '">' +
        '<rect x="' + RN_BOX.x + '" y="' + RN_BOX.y + '" width="' + RN_BOX.w + '" height="' + RN_BOX.h + '" fill="#fff" stroke="none"/>' +
        hiders[k].map((f) => '<path d="' + (f.maskD || f.d) + '" fill="#000" stroke="none"/>').join('') +
        '</mask>';
      attrs += ' mask="url(#' + id + ')"';
    } else if (o.occlusion === 'fill' && e.occluder && !e.fill && rnHidesAny(sorted, k, plan)) {
      attrs += ' style="fill:' + rnFillValue(o) + '"';
    }
    body += '<path' + attrs + '/>';
  }
  return (defs ? '<defs>' + defs + '</defs>' : '') + body;
}

// 'fill' mode: an occluder gets the background fill only when it may hide an entry behind it.
function rnHidesAny(sorted, k, plan) {
  if (!plan || typeof plan.occludes !== 'function') return false;
  const f = sorted[k];
  for (let m = 0; m < k; m++) {
    const e = sorted[m];
    if (e.slot !== f.slot && (e.depth || 0) < (f.depth || 0) && plan.occludes(f.slot, e.slot)) return true;
  }
  return false;
}

const rnEl = (name) => document.createElementNS(RN_NS, name);

function rnState(svg, o) {
  let st = svg._morphRender;
  if (st && st.defs.parentNode === svg) return st;
  // First call, or something else changed the children (for example a rest render): start clean.
  svg.innerHTML = '';
  const defs = rnEl('defs');
  svg.appendChild(defs);
  st = { defs, paths: [], masks: [], prefix: o.idPrefix === 'mo' ? 'mo' + ++rnCounter : o.idPrefix };
  svg._morphRender = st;
  return st;
}

function rnSet(el, name, value) {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/**
 * Draw entries into an <svg> element and reuse its child elements. The svg keeps one <defs> and a pool of
 * <path> elements. Call it again for every frame.
 * @param {SVGElement} svgEl
 * @param {Array} entries plan.frame(t)
 * @param {{occludes?: Function}} plan
 * @param {{occlusion?: 'mask'|'fill'|'none', idPrefix?: string, strokeWidth?: number, baseWidth?: number, linecap?: string, linejoin?: string, bg?: string}} [opts]
 */
export function renderInto(svgEl, entries, plan, opts) {
  const o = rnOptions(opts, plan);
  const st = rnState(svgEl, o);
  const sorted = rnOrder(entries);
  const hiders = rnHiders(sorted, plan, o);
  let nMask = 0;
  for (let k = 0; k < sorted.length; k++) {
    const e = sorted[k];
    let p = st.paths[k];
    if (!p) {
      p = rnEl('path');
      st.paths[k] = p;
      svgEl.appendChild(p);
    } else if (p.style.display === 'none') p.style.display = '';
    p.setAttribute('d', e.d);
    rnSet(p, 'opacity', e.opacity < 1 ? rnNum(e.opacity) : null);
    if (rnIsRegion(e, plan)) {
      // R7: a fill entry. The pooled element may have drawn a stroke before, so set every attribute.
      rnSet(p, 'fill', 'currentColor');
      rnSet(p, 'stroke', 'none');
      rnSet(p, 'fill-rule', 'nonzero');
      rnSet(p, 'stroke-width', null);
      rnSet(p, 'stroke-linecap', null);
      rnSet(p, 'stroke-linejoin', null);
      rnSet(p, 'mask', null);
      p.style.fill = '';
      continue;
    }
    // A stroke entry; round 7b: a styled one (`fill: true`) also fills with currentColor. The pooled element may have
    // drawn something else before, so set every attribute.
    rnSet(p, 'fill', e.fill ? 'currentColor' : null);
    rnSet(p, 'stroke', rnFillOnly(e) ? 'none' : null);
    rnSet(p, 'fill-rule', null);
    rnSet(p, 'stroke-width', rnFillOnly(e) ? null : rnWidthAttr(e, plan, o));
    rnSet(p, 'stroke-linecap', rnFillOnly(e) ? null : rnCap(plan, o));
    rnSet(p, 'stroke-linejoin', rnFillOnly(e) ? null : rnJoin(plan, o));
    let maskRef = null;
    let fill = '';
    if (o.occlusion === 'mask' && hiders[k].length) {
      let m = st.masks[nMask];
      if (!m) {
        const el = rnEl('mask');
        el.setAttribute('id', st.prefix + '-m' + nMask);
        el.setAttribute('maskUnits', 'userSpaceOnUse');
        el.setAttribute('x', String(RN_BOX.x));
        el.setAttribute('y', String(RN_BOX.y));
        el.setAttribute('width', String(RN_BOX.w));
        el.setAttribute('height', String(RN_BOX.h));
        const r = rnEl('rect');
        r.setAttribute('x', String(RN_BOX.x));
        r.setAttribute('y', String(RN_BOX.y));
        r.setAttribute('width', String(RN_BOX.w));
        r.setAttribute('height', String(RN_BOX.h));
        r.setAttribute('fill', '#fff');
        r.setAttribute('stroke', 'none');
        el.appendChild(r);
        st.defs.appendChild(el);
        m = { el, paths: [] };
        st.masks[nMask] = m;
      }
      const list = hiders[k];
      for (let h = 0; h < list.length; h++) {
        let mp = m.paths[h];
        if (!mp) {
          mp = rnEl('path');
          mp.setAttribute('fill', '#000');
          mp.setAttribute('stroke', 'none');
          m.el.appendChild(mp);
          m.paths[h] = mp;
        } else if (mp.style.display === 'none') mp.style.display = '';
        mp.setAttribute('d', list[h].maskD || list[h].d);
      }
      for (let h = list.length; h < m.paths.length; h++) m.paths[h].style.display = 'none';
      maskRef = 'url(#' + st.prefix + '-m' + nMask + ')';
      nMask++;
    } else if (o.occlusion === 'fill' && e.occluder && !e.fill && rnHidesAny(sorted, k, plan)) {
      fill = rnFillValue(o);
    }
    rnSet(p, 'mask', maskRef);
    p.style.fill = fill;
  }
  for (let k = sorted.length; k < st.paths.length; k++) {
    if (st.paths[k].style.display !== 'none') st.paths[k].style.display = 'none';
  }
}
