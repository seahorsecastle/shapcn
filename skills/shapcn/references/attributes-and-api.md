# Attributes and API

## Attributes

Change `name` and the icon morphs. Change any other attribute and the element updates.

| Attribute | Default | Meaning |
| --- | --- | --- |
| `name` | none | Icon name. Empty name hides the icon with the effect. A name after an empty one shows it with the effect. |
| `size` | `24` | Width and height in pixels. |
| `color` | `currentColor` | Stroke color. |
| `stroke-width` | `2` | Stroke width on the 24 grid. |
| `duration` | `450` | Morph time in ms. |
| `easing` | `easeInOutCubic` | `linear`, `easeInOutCubic`, `easeOutCubic`, `smooth`, `spring`, `elastic`, `gentle`. |
| `stagger` | `0` | 0 to 0.99. Spreads the start of the strokes. |
| `effect` | `implode` to hide, `expand` to show | `implode`, `explode`, `assemble`, `draw`, `erase`, `scale`, `expand`. |
| `hover` | none | `wiggle` (600 ms), `grow` (400), `bend` (400), `bold` (250, stays while hovered), `cascade` (500), `move` (900, sways with the pointer). Plays on pointer enter and on focus. `alive` is the old name of `wiggle`. |
| `press` | none | `pop` (300 ms), `squash` (300), `squat-jump` (500), `burst` (500). Plays on pointer down, and on Enter and Space. `anticipate-jump` is the old name of `squat-jump`. |
| `hover-strength`, `press-strength` | `1.5` | How far it moves. 0.5 to 3. |
| `hover-duration`, `press-duration` | the style's own | Milliseconds. |

The element sets `display: inline-block` and `line-height: 0` if you did not set them.

## Methods

Each returns a Promise.

- `el.morphTo(name)`: same as setting `name`, with a Promise.
- `el.hide()`: sets the name to empty and plays the hide effect.
- `el.show(name)`: shows the icon with the show effect. On an icon that is visible it is the same as `morphTo`.
- `el.playAlive()`: plays the hover style once.
- `el.playPress()`: plays the press style once.
- `el.pressTo(name)`: the icon changes to `name` inside the press style (default `squash`). Setting `name` while a press runs does the same.
- `el.leaveAlive()`: goes back to rest from the frame on screen (the pointer left).

The Promise gives `true` when the animation ends, or when the icon changes at once (same name, or reduced motion for `morphTo`, `hide`, `show`). It gives `false` when:
- A new call interrupts the running animation (the old call resolves `false`).
- `playAlive()` or `playPress()` does not play: the icon is empty or hidden, reduced motion is on, an animation already runs, or the duration is 0 or less.

An interrupt is smooth: the new morph starts from the picture on screen.

Per-call options: `el.morphTo('pause', { easing: 'spring', duration: 300 })`. The option names are the camelCase forms: `duration`, `easing`, `stagger`, `effect`, `strokeWidth`.

## Style it with CSS

Set `color` on a parent (the stroke is `currentColor`):

```css
.btn { color: #111; }
.btn:hover { color: #0a7; }
```

## JavaScript API (npm)

```js
import { registerLucide, planMorph } from 'shape-aware-morph';
await registerLucide();
const plan = planMorph('mic', 'mic-off', { easing: 'spring' });
const entries = plan.frame(0.5); // t from 0 to 1, no DOM
```

Stable exports: `defineMorphIcon`, `registerLucide`, `registerIcons`, `registerFamilyIcons`, `registerFamilyFile`, `registerSVGs`, `planMorph`, `planAlive`, `planPress`, `createSway`, `retargetPlan`, `HOVER_STYLES`, `PRESS_STYLES`, `planEffect`, `MorphIcon`, `alive`, `getIconNames`, `iconToSVG`, `DEFAULTS`, `easings`.

`getIconNames()` lists the registered names. Use it to check that a name exists.
`alive(el)` wires the hover on pointer enter and focus for code use. It returns a cleanup function.

Plans without the element: `planAlive(name, { style: 'grow' })`, `planPress(name, { style: 'burst', to: 'check' })`, and `createSway(name)` for the live `move` sway. Each plan has `frame(t)`. At `t = 0` and `t = 1` it draws the rest icon (with `to`: the old icon, then the new icon).

Types: `shape-aware-morph` ships `index.d.ts`. It types `<morph-icon>` in JSX and `HTMLElementTagNameMap`.
