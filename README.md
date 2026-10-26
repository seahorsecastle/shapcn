# shapcn

**Shape-aware icon morphing**

Change the icon name. shapcn animates the rest.

Any icon morphs into any other. shapcn rigs the shapes first, so parts move in order instead of every point sliding at once.

Website and playground: https://shapcn.com. Docs: https://shapcn.com/docs.

## Install

The package is on npm as `shape-aware-morph` (`npm i shape-aware-morph`). The script tag works too. Source is on GitHub.

### Script tag

```html
<script type="module" src="https://shapcn.com/morph-icon.js"></script>

<morph-icon name="menu" duration="420" easing="spring"></morph-icon>
<!-- set name="x" and it morphs -->
```

Easing: `smooth`, `spring`, or `elastic`. The script includes all 1,858 Lucide icons.

### Hover and press

Add `hover` and the icon reacts to the pointer and to keyboard focus, then rests. Add `press` and it reacts to a click, a tap, Enter and Space. Neither one changes the icon into another icon.

```html
<button><morph-icon name="bell" hover="grow"></morph-icon></button>
<button><morph-icon name="trash" press="burst"></morph-icon></button>
```

| Attribute | Values |
| --- | --- |
| `hover` | `grow`, `bend`, `bold` (stays while hovered), `cascade`, `move` (sways with the pointer). `wiggle` (old name `alive`) is deprecated: it works until 0.3.0 and logs one warning. |
| `press` | `pop`, `squash`, `squat-jump`, `burst` |
| `hover-strength`, `press-strength` | 0.5 to 3. Default 1.5. |
| `hover-duration`, `press-duration` | Milliseconds. Each style has its own default. |

A press can change the icon. The new icon morphs while the press plays: `el.pressTo('circle-check')`. Setting `name` while the press runs does the same. With `prefers-reduced-motion: reduce`, hover and press do nothing.

### npm

```sh
npm i shape-aware-morph
```

The package `shape-aware-morph` is on npm. Import the engine and the icons you use (ES modules only):

```js
import { registerLucide, defineMorphIcon } from 'shape-aware-morph';

await registerLucide();   // loads the Lucide icons
defineMorphIcon();        // defines <morph-icon>
```

There are modules for 12 icon sets (`shape-aware-morph/lucide`, `shape-aware-morph/tabler-outline`, ...). See `package/README.md`. As one file from a CDN: `https://unpkg.com/shape-aware-morph` or `https://cdn.jsdelivr.net/npm/shape-aware-morph@0.2.2/dist/morph-icon.js`.

### Build from source

```sh
git clone https://github.com/seahorsecastle/shapcn.git
cd shapcn/package
npm install && npm run build
```

The build writes `dist/morph-icon.js`.

### Sizes

80 KB engine, gzipped. 170 KB with all 1,858 Lucide icons (the minified script tag build).

## Chrome extension

[`extension/`](extension) is "shapcn everywhere": a Chrome extension (Manifest V3) that makes the small icons on any page come alive on hover and click, drawn by this engine. It collects nothing and makes no network request. It is on the [Chrome Web Store](https://chromewebstore.google.com/detail/shapcn-everywhere/ndgmbakimjeaealmehopkaflfjhholif). See [`extension/README.md`](extension/README.md) to build it and load it unpacked, and https://shapcn.com/extension for the page.

## Use with AI coding agents

This repo has an agent skill at `skills/shapcn`. It teaches a coding agent how to install shapcn, use `<morph-icon>` in HTML, React, Vue and Svelte, register icons, and fix common errors. Copy the `skills/shapcn` folder into your agent's skills folder (for Claude Code: `.claude/skills/shapcn`).

A plain-text summary for any model is at https://shapcn.com/llms.txt.

## Repository layout

- `package/`: the engine and the npm package source, with tests and build.
- `extension/`: the Chrome extension "shapcn everywhere", built from `package/`, with its tests.
- `skills/shapcn`: the agent skill.
- `.github`: CI, issue and pull request templates.

## Develop

```sh
git clone https://github.com/seahorsecastle/shapcn.git
cd shapcn/package
npm install
npm run build   # generates the icon modules and dist/morph-icon.js
npm test        # builds first, then about a minute of tests
npm i --no-save playwright && npm test   # also runs the real-Chrome click test
```

Read `CONTRIBUTING.md` for the motion rules and how to propose a change.

## License

MIT. Icons: Lucide (ISC), Tabler (MIT), Hugeicons (MIT), Phosphor (MIT), Remix Icon (Remix Icon License 1.0).
