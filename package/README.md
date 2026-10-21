# shapcn

shapcn on npm is `shape-aware-morph`.

Morph any icon into any other, the way an animator would.

Site and live demo: https://shapcn.com

## Install

```sh
npm i shape-aware-morph
```

The package is ES modules only. In Node, `require('shape-aware-morph')` works only on Node 22.12 or newer. Use `import` on older versions.

The core has no icon data. You import only the icons you use (see "Pick your icons"). The core alone is about 181 kB minified (70 kB gzipped). Each icon adds a few hundred bytes.

## Use it

### Bundler (ESM)

```js
import { registerLucide, defineMorphIcon } from 'shape-aware-morph';

await registerLucide();   // loads the Lucide icons
defineMorphIcon();        // defines <morph-icon>

document.querySelector('morph-icon').setAttribute('name', 'mic-off');
```

```html
<morph-icon name="mic" size="32" duration="450"></morph-icon>
```

### Script tag from a CDN

One file. It loads the Lucide icons and defines `<morph-icon>` for you.

```html
<script src="https://unpkg.com/shape-aware-morph@0.1.0"></script>
<morph-icon name="mic"></morph-icon>
<script>
  document.querySelector('morph-icon').setAttribute('name', 'mic-off');
</script>
```

jsDelivr works too: `https://cdn.jsdelivr.net/npm/shape-aware-morph@0.1.0`. The script also sets `window.shapcn` with the API.

### React

Define the element once, then use the tag. Types for `<morph-icon>` come with the package.

```tsx
import { useEffect, useState } from 'react';
import { registerLucide, defineMorphIcon } from 'shape-aware-morph';

export function MicButton() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    registerLucide().then(() => defineMorphIcon());
  }, []);
  return (
    <button onClick={() => setOn(!on)}>
      <morph-icon name={on ? 'mic' : 'mic-off'} duration="420" />
    </button>
  );
}
```

Use string or number values for the attributes, as above.

## Pick your icons

Each icon family is its own module with one named export per icon (camelCase). A bundler drops the icons you do not import.

```js
import { defineMorphIcon, registerIcons } from 'shape-aware-morph';
import { mic, micOff } from 'shape-aware-morph/lucide';

registerIcons({ mic, 'mic-off': micOff });
defineMorphIcon();
```

The default export of `shape-aware-morph/lucide` is the whole map keyed by the original names (`import all from 'shape-aware-morph/lucide'`). `registerLucide()` still registers all Lucide icons, and it loads them on demand.

The other families use `registerFamilyIcons`. The names become `<family>:<name>`.

```js
import { registerFamilyIcons } from 'shape-aware-morph';
import { bell, bellOff } from 'shape-aware-morph/tabler-outline';

registerFamilyIcons('tabler-outline', { bell, 'bell-off': bellOff });
// <morph-icon name="tabler-outline:bell">
```

| Module | Family |
| --- | --- |
| `shape-aware-morph/lucide` | Lucide (ISC) |
| `shape-aware-morph/tabler-outline`, `tabler-filled` | Tabler (MIT) |
| `shape-aware-morph/hugeicons` | Hugeicons (MIT) |
| `shape-aware-morph/phosphor-thin-s`, `-light-s`, `-regular-s`, `-bold-s`, `-duotone-s`, `phosphor-fill` | Phosphor (MIT) |
| `shape-aware-morph/remix-line-s`, `remix-fill` | Remix (Remix Icon License 1.0) |

Names that start with a digit or are reserved words get a leading underscore (`_24Hours`). The default export of a family module is the full family spec. You can pass it to `registerFamilyFile`.

## Your own icons

`registerSVGs` reads plain SVG markup. It supports `path`, `line`, `polyline`, `polygon`, `circle`, `ellipse`, and `rect`. It scales the `viewBox` to the 24 grid.

