// Morphicon DOM layer. A small class and a custom element. Imports the pure core only.
import { DEFAULTS, easings, planMorph, iconInnerSVG, getRestPicture, getIconInfo, getFamily } from './core.js';
import { renderInto } from './render.js';
import { planEffect, planAlive, planPress, retargetPlan, createSway, isHoverStyle, isPressStyle, resolveHover, resolvePress, hoverMs, pressMs, pressToMs, RETARGET_MS } from './effects.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const BASE = {
  size: 24,
  color: 'currentColor',
  strokeWidth: 2,
  duration: 450,
  easing: DEFAULTS.easing,
  respectReducedMotion: true,
  // R15-1, round 19: `hover: '<style>'` (wiggle, grow, bend, bold, cascade, move; `alive` is the old name of wiggle) plays on
  // pointer enter and on keyboard focus.
  hover: null,
  aliveDuration: null, // null: the default of the style (wiggle is 600 ms; see ALIVE_MS in effects.js)
  // Round 19: `press: '<style>'` (pop, squash, squat-jump, burst) plays on pointer down and on Enter or Space.
  press: null,
  pressDuration: null, // null: the default of the style
  hoverStrength: 1.5, // 0.5 to 3
  pressStrength: 1.5,
};

// The pointer's recent movement, for `hover="move"`. The page-wide history is kept for 300 ms.
const ptrHist = [];
let ptrWired = false;
function wirePointerTracker() {
  if (ptrWired || typeof document === 'undefined') return;
  ptrWired = true;
  document.addEventListener(
    'pointermove',
    (e) => {
      const t = now();
      ptrHist.push({ x: e.clientX, y: e.clientY, t });
      while (ptrHist.length && t - ptrHist[0].t > 300) ptrHist.shift();
    },
    { passive: true, capture: true }
  );
}
// The velocity of the pointer over the last `win` ms, each axis in -1..1 (1 is 2 px per ms). null when it did not move.
function pointerVelocity(win = 80) {
  const t = now();
  const s = ptrHist.filter((p) => t - p.t <= win);
  if (s.length < 2) return null;
  const a = s[0];
  const b = s[s.length - 1];
  const dt = Math.max(1, b.t - a.t);
  const c = (v) => Math.max(-1, Math.min(1, v / 2));
  return { vx: c((b.x - a.x) / dt), vy: c((b.y - a.y) / dt) };
}

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
    this._live = null;
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
    const duration = Number.isFinite(o.aliveDuration) ? o.aliveDuration : hoverMs(isHoverStyle(o.hover) ? o.hover : 'wiggle');
    if (duration <= 0) return Promise.resolve(false);
    // Interruptible: the pointer came back while the icon returns to rest. Go forward again from the frame on screen.
    const run = this._run;
    if (run && run.returning && run.plan.dense) {
      const fwd = retargetPlan(run.plan, run.t, false);
      if (fwd) return this._play(fwd, duration, this._name, o, { alive: true });
    }
    // A morph that is playing wins over the alive animation; an alive run already playing is not restarted.
    if (this._run || this._holdPlan) return Promise.resolve(false);
    const hv = resolveHover(o.hover);
    if (hv === 'move') return this._startFollow(o, opts);
    const keep = hv === 'bold'; // bold stays while the pointer stays
    let plan;
    try {
      // `hover="grow"` (and the other styles) plays that style; `hover="wiggle"` (or `alive`) is the one the rig picks.
      plan = planAlive(this._name, { ...o, style: o.hover, strength: o.hoverStrength, phase: keep ? 'down' : undefined });
    } catch (e) {
      return Promise.resolve(false);
    }
    return this._play(plan, duration, this._name, o, { alive: true, keep });
  }

  // `hover="move"`. A live spring runs frame by frame while the pointer is over the icon.
  _startFollow(o, opts) {
    if (this._live) {
      // Re-entered while it still swings: the same sway goes on from where it is.
      this._live.sway.setInput(0, 0);
      this._live.sway.push(opts.velocity ? opts.velocity.vx : 0);
      return Promise.resolve(true);
    }
    if (this._run) return Promise.resolve(false);
    let sway;
    try {
      sway = createSway(this._name, { strength: o.hoverStrength, duration: Number.isFinite(o.aliveDuration) ? o.aliveDuration : hoverMs('move') });
    } catch (e) {
      return Promise.resolve(false);
    }
    const style = styleFor(sway.strokeWidth, 'round', 'round', o);
    const ro = { occlusion: 'none', strokeWidth: style.w, baseWidth: style.w, linecap: style.cap, linejoin: style.join };
    this.svg.setAttribute('stroke-width', String(style.w));
    this.svg.setAttribute('stroke-linecap', style.cap);
    this.svg.setAttribute('stroke-linejoin', style.join);
    this._holdPlan = null;
    this._live = { sway };
    const v = opts.velocity || { vx: 0.4, vy: 0 };
    sway.push(v.vx);
    if (opts.tap) sway.release(); // a tap has no leave: one kick, then it rings down
    return new Promise((resolve) => {
      const tick = () => {
        if (this._live === null || this._live.sway !== sway) {
          resolve(false);
          return;
        }
        renderInto(this.svg, sway.frame(now()), sway, ro);
        if (sway.atRest) {
          this._live = null;
          this._raf = 0;
          this._renderRest(this._name);
          resolve(true);
          return;
        }
        this._raf = raf(tick);
      };
      this._raf = raf(tick);
    });
  }

  /**
   * The pointer left. A hover run in the middle goes back to rest from the frame on screen (it does not jump or restart),
   * and a held `bold` springs back.
   */
  leaveAlive(opts = {}) {
    const o = { ...this.opts, ...opts };
    if (this._live) {
      this._live.sway.release();
      return Promise.resolve(true);
    }
    const run = this._run;
    let src = null;
    let t = 1;
    if (run && run.alive && !run.press && !run.returning && run.plan.dense) {
      src = run.plan;
      t = run.t;
    } else if (!run && this._holdPlan) src = this._holdPlan;
    if (!src) return Promise.resolve(false);
    const plan = retargetPlan(src, t, true);
    if (!plan) return Promise.resolve(false);
    return this._play(plan, RETARGET_MS, this._name, o, { alive: true, returning: true });
  }

  /**
   * Play the press animation (`press` option, or `opts.press`). The icon is unchanged at the end.
   * A press restarts a press run that is playing and replaces a hover run. It does nothing while reduced motion is on.
   * @returns {Promise<boolean>}
   */
  playPress(opts = {}) {
    const o = { ...this.opts, ...opts };
    if (!isPressStyle(o.press)) return Promise.resolve(false);
    const style = resolvePress(o.press);
    if (this._name == null || this._hidden) return Promise.resolve(false);
    if (o.respectReducedMotion !== false && reducedMotion()) return Promise.resolve(false);
    if (this._run && !this._run.alive && !this._run.press) return Promise.resolve(false); // a morph wins
    const duration = Number.isFinite(o.pressDuration) ? o.pressDuration : pressMs(style);
    let plan;
    try {
      plan = planPress(this._name, { ...o, style, strength: o.pressStrength });
    } catch (e) {
      return Promise.resolve(false);
    }
    return this._play(plan, duration, this._name, o, { alive: true, press: true });
  }

  /**
   * A press that changes the icon. Plays the press style (the `press` option) while the icon morphs to `to` inside it, so
   * the shape changes mid-click. If a press is already running (the pointer went down a moment ago),
   * the combined plan starts at the phase that press has reached. Returns a Promise, true when the run ends.
   * @param {string} to The next icon name.
   * @param {Object} [opts] `press` (pop, squash, squat-jump, burst), `pressStrength`, `pressDuration`.
   */
  pressTo(to, opts = {}) {
    const o = { ...this.opts, ...opts };
    if (this._name == null || this._hidden || !to) return this.morphTo ? this.morphTo(to, opts) : Promise.resolve(false);
    if (o.respectReducedMotion !== false && reducedMotion()) {
      this._cancel();
      this.set(to);
      return Promise.resolve(false);
    }
    const style = isPressStyle(o.press) ? resolvePress(o.press) : 'squash';
    const run = this._run;
    const fromT = run && run.press && !run.combined ? run.t : 0;
    const base = Number.isFinite(o.pressDuration) ? Math.max(o.pressDuration, pressToMs(style)) : pressToMs(style);
    const duration = Math.max(200, base * (1 - fromT));
    let plan;
    try {
      plan = planPress(this._name, { ...o, style, to, fromT, strength: o.pressStrength });
    } catch (e) {
      return this.morphTo(to, opts);
    }
    return this._play(plan, duration, to, o, { alive: true, press: true, combined: true });
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
    this._holdPlan = null;
    this._name = endName;
    this._hidden = false;
    // R9b: draw the plan at its own width and caps: the wrapper gets them, and the renderer uses the same width as its base.
    const style = styleFor(plan.strokeWidth, plan.linecap, plan.linejoin, o);
    const ro = { occlusion: o.occlusion, strokeWidth: style.w, baseWidth: style.w, linecap: style.cap, linejoin: style.join };
    return new Promise((resolve) => {
      this._run = { plan, start: now(), duration, resolve, t: 0, style, alive: !!(meta && meta.alive), press: !!(meta && meta.press), combined: !!(meta && meta.combined), returning: !!(meta && meta.returning) };
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
          if (meta && meta.keep) {
            // A held pose (bold). The last frame stays until the pointer leaves.
            this._draw(plan, 1, ro);
            this._holdPlan = plan;
            resolve(true);
            return;
          }
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
      return ['name', 'size', 'color', 'stroke-width', 'duration', 'easing', 'stagger', 'effect', 'hover', 'press', 'hover-strength', 'hover-duration', 'press-strength', 'press-duration'];
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
      if (this.hasAttribute('press')) o.press = this.getAttribute('press');
      for (const [a, k] of [['hover-strength', 'hoverStrength'], ['hover-duration', 'aliveDuration'], ['press-strength', 'pressStrength'], ['press-duration', 'pressDuration']]) {
        if (this.hasAttribute(a)) o[k] = Number(this.getAttribute(a));
      }
      return o;
    }

    connectedCallback() {
      if (!this.style.display) this.style.display = 'inline-block';
      if (!this.style.lineHeight) this.style.lineHeight = '0';
      if (!this._mi) {
        const existing = this.querySelector(':scope > svg');
        this._mi = new MorphIcon(existing || this, this._optsFromAttrs());
        // Every frame replaces the children of the svg. If the pointer went down on one of them, the target would leave the DOM and
        // the browser would never fire `click`. So the svg takes no pointer events: the host element is always the target.
        this._mi.svg.style.pointerEvents = 'none';
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
      const isHover = (mi) => mi && isHoverStyle(mi.opts.hover);
      const holds = (mi) => resolveHover(mi.opts.hover) === 'bold'; // a held hover
      // A touch screen has no hover: a tap plays the rollover instead (it never fires a false hover).
      const canHover = () => {
        try {
          return typeof matchMedia !== 'function' || matchMedia('(hover: hover) and (pointer: fine)').matches;
        } catch (e) {
          return true;
        }
      };
      this._onAlive = (e) => {
        const mi = this._mi;
        if (!isHover(mi)) return;
        if (e && e.type === 'pointerenter' && (e.pointerType === 'touch' || !canHover())) return;
        mi.playAlive({ velocity: pointerVelocity() || undefined }).catch(() => {});
      };
      this._onMove = () => {
        const mi = this._mi;
        if (mi && mi._live) {
          const v = pointerVelocity(60);
          if (v) mi._live.sway.setInput(v.vx, v.vy);
        }
      };
      this._onLeave = (e) => {
        const mi = this._mi;
        if (mi) {
          // A finger that lifts also "leaves". A held hover (bold) stays until a second tap or a tap elsewhere.
          const fingerLift = e && e.type === 'pointerleave' && e.pointerType === 'touch' && holds(mi);
          if (!fingerLift) mi.leaveAlive().catch(() => {});
        }
      };
      this._onPress = (e) => {
        const mi = this._mi;
        if (!mi) return;
        if (isHover(mi) && e && e.type === 'pointerdown' && (e.pointerType === 'touch' || !canHover())) {
          if (holds(mi) && (mi._holdPlan || mi._run)) mi.leaveAlive().catch(() => {}); // the second tap lets go
          else mi.playAlive({ tap: true }).catch(() => {});
        }
        if (isPressStyle(mi.opts.press)) mi.playPress().catch(() => {});
      };
      this._onPressKey = (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) this._onPress(e);
      };
      const host = this._nearestFocusable();
      const target = host && host !== this ? host : this;
      if (typeof document !== 'undefined') {
        // A tap anywhere else lets go of a held hover on a touch screen.
        document.addEventListener('pointerdown', (e) => {
          const mi = this._mi;
          if (mi && e.pointerType === 'touch' && holds(mi) && mi._holdPlan && !target.contains(e.target)) mi.leaveAlive().catch(() => {});
        });
      }
      target.addEventListener('pointerenter', this._onAlive);
      target.addEventListener('focus', this._onAlive);
      wirePointerTracker();
      target.addEventListener('pointermove', this._onMove);
      target.addEventListener('pointerleave', this._onLeave);
      target.addEventListener('pointercancel', this._onLeave);
      target.addEventListener('blur', this._onLeave);
      target.addEventListener('pointerdown', this._onPress);
      target.addEventListener('keydown', this._onPressKey);
      this._focusHost = host && host !== this ? host : null;
    }

    disconnectedCallback() {
      // Keep the instance. The element can come back. Stop any running frame.
      if (this._mi) this._mi._cancel();
    }

    attributeChangedCallback(attr, oldV, newV) {
      const mi = this._mi;
      if (!mi || this._silent) return;
      if (attr === 'name') {
        // A name change while a press animation plays joins it: the morph runs inside the press.
        if (newV && mi._run && mi._run.press && !mi._run.combined && isPressStyle(mi.opts.press)) {
          mi.pressTo(newV).catch((e) => console.error(e));
          return;
        }
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

    /**
     * Change the icon inside the press animation (the `press` attribute): `el.pressTo('circle-check')`.
     * Setting the `name` attribute while a press is running does the same (the morph joins the press that plays).
     */
    pressTo(next, opts) {
      if (!this._mi) this.connectedCallback();
      this._silent = true;
      this.setAttribute('name', next);
      this._silent = false;
      return this._mi.pressTo(next, opts);
    }

    /** Go back to rest from the frame on screen (the pointer left). */
    leaveAlive(opts) {
      return this._mi ? this._mi.leaveAlive(opts) : Promise.resolve(false);
    }

    /** Play the press animation (same as `press="<style>"` does on click). */
    playPress(opts) {
      if (!this._mi) this.connectedCallback();
      return this._mi.playPress(opts);
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
