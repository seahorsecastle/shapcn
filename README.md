# shapcn

Morph any icon into any other, the way an animator would. No keyframes, no timeline, no sloptweening.

shapcn plans every frame live. It weighs each shape of an icon, rigs the small parts to the shape they touch, and decides what morphs, what moves, and when: old parts go into the body, the body changes, new parts grow out.

Site and playground: https://shapcn.dev

## Use it today

```html
<script type="module" src="https://shapcn.dev/morph-icon.js"></script>

<morph-icon name="menu" duration="420" easing="spring"></morph-icon>
<!-- set name="x" and it morphs -->
```

Easing: `smooth`, `spring`, or `bouncy`. The script includes all Lucide icons.

The npm package and the shadcn registry come next.

## This repo

- `site/` is the website at shapcn.dev.

## License

MIT. Icons: Lucide (ISC), Tabler (MIT), Hugeicons (MIT), Phosphor (MIT), Remix Icon (Remix Icon License 1.0).
