# Feel

The `easing` attribute sets how a morph feels. Three presets cover most uses: `smooth`, `spring`, and `elastic`.

| Preset | What it does |
| --- | --- |
| `smooth` | Eases in and out. It is the same curve as the default `easeInOutCubic`. It never goes past the end shape. |
| `spring` | Goes past the end shape by about 16%, then settles with one wobble. |
| `elastic` | Goes past the end shape by about 53%, then settles with three to five wobbles. |

The three presets run on one clock below. All three icons start and end at the same time.

```html
<morph-icon name="mic" size="56" duration="900" easing="smooth"></morph-icon>
<morph-icon name="mic" size="56" duration="900" easing="spring"></morph-icon>
<morph-icon name="mic" size="56" duration="900" easing="elastic"></morph-icon>
```

## The curves

Each chart plots progress against time. The dashed line is the end shape. A curve above the dashed line goes past it.

| Preset | Highest value (1.00 is the end shape) |
| --- | --- |
| `smooth` | 1.00 |
| `spring` | 1.16 |
| `elastic` | 1.53 |

The engine plans the structure of a morph with the smooth timing. The order of the parts does not change with the feel.

## Use a preset

Set the attribute.

```html
<morph-icon name="mic" easing="spring" duration="600"></morph-icon>
```

In code, pass `easing` to `planMorph`. See [JavaScript](https://shapcn.com/docs/javascript.md).
