# shapcn everywhere

A Chrome extension (Manifest V3) that makes the small icons on any web page come alive. Point at an icon and it plays a hover style. Press it and it plays a click style. The motion is drawn by the real [shapcn](https://shapcn.com) engine (`planAlive`, `planPress`, `createSway`), not by CSS transforms.

- Chrome Web Store: _link coming soon_ (placeholder: `https://chromewebstore.google.com/detail/shapcn-everywhere/PLACEHOLDER`)
- Page: https://shapcn.com/extension

## What it does

- Finds small inline `<svg>` icons (12 to 48 px) inside or near a button, a link, `[role=button]` and similar. It also reads `<svg><use href="#id">` when the target is in the same page.
- Hover styles: grow, bend, bold, cascade, move (wiggle is retired). Click styles: pop, squash, squat-jump, burst. Strength 0.5 to 3 (default 1.5). Default: hover grow, click pop. Settings saved by an older version that say wiggle are read as grow.
- The popup has: Enabled, Off on this site, Hover style, Click style, Strength. Each menu row plays its style on a small live icon. Changes reach open tabs at once.
- It does nothing when `prefers-reduced-motion: reduce` is set, and it stops at once if that is turned on during a motion.

## Build and load unpacked

You need Node 20 or newer and Chrome. The extension bundles the engine from this repository's `package/` folder, so build `package/` first (it generates the Lucide icon data the popup uses).

```sh
cd package && npm install && npm run build      # once, and after engine changes
cd ../extension && npm install && npm run build  # writes content.js and popup.js next to manifest.json
```

Then in Chrome: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick this `extension/` folder. Reload tabs that were already open (Chrome adds a content script only to pages that load after the install).

## How it works

- `content.js` (one content script, all URLs) listens on `document` for `pointerover`, `pointerdown` and Enter/Space. All listeners are passive, and none stops or changes an event. It works only when one of them happens.
- For each icon it builds engine icon data with `registerSVGs`, from the icon's own shapes and its computed paint. This is why CSS-painted icons work.
- It plays the plan on an overlay `<svg>` inside a closed shadow root. The overlay is placed with the icon's screen matrix, corrected for CSS transforms and zoom above it. The page's own svg is not edited: it is hidden for the run by an attribute and a stylesheet that the extension owns, and both are removed when the run ends. A copy that the page makes during a run is never hidden.
- Layout never changes. The original element keeps its `pointer-events`, stays hit-testable, and the page's click always arrives.
- Filled icons: the engine turns a solid icon into closed outlines, and `src/fillregions.js` fills each outer outline with its holes (one region per group). On filled icons `bold` plays as `grow`, and `cascade` plays as `grow` when the icon has one region.
- Source: `src/content.js` (page logic), `src/fillregions.js`, `src/popup.js`, `src/engine.js` (what is imported from `package/`).

## Privacy

- No network request. The code has no `fetch`, XHR, WebSocket, beacon, `eval`, remote script or analytics. All code is in the package.
- No data leaves the page. The extension reads the shape and color of the small icon under the pointer, in memory, to draw it again. It stores nothing from pages.
- The only stored data is your settings in `chrome.storage.sync`: on or off, the two styles, the strength, and the host names you turned off.
- Permissions: `storage` only, and one content script on all URLs. No `tabs`, `scripting` or host permission.
- Policy: https://shapcn.com/extension/privacy

## Known limits

- Icon fonts, `<img>` icons and CSS background icons are not covered. Only inline SVG.
- `<use href="file.svg#id">` with an external file is skipped (the extension makes no request). `<use>` to a `<symbol>` in the same page works. A page with more than about 1,000 style rules, or a style sheet from another origin, can make `<use>` icons unresolvable: they are skipped.
- Skipped icons: a `viewBox` that does not start at `0 0` (for example Material Symbols), `transform`, `clip-path`, `mask` or `filter` on the shapes, gradient paint, text or images inside the svg, more than 24 shapes, shapes with different stroke caps or joins, a shape or group with opacity below 1, icons smaller than 12 px or larger than 48 px, and pages with a perspective transform above the icon.
- Only the icon's own opacity and paint color are copied to the overlay. A parent's opacity or filter is not.
- The overlay is drawn above the page. Frames (iframes) are not touched. Touch screens: a tap plays the click style, and the hover style does not play on touch.

## Tests

```sh
cd extension
npm install
npx playwright install chrome   # system Google Chrome (Linux and Windows), if it is not installed yet
npm test                        # builds, then runs both suites
```

- `test/run.mjs`: hover, click, styles, React-style page, strict-CSP page, switches, popup, safety, and (without `--no-web`) two public sites, read only. Needs Chrome, and the sites need the network. `npm test` and CI use `--no-web`.
- `test/findings.mjs`: one group per review finding (page changes during a run, clones, transforms, `<use>` resolution, observer cost, popup keyboard and storage, and more).
- The tests run on a separate **test build** (`node build.mjs --test`, in `.test-build/`) that has test hooks (`__shapcn`, fault injection). The production build has none. Chrome 137 and newer ignores `--load-extension`, so the tests load the extension with the CDP method `Extensions.loadUnpacked` in a temporary profile. `CHROME=<path>` selects another Chrome.
- Fixtures are in `test/fixtures/`. `test/gen-lucide-fixture.mjs` regenerates `lucide.html` from `package/lucide.js`.

## Files

- `manifest.json`, `popup.html`, `popup.css`, `icons/` (16, 32, 48, 128: the Lucide `shapes` mark, ink on yellow)
- `src/`, `build.mjs`, `package.json`, `test/`, `tools/make-icons.cjs` (draws the icons)

## License

MIT, as the rest of this repository (see `../LICENSE`). Lucide icon data is ISC.
