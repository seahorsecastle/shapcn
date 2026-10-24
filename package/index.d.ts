// Types for shape-aware-morph 0.2.0 (shapcn). Hand-written for the public API. Unknown details are typed loosely.

export type IconElement = [tag: string, attrs: Record<string, string | number>];
export type IconNode = IconElement[];
export type IconSource = string | IconNode | Record<string, unknown>;
export type EasingName = 'linear' | 'easeInOutCubic' | 'easeOutCubic' | 'smooth' | 'spring' | 'elastic' | 'gentle';
export type EasingFn = (t: number) => number;
export type EffectName = 'implode' | 'explode' | 'assemble' | 'draw' | 'erase' | 'scale' | 'expand';
/** The hover styles. `alive` is the old name of `wiggle`. */
export type HoverStyle = 'wiggle' | 'grow' | 'bend' | 'bold' | 'cascade' | 'move';
/** The press styles. `anticipate-jump` is the old name of `squat-jump`. */
export type PressStyle = 'pop' | 'squash' | 'squat-jump' | 'burst';

/** All engine knobs, frozen. The type lists the common ones. Other keys are allowed. */
export interface MorphOptions {
  easing?: EasingName | (string & {}) | EasingFn;
  stagger?: number;
  occlusion?: 'none' | 'mask' | 'fill';
  objects?: boolean | string;
  [knob: string]: unknown;
}

export const DEFAULTS: Readonly<MorphOptions & Record<string, unknown>>;
export const easings: Record<EasingName, EasingFn> & Record<string, EasingFn>;

export interface Plan {
  slots: unknown[];
  turn: number;
  duration: number;
  strokeWidth?: number;
  linecap?: string;
  linejoin?: string;
  crossKind?: boolean;
  /** The drawing entries for time t in [0, 1]. */
  frame(t: number): Array<Record<string, unknown>>;
  /** The exact picture at time t. Pass it to planMorph as a start point. */
  snapshot(t: number): Record<string, unknown>;
  occludes(i: number, j: number): boolean;
  [key: string]: unknown;
}

export function planMorph(from: IconSource, to: IconSource, opts?: MorphOptions): Plan;
export function planEffect(name: IconSource, direction: 'in' | 'out', effect: EffectName, opts?: MorphOptions): Plan;
export interface HoverPlanOptions extends MorphOptions {
  /** A hover style. Default: `wiggle`, the motion the rig picks for the icon. */
  style?: HoverStyle | 'alive';
  /** 0.5 to 3. Default 1.5. */
  strength?: number;
  /** `bold` only: `'down'` swells and stays (frame 1 is the held weight). Leave the pointer with `retargetPlan(plan, t, true)`. */
  phase?: 'down';
  /** `move` only: the pointer velocity before the plan starts, each axis from -1 to 1. */
  velocity?: { vx: number; vy?: number };
}
/** A one-shot hover plan. frame(0) and frame(1) are the rest icon. Never changes the icon. */
export function planAlive(name: IconSource, opts?: HoverPlanOptions): Plan & { kind: string };
export interface PressPlanOptions extends MorphOptions {
  /** A press style. Default `pop`. */
  style?: PressStyle | 'anticipate-jump';
  /** 0.5 to 3. Default 1.5. */
  strength?: number;
  /** Another icon: the press plays while the icon changes into it. frame(0) is `name`, frame(1) is `to`. */
  to?: IconSource;
  /** With `to`: start at this phase (0 to 1) of a press that already runs. */
  fromT?: number;
}
/** A press plan. Without `to` the icon is unchanged at the end. With `to` it changes inside the press. */
export function planPress(name: IconSource, opts?: PressPlanOptions): Plan & { kind: string; pressWindow?: { ws: number; we: number; fromT: number } };
/** A plan that starts at the pose `src` has at time `t` and goes back to rest (`toRest`) or on into the original plan. Needs a plan with `dense`. */
export function retargetPlan(src: Plan, t: number, toRest: boolean): (Plan & { returning: boolean }) | null;
/** A live sway for `hover="move"`. Run `frame(now)` on every animation frame. */
export interface Sway {
  /** A kick: the pointer came in with this horizontal velocity (-1 to 1). */
  push(vx: number): void;
  /** While the pointer is over the icon: its current horizontal velocity (-1 to 1). */
  setInput(vx: number, vy?: number): void;
  /** The pointer left. The sway rings down to rest. */
  release(): void;
  readonly released: boolean;
  /** Released and still: draw the rest icon. */
  readonly atRest: boolean;
  /** The drawing entries for time `now` (milliseconds). */
  frame(now: number): Array<Record<string, unknown>>;
  /** The true rest icon, as entries. */
  rest(): Array<Record<string, unknown>>;
  readonly strokeWidth: number;
  [key: string]: unknown;
}
export function createSway(name: IconSource, opts?: { strength?: number; duration?: number }): Sway;
/** The hover styles of this version. */
export const HOVER_STYLES: readonly HoverStyle[];
/** The press styles of this version. */
export const PRESS_STYLES: readonly PressStyle[];
/** The default run time in ms of a hover style (a public or an old name). */
export function hoverMs(style: HoverStyle | 'alive'): number;
/** The default run time in ms of a press style (a public or an old name). */
export function pressMs(style: PressStyle | 'anticipate-jump'): number;
export function planCross(from: IconSource, to: IconSource, opts?: MorphOptions, effect?: string): Plan;
export function planSolid(from: IconSource, to: IconSource, opts?: MorphOptions): Plan;
export function planFill(from: IconSource, to: IconSource, opts?: MorphOptions): Plan;
export function planFillEffect(src: IconSource, direction: 'in' | 'out', effect?: string, opts?: MorphOptions): Plan;

