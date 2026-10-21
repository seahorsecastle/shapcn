// Morphicon DOM layer. A small class and a custom element. Imports the pure core only.
import { DEFAULTS, easings, planMorph, iconInnerSVG, getRestPicture, getIconInfo, getFamily } from './core.js';
import { renderInto } from './render.js';
import { planEffect, planAlive } from './effects.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const BASE = {
  size: 24,
  color: 'currentColor',
  strokeWidth: 2,
  duration: 450,
  easing: DEFAULTS.easing,
  respectReducedMotion: true,
  // R15-1: `hover: 'alive'` plays the life animation on pointer enter and on keyboard focus.
  hover: null,
  // R15-4: the alive animation is 600 ms by default.
  aliveDuration: 600,
};

const raf = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(() => fn(now()), 16));
const caf = (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function reducedMotion() {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {
    return false;
  }
}

// R9b: the stroke style of the wrapper svg. A family with its own stroke width (not 2) and its own caps draws with them.
// A width of 2 is the Lucide width: it follows the instance option `strokeWidth`.
function styleFor(width, cap, join, o) {
  return { w: width > 0 && width !== 2 ? width : o.strokeWidth, cap: cap || 'round', join: join || 'round' };
}

// The style of an icon at rest (a name). Not a family icon, or a fill icon: the instance option and round caps.
function restStyle(name, o) {
  if (typeof name === 'string') {
    try {
      const f = getIconInfo(name).family;
      if (f && f.kind !== 'fill' && f.id !== 'lucide') {
        const fam = getFamily(f.id) || {};
        const vbw = Number(String(f.viewBox).split(/\s+/)[2]) || 24;
        return styleFor((f.strokeWidth * 24) / vbw, fam.linecap, fam.linejoin, o);
      }
    } catch (e) {
      // an unknown name: the default style
    }
  }
  return styleFor(0, 'round', 'round', o);
}

export class MorphIcon {
  /**
   * @param {Element} target An <svg> element, or a container. A container gets an <svg> child.
   * @param {Object} [opts] name, size, color, strokeWidth, duration, easing, respectReducedMotion, plus core knobs.
   */
  constructor(target, opts = {}) {
    this.opts = { ...BASE, ...opts };
    this._name = null;
    this._raf = 0;
    this._run = null; // { plan, start, duration, resolve, t }
    this._hidden = false; // true when the icon is empty after hide()
    this._ownsSvg = false;
    if (target && target.namespaceURI === SVG_NS && target.tagName.toLowerCase() === 'svg') {
      this.svg = target;
    } else {
      this.svg = document.createElementNS(SVG_NS, 'svg');
      target.appendChild(this.svg);
      this._ownsSvg = true;
    }
    this._applySvgAttrs();
    if (this.opts.name) this.set(this.opts.name);
  }

  get name() {
    return this._name;
  }

  _applySvgAttrs() {
    const o = this.opts;
    const s = this.svg;
    s.setAttribute('xmlns', SVG_NS);
    s.setAttribute('width', String(o.size));
    s.setAttribute('height', String(o.size));
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', o.color);
    // R9b: while a plan runs, the wrapper has the stroke width and caps of the plan. At rest it has those of the icon.
    const st = this._run && this._run.style ? this._run.style : restStyle(this._name, o);
    s.setAttribute('stroke-width', String(st.w));
    s.setAttribute('stroke-linecap', st.cap);
    s.setAttribute('stroke-linejoin', st.join);
    s.style.overflow = 'visible'; // moving parts can pass over the 24 x 24 edge
  }

  /** Change instance options (size, color, strokeWidth, duration, easing, core knobs). */
  update(opts) {
    Object.assign(this.opts, opts);
    this._applySvgAttrs();
  }

  _cancel() {
    if (this._raf) caf(this._raf);
    this._raf = 0;
    const run = this._run;
    this._run = null;
    if (run) run.resolve(false);
  }

  _renderRest(name) {
    this._hidden = false;
    const st = restStyle(name, this.opts);
    this.svg.setAttribute('stroke-width', String(st.w));
    this.svg.setAttribute('stroke-linecap', st.cap);
    this.svg.setAttribute('stroke-linejoin', st.join);
    // R9-2: an icon of a `-s` set rests as its exact original fill nodes (scaled from their view box into the 24 grid).
    const rest = typeof name === 'string' ? getRestPicture(name) : null;
    if (rest) {
      const vbw = Number(rest.viewBox.split(' ')[2]) || 24;
      this.svg.innerHTML = '<g transform="scale(' + 24 / vbw + ')" fill="currentColor" stroke="none">' + iconInnerSVG(rest.nodes) + '</g>';
    } else this.svg.innerHTML = iconInnerSVG(name);
  }

  _renderEmpty() {
    this._hidden = true;
    this.svg.innerHTML = '';
  }

  /** Instant change, no animation. */
  set(name) {
    this._cancel();
    this._renderRest(name);
    this._name = name;
  }

  /**
   * Morph to another icon. Resolves true when the morph ends, false when a new call interrupts it.
   * On an empty icon (after hide) it is the same as show.
   * @param {string} name
   * @param {Object} [opts] Per-call options. They override the instance options.
   * @returns {Promise<boolean>}
   */
  morphTo(name, opts = {}) {
    const o = { ...this.opts, ...opts };
    try {
      if (this._hidden || (this._name === null && this._run)) return this.show(name, opts);
      if (this._name === null) {
        this.set(name);
        return Promise.resolve(true);
      }
      if (name === this._name) return Promise.resolve(true);
      const duration = this._duration(o);
      if (duration <= 0) {
        this.set(name);
        return Promise.resolve(true);
      }
      const { from, easing } = this._source(o);
      return this._play(planMorph(from, name, { ...o, easing }), duration, name, o);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /**
   * Disappear with an effect: 'implode' (default), 'explode', 'draw' (it erases), 'scale'. The icon is empty after it.
   * Resolves true when the effect ends, false when a new call interrupts it.
   * @param {Object} [opts] `effect`, plus per-call options.
   * @returns {Promise<boolean>}
   */
  hide(opts = {}) {
    const o = { ...this.opts, ...opts };
    try {
      if (this._hidden || this._name === null) return Promise.resolve(true);
      const duration = this._duration(o);
      if (duration <= 0) {
        this._cancel();
        this._name = null;
        this._renderEmpty();
        return Promise.resolve(true);
      }
      const { from } = this._source(o);
      const plan = planEffect(from, 'out', o.effect || 'implode', o);
      return this._play(plan, duration, null, o);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /**
   * Appear with an effect: 'expand' (default), 'assemble', 'draw', 'scale'. It works on an empty icon. On an icon
   * that shows something, it is the same as morphTo.
   * @param {string} name
   * @param {Object} [opts] `effect`, plus per-call options.
   * @returns {Promise<boolean>}
   */
  show(name, opts = {}) {
    const o = { ...this.opts, ...opts };
    try {
      if (this._name !== null) return this.morphTo(name, opts);
      const duration = this._duration(o);
      if (duration <= 0) {
        this.set(name);
        return Promise.resolve(true);
      }
      if (this._run) {
        // A hide runs now. Morph from its current picture. The shape is not empty yet.
        const { from } = this._source(o);
        return this._play(planMorph(from, name, { ...o, easing: 'easeOutCubic' }), duration, name, o);
      }
      this._renderEmpty();
      return this._play(planEffect(name, 'in', o.effect || 'expand', o), duration, name, o);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  _duration(o) {
    return o.respectReducedMotion !== false && reducedMotion() ? 0 : o.duration;
  }

  /**
   * R15-1: play the one-shot "alive" life animation for the current icon. The icon is unchanged at the end.
   * It does nothing while reduced motion is on, while a morph is playing (a morph wins), or while an alive run
   * is already playing (it is not restarted). Safe to call from a pointerenter or focus handler.
   * @param {Object} [opts] Per-call options (`aliveDuration`, `respectReducedMotion`, core knobs).
   * @returns {Promise<boolean>} true when the run ends, false when it does not play.
   */
  playAlive(opts = {}) {
    const o = { ...this.opts, ...opts };
    if (this._name == null || this._hidden) return Promise.resolve(false);
    if (o.respectReducedMotion !== false && reducedMotion()) return Promise.resolve(false);
    // A morph that is playing wins over the alive animation; an alive run already playing is not restarted.
    if (this._run) return Promise.resolve(false);
    const duration = Number.isFinite(o.aliveDuration) ? o.aliveDuration : 600;
    if (duration <= 0) return Promise.resolve(false);
    let plan;
    try {
      plan = planAlive(this._name, o);
    } catch (e) {
      return Promise.resolve(false);
    }
    return this._play(plan, duration, this._name, o, { alive: true });
  }

  // The start of a new plan: the icon name, or the exact picture of the plan that runs now (an interruption).
  _source(o) {
    const prev = this._run;
    if (prev) return { from: prev.plan.snapshot(prev.t), easing: 'easeOutCubic' };
    return { from: this._name, easing: o.easing };
  }

  // Run a plan with requestAnimationFrame. `endName` is the icon at the end (null: empty).
  _play(plan, duration, endName, o, meta) {
    this._cancel();
    this._name = endName;
    this._hidden = false;
    // R9b: draw the plan at its own width and caps: the wrapper gets them, and the renderer uses the same width as its base.
    const style = styleFor(plan.strokeWidth, plan.linecap, plan.linejoin, o);
    const ro = { occlusion: o.occlusion, strokeWidth: style.w, baseWidth: style.w, linecap: style.cap, linejoin: style.join };
    return new Promise((resolve) => {
      this._run = { plan, start: now(), duration, resolve, t: 0, style, alive: !!(meta && meta.alive) };
      this.svg.setAttribute('stroke-width', String(style.w));
      this.svg.setAttribute('stroke-linecap', style.cap);
      this.svg.setAttribute('stroke-linejoin', style.join);
      this._draw(plan, 0, ro);
      const tick = () => {
        const run = this._run;
        if (!run || run.plan !== plan) return;
        const t = Math.min(1, (now() - run.start) / run.duration);
        run.t = t;
        if (t >= 1) {
          this._run = null;
          this._raf = 0;
          if (endName === null) this._renderEmpty();
          else this._renderRest(endName);
          resolve(true);
          return;
        }
        this._draw(plan, t, ro);
        this._raf = raf(tick);
      };
      this._raf = raf(tick);
    });
  }

  // Every frame goes through render.js: back to front, with masks for the shapes that go behind.
  _draw(plan, t, ro) {
    renderInto(this.svg, plan.frame(t), plan, ro);
  }

  destroy() {
    this._cancel();
    if (this._ownsSvg && this.svg.parentNode) this.svg.parentNode.removeChild(this.svg);
    else this.svg.innerHTML = '';
  }
}

const NUM_ATTRS = { size: 'size', duration: 'duration', stagger: 'stagger' };

/**
 * Register the custom element.
 * @param {string} [tagName]
 */
export function defineMorphIcon(tagName = 'morph-icon') {
  if (typeof customElements === 'undefined' || typeof HTMLElement === 'undefined') return null;
  const existing = customElements.get(tagName);
  if (existing) return existing;

  class MorphIconElement extends HTMLElement {
    static get observedAttributes() {
      return ['name', 'size', 'color', 'stroke-width', 'duration', 'easing', 'stagger', 'effect', 'hover'];
    }

    get name() {
      return this.getAttribute('name');
    }

    set name(v) {
      if (v == null) this.removeAttribute('name');
      else this.setAttribute('name', String(v));
    }

    _optsFromAttrs() {
      const o = {};
      for (const a of Object.keys(NUM_ATTRS)) {
        if (this.hasAttribute(a)) o[a] = Number(this.getAttribute(a));
      }
      if (this.hasAttribute('color')) o.color = this.getAttribute('color');
      if (this.hasAttribute('stroke-width')) o.strokeWidth = Number(this.getAttribute('stroke-width'));
      if (this.hasAttribute('easing')) o.easing = this.getAttribute('easing');
      if (this.hasAttribute('effect')) o.effect = this.getAttribute('effect');
      if (this.hasAttribute('hover')) o.hover = this.getAttribute('hover');
      return o;
    }

    connectedCallback() {
      if (!this.style.display) this.style.display = 'inline-block';
      if (!this.style.lineHeight) this.style.lineHeight = '0';
      if (!this._mi) {
        const existing = this.querySelector(':scope > svg');
        this._mi = new MorphIcon(existing || this, this._optsFromAttrs());
        const name = this.getAttribute('name');
        if (name) this._mi.set(name);
        else if (this.hasAttribute('name')) this._mi._hidden = true; // an empty name: the first name after it shows with the effect
      }
      this._wireHover();
    }

    // R15-1: the element, or its nearest button or link ancestor, gets a pointerenter and a focus handler.
    _nearestFocusable() {
      for (let el = this; el; el = el.parentElement) {
        const tag = el.tagName ? el.tagName.toLowerCase() : '';
        if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea') return el;
        if (el.hasAttribute && (el.hasAttribute('tabindex') || el.getAttribute('role') === 'button')) return el;
      }
      return null;
    }

    _wireHover() {
      if (this._hoverWired) return;
      this._hoverWired = true;
      this._onAlive = () => {
        const mi = this._mi;
        if (mi && mi.opts.hover === 'alive') mi.playAlive().catch(() => {});
      };
      this.addEventListener('pointerenter', this._onAlive);
      const host = this._nearestFocusable();
      if (host && host !== this) {
        host.addEventListener('focus', this._onAlive);
        this._focusHost = host;
      } else {
        this.addEventListener('focus', this._onAlive);
      }
    }

    disconnectedCallback() {
      // Keep the instance. The element can come back. Stop any running frame.
      if (this._mi) this._mi._cancel();
    }

    attributeChangedCallback(attr, oldV, newV) {
      const mi = this._mi;
      if (!mi || this._silent) return;
      if (attr === 'name') {
        // An empty name hides with the effect attribute (default implode). A name after empty shows with it (default expand).
        const p = newV ? mi.morphTo(newV) : mi.hide();
        p.catch((e) => console.error(e));
        return;
      }
      mi.update(this._optsFromAttrs());
    }

    /** Morph to another icon. Same as setting the name, but returns the Promise. */
    morphTo(name, opts) {
      if (!this._mi) this.connectedCallback();
      this._silent = true;
      this.setAttribute('name', name);
      this._silent = false;
      return this._mi.morphTo(name, opts);
    }

    /** Disappear with an effect (default: the effect attribute, else 'implode'). Sets the name to empty. */
    hide(opts) {
      if (!this._mi) this.connectedCallback();
      this._silent = true;
      this.setAttribute('name', '');
      this._silent = false;
      return this._mi.hide(opts);
    }

    /** Appear with an effect (default: the effect attribute, else 'expand'). */
    show(name, opts) {
      if (!this._mi) this.connectedCallback();
      this._silent = true;
      this.setAttribute('name', name);
      this._silent = false;
      return this._mi.show(name, opts);
    }

    /** R15-1: play the one-shot alive animation for the current icon (same as `hover="alive"` does on hover). */
    playAlive(opts) {
      if (!this._mi) this.connectedCallback();
      return this._mi.playAlive(opts);
    }
  }

  customElements.define(tagName, MorphIconElement);
  return MorphIconElement;
}

/**
 * R15-1: wire the alive animation onto an element for code use. On pointer enter and on keyboard focus of the
 * element or of its nearest button or link ancestor, the MorphIcon's icon comes to life once.
 * @param {MorphIcon|Element} el A MorphIcon instance, or a `<morph-icon>` element (or any element that owns one).
 * @param {Object} [opts] Per-call options for `playAlive`.
 * @returns {Function} a cleanup that removes the listeners.
 */
export function alive(el, opts = {}) {
  const mi = el instanceof MorphIcon ? el : el && el._mi;
  const target = el instanceof MorphIcon ? el.svg : el;
  if (!mi || !target || typeof target.addEventListener !== 'function') return () => {};
  const fn = () => {
    mi.playAlive(opts).catch(() => {});
  };
  target.addEventListener('pointerenter', fn);
  let host = null;
  for (let e = target; e; e = e.parentElement) {
    const tag = e.tagName ? e.tagName.toLowerCase() : '';
    if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea') {
      host = e;
      break;
    }
    if (e.hasAttribute && (e.hasAttribute('tabindex') || e.getAttribute('role') === 'button')) {
      host = e;
      break;
    }
  }
  (host || target).addEventListener('focus', fn);
  return () => {
    target.removeEventListener('pointerenter', fn);
    (host || target).removeEventListener('focus', fn);
  };
}
