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
| `hover` | none | `alive`: a 600 ms life animation on pointer enter and on focus. |

The element sets `display: inline-block` and `line-height: 0` if you did not set them.

## Methods

Each returns a Promise.

- `el.morphTo(name)`: same as setting `name`, with a Promise.
- `el.hide()`: sets the name to empty and plays the hide effect.
- `el.show(name)`: shows the icon with the show effect. On an icon that is visible it is the same as `morphTo`.
- `el.playAlive()`: plays the life animation once.

The Promise gives `true` when the animation ends, or when the icon changes at once (same name, or reduced motion for `morphTo`, `hide`, `show`). It gives `false` when:
- A new call interrupts the running animation (the old call resolves `false`).
- `playAlive()` does not play: the icon is empty or hidden, reduced motion is on, an animation already runs, or the alive duration is 0 or less.

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

Stable exports: `defineMorphIcon`, `registerLucide`, `registerIcons`, `registerFamilyIcons`, `registerFamilyFile`, `registerSVGs`, `planMorph`, `planAlive`, `planEffect`, `MorphIcon`, `alive`, `getIconNames`, `iconToSVG`, `DEFAULTS`, `easings`.

`getIconNames()` lists the registered names. Use it to check that a name exists.
`alive(el)` wires the life animation on pointer enter and focus for code use. It returns a cleanup function.

Types: `shape-aware-morph` ships `index.d.ts`. It types `<morph-icon>` in JSX and `HTMLElementTagNameMap`.
