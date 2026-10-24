---
name: shapcn
description: Add morphing icons to a web project with shapcn (the <morph-icon> custom element, npm package shape-aware-morph). Use this skill whenever the user wants an icon to animate into another icon, for example play to pause, copy to check, sun to moon, eye to eye-off, menu to close, or upload to check. Also use it for "morph icon", "animated icon swap", "icon transition", "shapcn", "shape-aware-morph", "morph-icon", Lucide, Tabler, Phosphor, Remix or Hugeicons icons that must change shape, and for icons that react on hover or on click (hover and press styles). Use it even when the user does not name the library but asks for smooth icon state changes in HTML, React, Vue or Svelte.
---

# shapcn: morphing icons

shapcn adds one custom element: `<morph-icon name="play">`. When you change `name`, the old icon morphs into the new icon. The element plans every frame in the browser. You write no keyframes.

Do not invent options. Use only the attributes and methods in this skill and its references.

## Steps

1. Pick the install path (see below).
2. Add `<morph-icon name="...">` inside the control (usually a `<button>`).
3. Change the `name` attribute (or call `morphTo`) when the state changes.
4. Set `easing`, `duration`, `hover`, `press`, or `effect` only when the user asks for a feel.
5. Add the accessible name on the button, not on the icon. See "Accessibility".

## Install path

The package is on npm as `shape-aware-morph`. Use npm in a project with a bundler (a React, Vue or Svelte app). See `references/install-and-icons.md`. Use the script tag for plain HTML, prototypes and CMS pages:

```html
<script type="module" src="https://shapcn.com/morph-icon.js"></script>
```

Use a classic script (`<script src="https://shapcn.com/morph-icon.js"></script>`, no `type="module"`) when inline code must use `window.shapcn` right away, for example to register your own icons. The file works both ways.

The script tag build defines `<morph-icon>` for you and includes all Lucide icons. It also sets `window.shapcn`. It needs no bundler and no `registerLucide()` call.

Use the script tag for plain HTML, prototypes, and CMS pages.

## Smallest working example

```html
<script type="module" src="https://shapcn.com/morph-icon.js"></script>

<button id="t" aria-label="Play">
  <morph-icon name="play" aria-hidden="true"></morph-icon>
</button>
<script>
  const t = document.getElementById('t');
  const icon = t.querySelector('morph-icon');
  let playing = false;
  t.addEventListener('click', () => {
    playing = !playing;
    icon.setAttribute('name', playing ? 'pause' : 'play');
    t.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  });
</script>
```

## Attributes (all on `<morph-icon>`)

| Attribute | Default | Notes |
| --- | --- | --- |
| `name` | none | Icon name. Change it to morph. Empty string hides the icon with an effect. |
| `size` | `24` | Pixels. |
| `color` | `currentColor` | Stroke color. Prefer CSS `color` on a parent. |
| `stroke-width` | `2` | On the 24 grid. |
| `duration` | `450` | Milliseconds. |
| `easing` | `easeInOutCubic` | `smooth`, `spring`, `elastic` are the three feels to offer. Also valid: `linear`, `easeInOutCubic`, `easeOutCubic`, `gentle`. |
| `stagger` | `0` | 0 to 0.99. |
| `effect` | `implode` (hide), `expand` (show) | `implode`, `explode`, `assemble`, `draw`, `erase`, `scale`, `expand`. |
| `hover` | none | A hover style: `grow`, `bend`, `bold`, `cascade`, `move`. Plays on pointer enter and on focus. The icon name does not change. `wiggle` (old name `alive`) is deprecated: do not use it. |
| `press` | none | A press style: `pop`, `squash`, `squat-jump`, `burst`. Plays on pointer down (a press or a tap), and on Enter and Space. |
| `hover-strength`, `press-strength` | `1.5` | 0.5 to 3. |
| `hover-duration`, `press-duration` | the style's own | Milliseconds. |

Methods (each returns a Promise): `morphTo(name)`, `hide()`, `show(name)`, `playAlive()`, `playPress()`, `pressTo(name)`. Full details: `references/attributes-and-api.md`.

## Picking a feel

- Default (no `easing`): calm and neutral. Good for most UI.
- `easing="smooth"`: ease in and out, no overshoot.
- `easing="spring"`: a small overshoot, one wobble. Good for toggles.
- `easing="elastic"`: a large overshoot. Use it for playful UI only.
- `duration`: 300 to 450 for small controls. Do not go below 200.

## Hover and press

- `hover` styles: `grow`, `bend`, `bold` (stays bold while hovered), `cascade`, `move` (sways with the pointer).
- `press` styles: `pop`, `squash`, `squat-jump`, `burst`.
- Use these names only. Other names do nothing (the deprecated wiggle plays until 0.3.0, then nothing).
- Put the icon inside a `<button>` or `<a>`. The hover plays when the pointer enters the button and when the button gets focus.
- A press that changes the icon: add `press="burst"` and call `icon.pressTo('check')`. Setting `name` while a press runs does the same. Use it for delete to done, follow to following.
- On a touch screen a tap plays the hover once.
- Do not put `hover` or `press` on an icon that also changes on every pointer enter. Pick one job per control.

```html
<button type="button" aria-label="Delete">
  <morph-icon name="trash" press="burst" aria-hidden="true"></morph-icon>
</button>
<script>
  document.currentScript.previousElementSibling.addEventListener('click', (e) => {
    e.currentTarget.querySelector('morph-icon').pressTo('check');
  });
</script>
```

## Show and hide

Set `name=""` to hide the icon. Set a name again to show it. The `effect` attribute picks the effect. Example: a status slot that is empty until an upload ends. See `references/recipes.md`.

## Accessibility

The element does not set ARIA attributes. You must do it.

- Put the label on the control: `aria-label` on the `<button>`, and update it when the state changes.
- Mark the icon decorative when the button has a label: `aria-hidden="true"` on `<morph-icon>`.
- Use a real `<button type="button">`. Do not click-handle a `<div>`.
- For a status that appears (upload done), put text in a live region (`role="status"`). The icon alone is not announced.
- Reduced motion: when the user sets `prefers-reduced-motion: reduce`, icons change at once with no animation, and `hover` and `press` do nothing. This is the default. Do not turn it off. (`respectReducedMotion: false` exists in the JS class only. Do not use it.)
- `hover` also runs on keyboard focus of the nearest button or link, and `press` runs on Enter and Space, so keyboard users get the same feedback.

## Frameworks

Plain HTML, React, Vue, and Svelte examples: `references/frameworks.md`. Short version:

- React: use the tag in JSX with string or number attributes. Define the element once in `useEffect` (npm path) or load the script tag in `index.html` (script path).
- Vue: set `compilerOptions.isCustomElement` for `morph-icon`.
- Svelte: use the tag directly. Bind `name={...}`.
- SSR (Next, Nuxt, SvelteKit): define the element only in the browser.

## Icons

- Script tag: all Lucide icons are ready. Names are Lucide names (`mic`, `mic-off`, `eye-off`).
- npm: import only the icons you use. Details: `references/install-and-icons.md`.
- Other families (Tabler, Phosphor, Remix, Hugeicons): names are `<family>:<name>`, for example `tabler-outline:bell`. Use `registerFamilyIcons`.
- The user's own SVG: `registerSVGs` (npm). On the script tag build use `window.shapcn.registerIcons` with icon nodes. Details: `references/install-and-icons.md`.

## Recipes

Play/pause, copy to check, theme switch, upload to check, password eye: `references/recipes.md`.

## When it fails

`references/troubleshooting.md`: icon name not found, ESM only, SSR errors, nothing animates, wrong colors.