/** Load the Lucide icons into the registry. Returns the icon map. */
export function registerLucide(): Promise<Record<string, IconNode>>;
/** Add icons to the registry (Lucide family, 24 grid, stroke width 2). */
export function registerIcons(map: Record<string, IconNode>): void;
export interface FamilySpec {
  id: string;
  kind?: 'stroke' | 'fill';
  viewBox?: string;
  strokeWidth?: number;
  linecap?: string;
  linejoin?: string;
  icons: Record<string, IconNode | Record<string, unknown>>;
  [key: string]: unknown;
}
export function registerFamily(spec: FamilySpec): { id: string; kind: string; viewBox: string; strokeWidth: number };
/** Register a family file (an object or its JSON text). Names become `<id>:<name>`. */
export function registerFamilyFile(json: string | FamilySpec): { id: string; kind: string; viewBox: string; strokeWidth: number };
/** An icon of a `-s` family module (stroke skeleton or fill fallback). Pass it to registerFamilyIcons as it is. */
export interface FamilyIconRecord {
  kind: 'stroke' | 'fill';
  nodes: IconNode;
  nodesViewBox?: string;
  restNodes?: IconNode;
  restViewBox?: string;
  fallback?: boolean;
  [key: string]: unknown;
}
export type FamilyId = 'tabler-outline' | 'tabler-filled' | 'hugeicons' | 'phosphor-thin-s' | 'phosphor-light-s' | 'phosphor-regular-s' | 'phosphor-bold-s' | 'phosphor-fill' | 'phosphor-duotone-s' | 'remix-line-s' | 'remix-fill';
/**
 * Register only some icons of a family module. Names become `<id>:<name>`.
 * `import { bell, bellOff } from 'shape-aware-morph/tabler-outline'; registerFamilyIcons('tabler-outline', { bell, 'bell-off': bellOff });`
 */
export function registerFamilyIcons(family: FamilyId | Omit<FamilySpec, 'icons'>, icons: Record<string, IconNode | FamilyIconRecord>): { id: string; kind: string; viewBox: string; strokeWidth: number };
export interface RegisterSVGsOptions {
  /** 'stroke' (default): outline icons, plain names. 'fill': solid icons, names `<family>:<name>`. */
  kind?: 'stroke' | 'fill';
  /** Family id. Stroke default: none (plain names). Fill default: 'svg'. */
  family?: string;
  strokeWidth?: number;
  linecap?: string;
  linejoin?: string;
}
/** Register your own SVG icons from markup (path, line, polyline, polygon, circle, ellipse, rect; viewBox scaled to 24). Returns the registered names. */
export function registerSVGs(svgs: Record<string, string>, opts?: RegisterSVGsOptions): string[];
export function getIconNames(withShapes?: boolean): string[];
export function getIconInfo(name: string | IconNode): { nodes: IconNode; family: { id: string; kind: 'stroke' | 'fill'; viewBox: string; strokeWidth: number } };
export function getFamily(id: string): Record<string, unknown> | null;
export function iconToSVG(nodeOrName: string | IconNode, opts?: { size?: number; color?: string; strokeWidth?: number }): string;

