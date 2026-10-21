// Types for shape-aware-morph 0.1.0 (shapcn). Hand-written for the public API. Unknown details are typed loosely.

export type IconElement = [tag: string, attrs: Record<string, string | number>];
export type IconNode = IconElement[];
export type IconSource = string | IconNode | Record<string, unknown>;
export type EasingName = 'linear' | 'easeInOutCubic' | 'easeOutCubic' | 'smooth' | 'spring' | 'elastic' | 'gentle';
export type EasingFn = (t: number) => number;
export type EffectName = 'implode' | 'explode' | 'assemble' | 'draw' | 'erase' | 'scale' | 'expand';

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
export function planAlive(name: IconSource, opts?: MorphOptions): Plan & { kind: string };
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
  hover?: 'alive' | null;
  /** Milliseconds. Default 600. */
  aliveDuration?: number;
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
  destroy(): void;
}

/** The custom element class. */
export interface MorphIconElement extends HTMLElement {
  name: string | null;
  morphTo(name: string, opts?: MorphIconOptions): Promise<boolean>;
  hide(opts?: MorphIconOptions): Promise<boolean>;
  show(name: string, opts?: MorphIconOptions): Promise<boolean>;
  playAlive(opts?: MorphIconOptions): Promise<boolean>;
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
  hover?: 'alive' | (string & {});
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
