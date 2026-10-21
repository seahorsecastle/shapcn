# JavaScript

The examples that import `shape-aware-morph` use the npm package. It is not published yet. See [Install](https://shapcn.com/docs/install.md).

The package exports a plan API that does not touch the DOM, and a small DOM layer. Only the functions listed on this page are stable. The package also exports internal helpers. Do not rely on them.

## planMorph

`planMorph(from, to, opts?)` plans a morph from one icon to another. It returns a plan. `from` and `to` are icon names. The plan does not touch the DOM.

```js
import { registerLucide, planMorph } from 'shape-aware-morph';

await registerLucide();
const plan = planMorph('mic', 'mic-off', { easing: 'spring' });
const entries = plan.frame(0.5);   // drawing entries at the middle of the morph
console.log(entries.length, Object.keys(entries[0]));
```

`plan.frame(t)` takes a time `t` from 0 to 1. It returns an array of drawing entries. Each entry has a path string `d`, an `opacity`, and a `widthScale`. It also has the fields `key`, `slot`, `depth`, and `occluder`.

The next example draws one frame as SVG. It reads `d`, `opacity`, and `widthScale`. It ignores `occluder`, so overlapping strokes do not mask each other. `MorphIcon` draws with the masks.

```js
import { registerLucide, planMorph } from 'shape-aware-morph';

await registerLucide();
const plan = planMorph('mic', 'mic-off');
const paths = plan.frame(0.5)
  .map((e) => `<path d="${e.d}" opacity="${e.opacity}" stroke-width="${2 * e.widthScale}"/>`)
  .join('');
const svg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
console.log(svg.length > 0);
```

`plan.snapshot(t)` returns the exact picture at time `t`. Pass it to `planMorph` as the start point, to continue from the middle of a morph.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `easing` | `easeInOutCubic` | An easing name (see [Element](/docs/element)) or a function from `t` to a number. |
| `stagger` | `0` | A number from 0 to 0.99. |
| `occlusion` | `none` | `none`, `mask`, or `fill`. |
| `objects` | `false` | `false`, `'containers'`, `'single'`, or `true` (same as `'single'`). |

The export `DEFAULTS` holds every engine knob with its default value, frozen. The export `easings` maps the easing names to functions.

## planAlive

`planAlive(name, opts?)` returns a plan for the alive animation. It has the same `frame(t)` as `planMorph`, and a `kind` field. The icon looks the same at `frame(0)` and at `frame(1)`. The `kind` is one of `radiate`, `ripple`, `swing`, or `pop`.

```js
import { registerLucide, planAlive } from 'shape-aware-morph';

await registerLucide();
console.log(planAlive('bell').kind);   // 'swing'
console.log(planAlive('sun').kind);    // 'radiate'
```

## alive

`alive(el, opts?)` wires the alive animation to an element in code. It plays on pointer enter and on keyboard focus. `el` is a `MorphIcon` or a `<morph-icon>` element. It returns a function that removes the listeners.

```html
<button type="button" aria-label="Notifications"><morph-icon name="bell" size="32"></morph-icon></button>
<script type="module">
  import { defineMorphIcon, registerLucide, alive } from 'shape-aware-morph';

  await registerLucide();
  defineMorphIcon();
  const icon = document.querySelector('morph-icon');
  const stop = alive(icon);   // call stop() to remove the listeners
  console.log(typeof stop);
</script>
```

The attribute `hover="alive"` does the same without code.

## defineMorphIcon

`defineMorphIcon(tagName = 'morph-icon')` defines the custom element and returns its class. It returns the existing class if the tag is already defined. It returns `null` when there is no DOM, for example in Node.

```html
<script type="module">
  import { defineMorphIcon } from 'shape-aware-morph';

  defineMorphIcon('my-icon');   // <my-icon> works like <morph-icon>
  console.log(customElements.get('my-icon') !== undefined);
</script>
```

## registerIcons

`registerIcons(map)` adds icons to the registry. The icons join the Lucide family: 24 grid, stroke width 2. The map goes from a name to an icon node. An icon node is a list of `[tag, attributes]` pairs.

```html
<script type="module">
  import { defineMorphIcon, registerLucide, registerIcons } from 'shape-aware-morph';

  await registerLucide();
  registerIcons({
    'my-dash': [['path', { d: 'M5 12h14' }]],
  });
  defineMorphIcon();

  const icon = document.createElement('morph-icon');
  icon.setAttribute('name', 'my-dash');
  document.body.append(icon);
  setTimeout(() => icon.setAttribute('name', 'plus'), 500);
</script>
```

## Other exports

These exports are listed in the package README and typed in `index.d.ts`.

| Export | What it does |
| --- | --- |
| `registerLucide()` | Loads the Lucide icons into the registry. Returns a Promise of the icon map. |
| `planEffect(name, direction, effect, opts?)` | Plans an appear (`'in'`) or disappear (`'out'`) effect. |
| `MorphIcon` | The class behind the element. `new MorphIcon(target, opts)` works on an `<svg>` or a container. |
| `getIconNames(withShapes?)` | Lists the registered icon names. |
| `iconToSVG(nameOrNode, opts?)` | Returns static SVG markup of an icon. |
| `registerFamilyFile(json)` | Registers a family spec. |
| `registerFamilyIcons(family, icons)` | See [Icons](/docs/icons). |
| `registerSVGs(svgs, opts?)` | See [Icons](/docs/icons). |
| `DEFAULTS`, `easings` | The engine defaults and the easing functions. |