export interface MorphIconOptions extends MorphOptions {
  name?: string;
  size?: number;
  color?: string;
  strokeWidth?: number;
  /** Milliseconds. Default 450. */
  duration?: number;
  respectReducedMotion?: boolean;
  /** Hover style. `alive` is the old name of `wiggle`. */
  hover?: HoverStyle | 'alive' | null;
  /** Milliseconds. Default: 600 for wiggle, 400 for grow and bend, 250 for bold, 500 for cascade, 900 for move. */
  aliveDuration?: number;
  /** Press style. */
  press?: PressStyle | 'anticipate-jump' | null;
  /** Milliseconds. Default: 300 for pop and squash, 500 for squat-jump and burst. */
  pressDuration?: number;
  /** 0.5 to 3. Default 1.5. */
  hoverStrength?: number;
  /** 0.5 to 3. Default 1.5. */
  pressStrength?: number;
  effect?: EffectName;
}

export class MorphIcon {
  constructor(target: Element, opts?: MorphIconOptions);
  readonly name: string | null;
  readonly svg: SVGSVGElement;
  opts: MorphIconOptions;
  update(opts: MorphIconOptions): void;
  set(name: string): void;
  morphTo(name: string, opts?: MorphIconOptions): Promise<boolean>;
  hide(opts?: MorphIconOptions): Promise<boolean>;
  show(name: string, opts?: MorphIconOptions): Promise<boolean>;
  playAlive(opts?: MorphIconOptions): Promise<boolean>;
  /** Go back to rest from the frame on screen (the pointer left). */
  leaveAlive(opts?: MorphIconOptions): Promise<boolean>;
  /** Play the press animation (the `press` option). */
  playPress(opts?: MorphIconOptions): Promise<boolean>;
  /** Change the icon inside the press animation. */
  pressTo(next: string, opts?: MorphIconOptions): Promise<boolean>;
  destroy(): void;
}

/** The custom element class. */
export interface MorphIconElement extends HTMLElement {
  name: string | null;
  morphTo(name: string, opts?: MorphIconOptions): Promise<boolean>;
  hide(opts?: MorphIconOptions): Promise<boolean>;
  show(name: string, opts?: MorphIconOptions): Promise<boolean>;
  playAlive(opts?: MorphIconOptions): Promise<boolean>;
  /** Go back to rest from the frame on screen (the pointer left). */
  leaveAlive(opts?: MorphIconOptions): Promise<boolean>;
  /** Play the press animation (the `press` attribute). */
  playPress(opts?: MorphIconOptions): Promise<boolean>;
  /** Change the icon inside the press animation (the `press` attribute). Setting `name` while a press runs does the same. */
  pressTo(next: string, opts?: MorphIconOptions): Promise<boolean>;
}

/** Register the custom element. Returns the class, or null when there is no DOM. */
export function defineMorphIcon(tagName?: string): (new () => MorphIconElement) | null;
/** Play the alive animation on pointer enter and focus. Returns a cleanup function. */
export function alive(el: MorphIcon | Element, opts?: MorphIconOptions): () => void;

// React and DOM typing for <morph-icon>.
export interface MorphIconAttributes {
  name?: string;
  size?: number | string;
  color?: string;
  'stroke-width'?: number | string;
  duration?: number | string;
  easing?: string;
  stagger?: number | string;
  effect?: EffectName | (string & {});
  hover?: HoverStyle | 'alive' | (string & {});
  press?: PressStyle | 'anticipate-jump' | (string & {});
  /** 0.5 to 3. Default 1.5. */
  'hover-strength'?: number | string;
  /** Milliseconds. */
  'hover-duration'?: number | string;
  /** 0.5 to 3. Default 1.5. */
  'press-strength'?: number | string;
  /** Milliseconds. */
  'press-duration'?: number | string;
  class?: string;
  className?: string;
  style?: unknown;
  id?: string;
  key?: string | number;
  ref?: unknown;
  children?: unknown;
  [attr: string]: unknown;
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'morph-icon': MorphIconAttributes;
    }
  }
  interface HTMLElementTagNameMap {
    'morph-icon': MorphIconElement;
  }
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'morph-icon': MorphIconAttributes;
    }
  }
}
