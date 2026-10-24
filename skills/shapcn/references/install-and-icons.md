# Install and icons

## Contents
- Script tag
- npm
- Pick only the icons you need
- Other icon families
- Your own SVG icons

## Script tag (works today)

```html
<script type="module" src="https://shapcn.com/morph-icon.js"></script>
```

- It defines `<morph-icon>` and registers all Lucide icons.
- It sets `window.shapcn`. Members: `DEFAULTS`, `easings`, `registerIcons`, `registerFamily`, `registerFamilyFile`, `getIconInfo`, `getFamily`, `getIconNames`, `iconToSVG`, `planMorph`, `planAlive`, `MorphIcon`, `defineMorphIcon`.
- `registerSVGs` and `registerFamilyIcons` are not on `window.shapcn`. Use `registerIcons` for your own icons here (see below).
- The file is large (about 0.9 MB, all Lucide icons). If page weight matters, use npm and import only the icons you use.

## npm

The package is published. Install:

```sh
npm i shape-aware-morph
```

The package is ES modules only. Use `import`. `require` works only on Node 22.12 or newer.

Everything:

```js
import { registerLucide, defineMorphIcon } from 'shape-aware-morph';
await registerLucide();   // all Lucide icons, loaded on demand
defineMorphIcon();        // defines <morph-icon>
```

## Pick only the icons you need

Each family is a module with one named export per icon (camelCase). A bundler drops what you do not import.

```js
import { defineMorphIcon, registerIcons } from 'shape-aware-morph';
import { play, pause } from 'shape-aware-morph/lucide';

registerIcons({ play, pause });   // keys are the names used in the name attribute
defineMorphIcon();
```

Use a quoted key when the name has a hyphen: `registerIcons({ mic, 'mic-off': micOff })`.
A name that starts with a digit or is a reserved word gets a leading underscore in the export (`_24Hours`).

## Other families

Names become `<family>:<name>`.

```js
import { registerFamilyIcons, defineMorphIcon } from 'shape-aware-morph';
import { bell, bellOff } from 'shape-aware-morph/tabler-outline';

registerFamilyIcons('tabler-outline', { bell, 'bell-off': bellOff });
defineMorphIcon();
// <morph-icon name="tabler-outline:bell">
```

| Module | Family id |
| --- | --- |
| `shape-aware-morph/lucide` | lucide (use `registerIcons`) |
| `.../tabler-outline`, `.../tabler-filled` | same as module name |
| `.../hugeicons` | `hugeicons` |
| `.../phosphor-thin-s`, `-light-s`, `-regular-s`, `-bold-s`, `-duotone-s`, `phosphor-fill` | same as module name |
| `.../remix-line-s`, `.../remix-fill` | same as module name |

Morphing between a stroke icon and a fill icon works. It plays as a short sequence (the old icon implodes, the new icon expands) and is not a shape morph. Morph inside one family for the best result.

## Your own SVG icons

### npm: registerSVGs

```js
import { registerSVGs, defineMorphIcon } from 'shape-aware-morph';

registerSVGs({
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6.1L12 16.6 6.6 19.6l1.2-6.1L3.3 9.3l6.1-.7z"/></svg>',
}, { kind: 'stroke' });
defineMorphIcon();
// <morph-icon name="star">
```

Rules (from the code):
- Supported tags: `path`, `line`, `polyline`, `polygon`, `circle`, `ellipse`, `rect`. Groups, transforms, and styles are ignored.
- The `viewBox` is scaled to the 24 grid. A viewBox with a non-zero origin is not supported.
- `kind: 'stroke'` (default): outline icons. Names stay as you give them.
- `kind: 'fill'`: solid icons. Names become `svg:<name>`. Use `family: 'mine'` to change the prefix.
- Options: `kind`, `family`, `strokeWidth`, `linecap`, `linejoin`.
- It returns the list of registered names. It throws on an invalid path or a bad `kind`.

Tell the user to convert a complex SVG (groups, transforms) to plain paths first.

### Script tag: registerIcons with icon nodes

`window.shapcn.registerIcons` takes the Lucide node format: an array of `[tag, attributes]`.

A `type="module"` script runs after the page parser. An inline classic script that calls `window.shapcn` would run first and fail with "Cannot read properties of undefined". So for own icons, load shapcn as a classic script (the file works as one):

```html
<script src="https://shapcn.com/morph-icon.js"></script>
<script>
  window.shapcn.registerIcons({
    'my-star': [['path', { d: 'M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6.1L12 16.6 6.6 19.6l1.2-6.1L3.3 9.3l6.1-.7z' }]],
  });
</script>
<morph-icon name="my-star"></morph-icon>
```

- Quote a key that has a hyphen.
- Do not reuse a Lucide name (`star` is a Lucide icon). Your icon replaces it for the whole page. Use a new name such as `my-star`.
- Register before the first use of the name.
- Own icons use the Lucide style: 24 grid, stroke width 2, round caps. Convert an SVG to `[tag, attrs]` nodes by hand: one entry per `path`, `circle`, `line`, and so on.
- If an inline script must wait for a module load, listen for it: `customElements.whenDefined('morph-icon').then(() => window.shapcn.registerIcons({...}))`.
