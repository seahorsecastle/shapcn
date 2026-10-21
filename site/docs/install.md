# Install

## Script tag

The script tag works today. It is one file. It defines `<morph-icon>` and loads the Lucide icons.

```html
<script type="module" src="https://shapcn.com/morph-icon.js"></script>
<morph-icon name="mic" size="48"></morph-icon>
```

The script also sets `window.shapcn`. The object holds these names: `DEFAULTS`, `easings`, `registerIcons`, `registerFamily`, `registerFamilyFile`, `getIconInfo`, `getFamily`, `getIconNames`, `iconToSVG`, `planMorph`, `planAlive`, `MorphIcon`, and `defineMorphIcon`.

The script tag build has the Lucide icons only. It does not expose `registerSVGs`, `registerFamilyIcons`, or `alive`. Use the npm package for those.

Use `window.shapcn` from a module script. A module script runs after the page loads, so the API is ready.

```html
<script type="module" src="https://shapcn.com/morph-icon.js"></script>
<script type="module">
  const { planMorph } = window.shapcn;
  const plan = planMorph('mic', 'mic-off');
  console.log(plan.frame(0.5).length, 'drawing entries at the middle');
</script>
```

## npm

**Coming soon.** The package `shape-aware-morph` is not published yet. The commands below show how the install will work.

```sh
npm i shape-aware-morph
```

The package is ES modules only. In Node, `require('shape-aware-morph')` works only on Node 22.12 or newer. Use `import` on older versions.

The core has no icon data. You import only the icons you use (see [Icons](https://shapcn.com/docs/icons.md)). The core alone is about 181 kB minified (70 kB gzipped). Each icon adds a few hundred bytes.

Use it in a bundler:

```js
import { registerLucide, defineMorphIcon } from 'shape-aware-morph';

await registerLucide();   // loads the Lucide icons
defineMorphIcon();        // defines <morph-icon>
```

Use it from a CDN as one file. It loads the Lucide icons and defines `<morph-icon>` for you. It also sets `window.shapcn`.

```html
<script src="https://unpkg.com/shape-aware-morph@0.1.0"></script>
<morph-icon name="mic"></morph-icon>
```

jsDelivr works too: `https://cdn.jsdelivr.net/npm/shape-aware-morph@0.1.0`.

## License

shapcn is MIT. Lucide icon data is ISC. The other icon sets keep their own licenses (see [Icons](https://shapcn.com/docs/icons.md)).
