# Icons

The examples that import `shape-aware-morph` use the npm package. It is not published yet. See [Install](https://shapcn.com/docs/install.md).

## Lucide

The script tag build has the 1,858 Lucide icons built in. Use any Lucide name.

```html
<morph-icon name="camera" size="48"></morph-icon>
```

With the npm package, `registerLucide()` registers all the Lucide icons. It loads them on demand. To ship fewer icons, import the ones you use. Each icon family is its own module with one named export per icon (camelCase). A bundler drops the icons you do not import.

```html
<script type="module">
  import { defineMorphIcon, registerIcons } from 'shape-aware-morph';
  import { mic, micOff } from 'shape-aware-morph/lucide';

  registerIcons({ mic, 'mic-off': micOff });
  defineMorphIcon();

  const icon = document.createElement('morph-icon');
  icon.setAttribute('name', 'mic');
  document.body.append(icon);
  setTimeout(() => icon.setAttribute('name', 'mic-off'), 500);
</script>
```

The default export of `shape-aware-morph/lucide` is the whole map keyed by the original names (`import all from 'shape-aware-morph/lucide'`).

Names that start with a digit, or that are reserved words, get a leading underscore in the export (for example `_24Hours`).

## The 12 sets

All 12 sets are separate modules. The icon names inside `<morph-icon>` are `<family>:<name>`, for example `tabler-outline:bell`. Lucide names have no prefix.

| Import path | Style | License |
| --- | --- | --- |
| `shape-aware-morph/lucide` | stroke | Lucide (ISC) |
| `shape-aware-morph/tabler-outline` | stroke | Tabler (MIT) |
| `shape-aware-morph/tabler-filled` | fill | Tabler (MIT) |
| `shape-aware-morph/hugeicons` | stroke | Hugeicons (MIT) |
| `shape-aware-morph/phosphor-thin-s` | stroke | Phosphor (MIT) |
| `shape-aware-morph/phosphor-light-s` | stroke | Phosphor (MIT) |
| `shape-aware-morph/phosphor-regular-s` | stroke | Phosphor (MIT) |
| `shape-aware-morph/phosphor-bold-s` | stroke | Phosphor (MIT) |
| `shape-aware-morph/phosphor-fill` | fill | Phosphor (MIT) |
| `shape-aware-morph/phosphor-duotone-s` | stroke | Phosphor (MIT) |
| `shape-aware-morph/remix-line-s` | stroke | Remix (Remix Icon License 1.0) |
| `shape-aware-morph/remix-fill` | fill | Remix (Remix Icon License 1.0) |

## registerFamilyIcons

The sets other than Lucide use `registerFamilyIcons(family, icons)`. Pass the family id and a map of the icons you import. The names become `<family>:<name>`.

```html
<script type="module">
  import { defineMorphIcon, registerFamilyIcons } from 'shape-aware-morph';
  import { bell, bellOff } from 'shape-aware-morph/tabler-outline';

  registerFamilyIcons('tabler-outline', { bell, 'bell-off': bellOff });
  defineMorphIcon();

  const icon = document.createElement('morph-icon');
  icon.setAttribute('name', 'tabler-outline:bell');
  document.body.append(icon);
  setTimeout(() => icon.setAttribute('name', 'tabler-outline:bell-off'), 500);
</script>
```

The default export of a family module is the full family spec. You can pass it to `registerFamilyFile`. An unknown family id throws an error that lists the known ids.

## Your own icons

`registerSVGs` reads plain SVG markup. It supports `path`, `line`, `polyline`, `polygon`, `circle`, `ellipse`, and `rect`. It scales the `viewBox` to the 24 grid. It returns the list of registered names.

```js
import { registerLucide, registerSVGs, planMorph } from 'shape-aware-morph';

await registerLucide();

const names = registerSVGs({
  'my-spark': '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6.1L12 16.6 6.6 19.6l1.2-6.1L3.3 9.3l6.1-.7z"/></svg>',
}, { kind: 'stroke' });

console.log(names);   // ['my-spark']
const plan = planMorph('my-spark', 'heart');   // the name works like any icon name
console.log(plan.frame(0.5).length > 0);       // true
// <morph-icon name="my-spark">
```

- `kind: 'stroke'` (default): outline icons with stroke width 2. Names stay as you give them.
- `kind: 'fill'`: solid icons. Names become `svg:<name>`. Use `family: 'mine'` to choose the prefix.
- A `viewBox` with a non-zero origin is not supported. Groups, transforms, and styles are ignored.
- Solid shapes (`circle`, `ellipse`, `rect`, `polygon`) become paths, so they morph like path icons.
- An invalid path, a `kind` other than `'stroke'` or `'fill'`, or a non-object argument throws an error.

Your own icons then morph with every other icon.

```html
<script type="module">
  import { defineMorphIcon, registerLucide, registerSVGs } from 'shape-aware-morph';

  await registerLucide();
  registerSVGs({
    'my-spark': '<svg viewBox="0 0 24 24"><path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6.1L12 16.6 6.6 19.6l1.2-6.1L3.3 9.3l6.1-.7z"/></svg>',
  });
  defineMorphIcon();

  const icon = document.createElement('morph-icon');
  icon.setAttribute('name', 'my-spark');
  document.body.append(icon);
  setTimeout(() => icon.setAttribute('name', 'heart'), 500);
</script>
```

For a lower-level path, `registerIcons(map)` takes icon nodes in the Lucide format. See [JavaScript](https://shapcn.com/docs/javascript.md).