```js
import { registerSVGs } from 'shape-aware-morph';

registerSVGs({
  star: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6.1L12 16.6 6.6 19.6l1.2-6.1L3.3 9.3l6.1-.7z"/></svg>',
}, { kind: 'stroke' });
// <morph-icon name="star">
```

- `kind: 'stroke'` (default): outline icons with stroke width 2. Names stay as you give them.
- `kind: 'fill'`: solid icons. Names become `svg:<name>`. Use `family: 'mine'` to choose the prefix.
- A `viewBox` with a non-zero origin is not supported. Groups, transforms, and styles are ignored.
- Solid shapes (`circle`, `ellipse`, `rect`, `polygon`) become paths, so they morph like path icons.
- An invalid path, a `kind` other than `'stroke'` or `'fill'`, or a non-object argument throws an error.
- It returns the list of registered names.

## Attributes

Change `name` and the icon morphs. Change any other attribute and the element updates.

| Attribute | Default | Meaning |
| --- | --- | --- |
| `name` | none | The icon name, for example `mic`. An empty name hides the icon with the effect. A name after an empty one shows it with the effect. |
| `size` | `24` | Width and height in pixels. |
| `color` | `currentColor` | Stroke color. |
| `stroke-width` | `2` | Stroke width on the 24 grid. |
| `duration` | `450` | Morph time in milliseconds. |
| `easing` | `easeInOutCubic` | One of `linear`, `easeInOutCubic`, `easeOutCubic`, `smooth`, `spring`, `elastic`, `gentle`. |
| `stagger` | `0` | Spreads the start of the strokes over part of the time. A number from 0 to 0.99. |
| `effect` | `implode` to hide, `expand` to show | The effect for hide and show: `implode`, `explode`, `assemble`, `draw`, `erase`, `scale`, `expand`. |
| `hover` | none | Set `alive` to play a short life animation on pointer enter and on keyboard focus. It lasts 600 ms. |

The element also has the methods `morphTo(name)`, `hide()`, `show(name)` and `playAlive()`. Each returns a Promise. The Promise gives `true` when the animation ends, or when the icon changes at once with no animation (same name, or reduced motion for `morphTo`, `hide` and `show`). The Promise gives `false` in these cases:

- A new `morphTo`, `hide`, `show` or `playAlive` call that starts an animation interrupts the running animation. The interrupted call resolves `false`.
- `playAlive()` does not play, because the icon is empty or hidden, reduced motion is on, an animation is already running (a morph or an alive run), or the alive duration is 0 or less.

## JavaScript API

```js
import { registerLucide, planMorph } from 'shape-aware-morph';

await registerLucide();
const plan = planMorph('mic', 'mic-off', { easing: 'spring' });
const entries = plan.frame(0.5);   // drawing entries at the middle of the morph
```

`frame(t)` takes a time from 0 to 1. The plan does not touch the DOM. The package also exports internal helpers. Only the functions listed here are stable.

Other exports: `planAlive`, `alive`, `planEffect`, `MorphIcon`, `getIconNames`, `iconToSVG`, `registerIcons`, `registerFamilyFile`, `registerFamilyIcons`, `registerSVGs`, `DEFAULTS`, `easings`.

## Reduced motion

When the user sets `prefers-reduced-motion: reduce`, icons change at once with no animation, and `hover="alive"` does nothing. To turn this off, pass `respectReducedMotion: false` to `MorphIcon`.

## Icon families

All 12 sets are included as separate modules. Import only the icons you use (see "Pick your icons").

```js
import { mic } from 'shape-aware-morph/lucide';
import { bell } from 'shape-aware-morph/tabler-outline';   // also tabler-filled
import { camera01 } from 'shape-aware-morph/hugeicons';
import { heart } from 'shape-aware-morph/phosphor-regular-s'; // also phosphor-thin-s, -light-s, -bold-s, -duotone-s, phosphor-fill
import { home } from 'shape-aware-morph/remix-line-s';        // also remix-fill
```

## License

shapcn is MIT. Lucide icon data is ISC. See LICENSE.
