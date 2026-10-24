# Contributing to shapcn

Thank you for helping. This file says how to build and test the engine, and what a good change looks like.

## Build and test

You need Node 20 or newer.

```sh
git clone https://github.com/seahorsecastle/shapcn.git
cd shapcn/package
npm install
npm run build
npm test
```

`npm run build` does two jobs:

1. `scripts/gen-icons.mjs` reads `data/` and writes one module per icon set (for example `lucide.js` and `tabler-outline.js`) and `families-meta.js`.
2. `scripts/build-dist.mjs` writes `dist/morph-icon.js`: the engine, the Lucide icons and the `<morph-icon>` element as one classic script.

The generated icon modules and `dist/` are not in git. Do not edit them by hand. Change the engine files or the data, then build again.

`npm test` runs the tests in `package/test/`. They need only the `package/` folder and take about a minute. The hover and press tests run on a sample of the Lucide icons. `SHAPCN_FULL=1 node --test test/hover-press.test.mjs` runs all 1,858 icons (a few minutes).

## Where things are

- `package/core.js`: the planner. It reads two icons and plans every frame.
- `package/render.js`, `package/effects.js`, `package/regions.js`: drawing, effects, and the planner for solid icons.
- `package/dom.js`: the `<morph-icon>` element.
- `package/svg.js`: `registerSVGs`, which turns your own SVG files into icons.
- `package/data/`: the icon data that the build reads.

## The motion rules

Every change must keep these rules. They are the look of shapcn.

1. Parts move. A part of an icon slides, turns or stretches to its new place. It does not fade out and fade in.
2. No fading. Opacity is not a tool to hide a change. A part that is not in the new icon goes into the body of the icon and is gone.
3. Body first. The big shapes change first. Small parts follow the shape they touch.
4. New parts grow from their edge. A part that is new grows out of the shape it touches. It does not appear in the middle of the air.
5. No doubled lines. At no time may two strokes lie on top of each other and look like one thick line, or leave a ghost behind.
6. Exact ends. At the start the picture is the first icon. At the end it is the second icon.
7. Pieces that stay, stay. If the same piece is in both icons (the body of a microphone in `mic` and `mic-off`), it must not move.

Hover and press styles follow the same spirit. The first and the last frame are the rest icon. No point goes more than 3 units outside the 24 box. The stroke width and the opacity do not change (except the stroke weight of `bold`). Strokes that touch stay joined. A style should be interruptible: a pointer that leaves in the middle goes back from the frame on screen (`wiggle` and `cascade` are the two that finish their short run).

## How to propose a change

Show before and after, live. A description is not enough, and a still image is not enough.

1. Make a small page that plays the old build and the new build side by side on one clock, for the pairs you changed.
2. Include a few pairs you did not change, to show that they look the same.
3. Add or change a test in `package/test/` if the change fixes a crash or an end state.
4. Open a pull request with the page, the pairs, and one sentence on which rule the change serves.

Keep the change small. Reuse what is there before you add new code.

## License

By contributing you agree that your work is under the MIT license of this repo.
