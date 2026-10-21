// Morphicon entry point. Re-exports the core and the DOM layer, and wires the fill planner (R7-B) into the core.
import * as core from './core.js';
import { registerIcons } from './core.js';
import { planFill, planFillEffect, setIconResolver, regionsOf } from './regions.js';
import { planEffect } from './effects.js';
import { FAMILY_META } from './families-meta.js';

export * from './core.js';
export * from './render.js';
export * from './effects.js';
export * from './dom.js';
export { planAlive } from './effects.js';
export { alive } from './dom.js';
export { registerSVGs } from './svg.js';
export { planFill, planFillEffect, setIconResolver, regionsOf, parsePath, FILL_DEFAULTS } from './regions.js';

/** Load the 1,858 Lucide icons into the registry. */
export async function registerLucide() {
  const mod = await import('./lucide.js');
  registerIcons(mod.default);
  return mod.default;
}

/**
 * Register a family file of `data/families/` (an object, or its JSON text): `{ id, family, style, kind, viewBox,
 * strokeWidth, icons }`. Names are then `<id>:<name>`. Returns what `registerFamily` of the core returns.
 * @param {string|Object} json
 */
export function registerFamilyFile(json) {
  const fam = typeof json === 'string' ? JSON.parse(json) : json;
  if (!fam || !fam.id || !fam.icons) throw new Error('registerFamilyFile: expected { id, kind, viewBox, strokeWidth, icons }.');
  if (typeof core.registerFamily !== 'function') throw new Error('registerFamilyFile: core.js has no registerFamily yet.');
  return core.registerFamily(fam);
}

/**
 * Register only some icons of a family. `family` is a family id of the package (`'tabler-outline'`, `'phosphor-regular-s'`, ...)
 * or a family spec without icons. `icons` maps a name to what the family module exports for it. Names are then `<id>:<name>`.
 *   import { bell, bellOff } from 'shape-aware-morph/tabler-outline';
 *   registerFamilyIcons('tabler-outline', { bell, 'bell-off': bellOff });
 */
export function registerFamilyIcons(family, icons) {
  const meta = typeof family === 'string' ? FAMILY_META[family] : family;
  if (!meta || !meta.id) throw new Error('registerFamilyIcons: unknown family "' + family + '". Known: ' + Object.keys(FAMILY_META).join(', ') + '.');
  if (!icons || typeof icons !== 'object') throw new Error('registerFamilyIcons: icons must be an object of name to icon.');
  return core.registerFamily({ ...meta, icons });
}

// ---------------------------------------------------------------------------
// R7-B: the cross planner. A stroke icon to a fill icon (or the reverse) is not a morph yet: the old icon implodes
// over [0, 0.5] and the new icon expands over [0.5, 1]. The plan has the plan API and `crossKind = true`.
// ---------------------------------------------------------------------------

// 'stroke' or 'fill' for a name, an icon node, an icon info, or a snapshot. Also the family stroke width (stroke only).
function sideInfo(src) {
  if (src && src.kind === 'snapshot') return { kind: src.fill || (src.family && src.family.kind === 'fill') ? 'fill' : 'stroke', strokeWidth: 0 };
  if (Array.isArray(src)) return { kind: 'stroke', strokeWidth: 0 };
  let info = null;
  if (src && src.nodes) info = src;
  else if (typeof src === 'string' && typeof core.getIconInfo === 'function') info = core.getIconInfo(src);
  const fam = (info && info.family) || {};
  return { kind: fam.kind === 'fill' ? 'fill' : 'stroke', strokeWidth: fam.strokeWidth > 0 ? fam.strokeWidth : 0 };
}

function halfPlan(src, dir, opts, effect = 'implode') {
  const side = sideInfo(src);
  const plan = side.kind === 'fill' ? planFillEffect(src, dir, effect, opts) : planEffect(src, dir, effect, opts);
  return { plan, side };
}

/**
 * The sequence plan of R7-B. `from` and `to` are what planMorph got (name, icon node, icon info, or snapshot).
 * @param {string|Array|Object} from
 * @param {string|Array|Object} to
 * @param {Object} [opts]
 */
export function planCross(from, to, opts = {}, effect = 'implode') {
  const a = halfPlan(from, 'out', opts, effect);
  const b = halfPlan(to, 'in', opts, effect);
  const na = a.plan.slots.length;
  const stamp = (entries, side, plan, slotOffset) =>
    entries.map((e) => {
      const r = { ...e, slot: e.slot + slotOffset, key: e.key + slotOffset * 4 };
      // R9b: an entry of a stroke side without its own width gets its absolute width (the plan width, else the family width, x widthScale).
      const base = plan.strokeWidth > 0 ? plan.strokeWidth : side.strokeWidth;
      if (side.kind === 'stroke' && base > 0 && r.strokeWidth == null) r.strokeWidth = base * (Number.isFinite(e.widthScale) ? e.widthScale : 1);
      return r;
    });
  const norm = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
  const first = (t) => t < 0.5;
  return {
    slots: [...a.plan.slots, ...b.plan.slots],
    turn: 0,
    duration: 0,
    crossKind: true,
    // R9b: the caps and joins of the stroke side (a cross plan has one stroke side).
    linecap: a.plan.linecap || b.plan.linecap || 'round',
    linejoin: a.plan.linejoin || b.plan.linejoin || 'round',
    occlusion: 'none',
    occludes(i, j) {
      if (i < na && j < na) return a.plan.occludes ? a.plan.occludes(i, j) : false;
      if (i >= na && j >= na) return b.plan.occludes ? b.plan.occludes(i - na, j - na) : false;
      return false;
    },
    frame(t) {
      t = norm(t);
      return first(t) ? stamp(a.plan.frame(2 * t), a.side, a.plan, 0) : stamp(b.plan.frame(2 * t - 1), b.side, b.plan, na);
    },
    snapshot(t) {
      t = norm(t);
      return first(t) ? a.plan.snapshot(2 * t) : b.plan.snapshot(2 * t - 1);
    },
  };
}

// ---------------------------------------------------------------------------
// R9-2: the planner of two fill icons. `solidMode` picks the plan:
//   'morph' (default): the region morph of regions.js (round 7b and 8), unchanged.
//   'explode': one plan. The old icon explodes over [0, 0.5], the new icon assembles over [0.5, 1] (effects 'explode' and 'assemble').
//   'implode': the old icon implodes over [0, 0.5], the new icon expands over [0.5, 1].
// Both sequence plans are built with planCross (the same sequence as the cross plan) and say so: `crossKind: true`, `solidMode`.
// ---------------------------------------------------------------------------
export function planSolid(from, to, opts = {}) {
  const mode = opts && opts.solidMode ? opts.solidMode : 'morph';
  if (mode === 'morph' || opts.styleToggle) return planFill(from, to, opts); // a style toggle (the same icon in two styles) always morphs
  if (mode !== 'explode' && mode !== 'implode') throw new Error("planSolid: solidMode must be 'morph', 'explode', or 'implode' (got '" + mode + "').");
  const plan = planCross(from, to, opts, mode);
  plan.solidMode = mode;
  return plan;
}

// Register with the core when it has the hooks (core.js and regions.js do not import each other).
if (typeof core.getIconInfo === 'function') setIconResolver(core.getIconInfo);
if (typeof core.setFillPlanner === 'function') core.setFillPlanner(planSolid);
if (typeof core.setCrossPlanner === 'function') core.setCrossPlanner(planCross);
