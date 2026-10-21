# Troubleshooting

## Icon is blank, console shows `Unknown icon "x"`
- The name is not registered. Check with `window.shapcn.getIconNames()` (script tag) or `getIconNames()` (npm).
- Script tag: use Lucide names (kebab case): `eye-off`, not `eyeOff` or `EyeOff`.
- npm with per-icon imports: you must register the icon. `import { mic } from 'shape-aware-morph/lucide'; registerIcons({ mic })`. A hyphen name needs a quoted key: `'mic-off': micOff`.
- Other family: the name has the prefix: `tabler-outline:bell`, and you registered it with `registerFamilyIcons('tabler-outline', { bell })`.
- Your own SVG: register before the name is first used. `registerSVGs` with `kind: 'fill'` makes the name `svg:<name>`.
- Built-in simple shapes also exist: `shape:dot`, `shape:circle`, `shape:square`, `shape:line`.

## `require` fails or `ERR_REQUIRE_ESM`
The package is ES modules only. Use `import`. In Node, `require('shape-aware-morph')` works only on Node 22.12 or newer. For a CommonJS project, use dynamic `await import('shape-aware-morph')` or the script tag.

## SSR error or `customElements is not defined` / `window is not defined`
- Call `defineMorphIcon()` only in the browser (`useEffect`, `onMounted`, `onMount`, a client component).
- `defineMorphIcon()` itself returns `null` without a DOM and does not throw. If the error comes from your own code that touches `document`, move that code into the browser hook.
- Do not call element methods (`morphTo`, `hide`, `show`) on the server.

## The tag shows nothing and there is no error
- The element is not defined. Check `customElements.get('morph-icon')`. On the npm path, you must call `defineMorphIcon()`. The script tag path does it for you.
- Script URL blocked or wrong. Use `https://shapcn.com/morph-icon.js`. Look at the Network panel.
- On the npm path with `registerLucide()`: it is async. `await` it before `defineMorphIcon()`, or the first icons may not exist.

## It changes at once, no animation
- The user has reduced motion on (`prefers-reduced-motion: reduce`). This is by design. Do not turn it off.
- `duration="0"`.
- The name did not change (same name resolves at once).
- An icon in a stroke family morphs to an icon in a fill family: this is a short two-part sequence, not a shape morph.

## `hover="alive"` does nothing
- Reduced motion is on, or the icon is empty/hidden, or another animation is running. This is by design.
- The attribute value must be exactly `alive`.

## Wrong color or size
- Color: the stroke is `currentColor`. Set CSS `color` on the parent, or the `color` attribute.
- Size: use the `size` attribute (pixels). Do not size with CSS `width` only; the inner SVG has its own size.

## Layout jumps before the icon loads
Give the tag a fixed box: `size="24"` is the default. In SSR pages, add CSS `morph-icon { width: 24px; height: 24px; }` to match.

## npm package not found
`npm view shape-aware-morph version` returned 404: the package is not published yet. Use the script tag path.

## React: TypeScript says `morph-icon` does not exist
- npm path: add `import 'shape-aware-morph';` once in a file that TypeScript includes. The package declares the JSX type.
- Script tag path: add the `declare namespace JSX` snippet from `frameworks.md`.

## Vue warns "Failed to resolve component: morph-icon"
Set `compilerOptions.isCustomElement` (see `frameworks.md`).

## `Cannot read properties of undefined (reading 'registerIcons')`
The script is `type="module"` and runs later than your inline code. Load shapcn as a classic script, or wait with `customElements.whenDefined('morph-icon')`.
