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

Add `hover="alive"` and the icon comes alive a little on hover or focus, then rests (it does not change into another icon):

```html
<morph-icon name="sun" hover="alive"></morph-icon>
```

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

75 KB engine, gzipped. 220 KB with all 1,858 Lucide icons.

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
npm test        # a few seconds
```

Read `CONTRIBUTING.md` for the motion rules and how to propose a change.

## License

MIT. Icons: Lucide (ISC), Tabler (MIT), Hugeicons (MIT), Phosphor (MIT), Remix Icon (Remix Icon License 1.0).
