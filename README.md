# shapcn

**Shape-aware icon morphing**

Change the icon name. shapcn animates the rest.

Any icon morphs into any other. shapcn rigs the shapes first, so parts move in order instead of every point sliding at once.

Website and playground: https://shapcn.com. Docs: https://shapcn.com/docs.

## Install

Status: the script tag works today. The npm package is in progress. Source is on GitHub.

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
| `hover` | `wiggle`, `grow`, `bend`, `bold` (stays while hovered), `cascade`, `move` (sways with the pointer). `alive` is the old name of `wiggle`. |
| `press` | `pop`, `squash`, `squat-jump`, `burst` |
| `hover-strength`, `press-strength` | 0.5 to 3. Default 1.5. |
| `hover-duration`, `press-duration` | Milliseconds. Each style has its own default. |

A press can change the icon. The new icon morphs while the press plays: `el.pressTo('circle-check')`. Setting `name` while the press runs does the same. With `prefers-reduced-motion: reduce`, hover and press do nothing.

### npm

The package `shape-aware-morph` is in progress. It is not on npm yet.

### Build from source

```sh
git clone https://github.com/seahorsecastle/shapcn.git
cd shapcn/package
npm install && npm run build
```

The build writes `dist/morph-icon.js`.

### Sizes

79 KB engine, gzipped. 237 KB with all 1,858 Lucide icons.

## Use with AI coding agents

This repo has an agent skill at `skills/shapcn`. It teaches a coding agent how to install shapcn, use `<morph-icon>` in HTML, React, Vue and Svelte, register icons, and fix common errors. Copy the `skills/shapcn` folder into your agent's skills folder (for Claude Code: `.claude/skills/shapcn`).

A plain-text summary for any model is at https://shapcn.com/llms.txt.

## Repository layout

- `package/`: the engine and the npm package source, with tests and build.
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
