# shapcn

Morph any icon into any other, the way an animator would. No keyframes, no timeline, no sloptweening.

shapcn plans every frame live. It weighs each shape of an icon, rigs the small parts to the shape they touch, and decides what morphs, what moves, and when: old parts go into the body, the body changes, new parts grow out.

Site and playground: https://shapcn.com

## Use it today

```html
<script type="module" src="https://shapcn.com/morph-icon.js"></script>

<morph-icon name="menu" duration="420" easing="spring"></morph-icon>
<!-- set name="x" and it morphs -->
```

Easing: `smooth`, `spring`, or `bouncy`. The script includes all Lucide icons.

Add `hover="alive"` and the icon comes alive a little on hover or focus, then rests (it does not change into another icon):

```html
<morph-icon name="sun" hover="alive"></morph-icon>
```

The npm package source is in `package/`. The shadcn registry comes next.

## Use with AI coding agents

This repo has an agent skill at `skills/shapcn`. It teaches a coding agent how to install shapcn, use `<morph-icon>` in HTML, React, Vue and Svelte, register icons, and fix common errors. Copy the `skills/shapcn` folder into your agent's skills folder (for Claude Code: `.claude/skills/shapcn`).

A plain-text summary for any model is at https://shapcn.com/llms.txt.

## This repo

- `package/` is the engine and the npm package source (`shape-aware-morph`).
- `site/` is the website at shapcn.com.
- `skills/shapcn` is the agent skill.

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
