# Element

`<morph-icon>` is a custom element. Change its `name` and the icon morphs. Change any other attribute and the element updates.

```html
<morph-icon name="mic" size="32" duration="450"></morph-icon>
```

The element sets `display: inline-block` and `line-height: 0` on itself if you set no value. The default color is `currentColor`, so the CSS `color` of the parent sets the stroke color.

## Attributes

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

The element observes these nine attributes and no others. If you remove an attribute, the element keeps the last value.

## name

The icon to show. Set it again and the icon morphs to the new one. The first demo morphs between two icons.

```html
<morph-icon name="mic" size="48"></morph-icon>
```

An empty `name` hides the icon with the `effect`. A name after an empty one shows it. See [Effects](https://shapcn.com/docs/effects.md).

The element also has a `name` property. `el.name = 'mic-off'` sets the attribute.

## size

Width and height in pixels. The default is `24`. The icon draws on a 24 by 24 grid and scales to the size.

```html
<morph-icon name="heart" size="16"></morph-icon>
<morph-icon name="heart" size="32"></morph-icon>
<morph-icon name="heart" size="64"></morph-icon>
```

## color

The stroke color. Any CSS color works. The default `currentColor` follows the CSS `color` of the parent.

```html
<morph-icon name="sun" size="40"></morph-icon>
<morph-icon name="sun" size="40" color="#d93a3a"></morph-icon>
<morph-icon name="sun" size="40" color="rebeccapurple"></morph-icon>
```

## stroke-width

The stroke width on the 24 grid. The default is `2`.

```html
<morph-icon name="bell" size="40" stroke-width="1"></morph-icon>
<morph-icon name="bell" size="40" stroke-width="2"></morph-icon>
<morph-icon name="bell" size="40" stroke-width="3"></morph-icon>
```

A family with a stroke width other than 2 (for example Phosphor) draws with its own width.

## duration

Morph time in milliseconds. The default is `450`.

```html
<morph-icon name="play" size="40" duration="150"></morph-icon>
<morph-icon name="play" size="40" duration="450"></morph-icon>
<morph-icon name="play" size="40" duration="1200"></morph-icon>
```

## easing

The speed curve of the morph. The default is `easeInOutCubic`. The values are `linear`, `easeInOutCubic`, `easeOutCubic`, `smooth`, `spring`, `elastic`, and `gentle`. The page [Feel](https://shapcn.com/docs/feel.md) covers `smooth`, `spring`, and `elastic`.

```html
<morph-icon name="check" size="40" easing="linear" duration="900"></morph-icon>
<morph-icon name="check" size="40" easing="easeInOutCubic" duration="900"></morph-icon>
<morph-icon name="check" size="40" easing="easeOutCubic" duration="900"></morph-icon>
<morph-icon name="check" size="40" easing="gentle" duration="900"></morph-icon>
```

## stagger

Spreads the start of the strokes over part of the time. A number from 0 to 0.99. The default is `0`: all strokes start together. At `0.9`, each stroke starts later than the one before it.

```html
<morph-icon name="mic" size="48" duration="900" stagger="0"></morph-icon>
<morph-icon name="mic" size="48" duration="900" stagger="0.5"></morph-icon>
<morph-icon name="mic" size="48" duration="900" stagger="0.9"></morph-icon>
```

## effect

The effect for hide and show. Set `name` to an empty string to hide. Set a name to show. Each of the seven names works in both directions. The default is `implode` to hide and `expand` to show. See [Effects](https://shapcn.com/docs/effects.md) for all seven.

```html
<morph-icon name="heart" size="48" effect="implode"></morph-icon>
<morph-icon name="heart" size="48" effect="explode"></morph-icon>
<morph-icon name="heart" size="48" effect="scale"></morph-icon>
```

## hover

Set `hover="alive"` and the icon plays a short life animation on pointer enter and on keyboard focus. It lasts 600 ms. The icon looks the same at the end. Hover over the icons below, or press Tab to focus a button.

```html
<button type="button" aria-label="Notifications"><morph-icon name="bell" size="40" hover="alive"></morph-icon></button>
<button type="button" aria-label="Brightness"><morph-icon name="sun" size="40" hover="alive"></morph-icon></button>
<button type="button" aria-label="Wi-Fi"><morph-icon name="wifi" size="40" hover="alive"></morph-icon></button>
<button type="button" aria-label="Favorite"><morph-icon name="heart" size="40" hover="alive"></morph-icon></button>
```

The engine picks one of four moves from the shape of the icon: `radiate`, `ripple`, `swing`, or `pop`. The bell swings, the sun radiates, the Wi-Fi icon ripples, and the heart pops. Focus counts on the element or on its nearest button or link. The page [Accessibility](https://shapcn.com/docs/accessibility.md) has more.

## Methods

The element has four methods. Each returns a Promise.

| Method | What it does |
| --- | --- |
| `morphTo(name)` | Morphs to another icon. Same as setting `name`, but it returns the Promise. |
| `hide()` | Plays the hide effect. The `name` becomes empty. |
| `show(name)` | Plays the show effect. |
| `playAlive()` | Plays the alive animation once. |

Each method takes an optional options object that overrides the attributes for that call. The Promise gives `true` when the animation ends, or when the icon changes at once with no animation (same name, or reduced motion for `morphTo`, `hide` and `show`). The Promise gives `false` in these cases:

- A new `morphTo`, `hide`, `show` or `playAlive` call that starts an animation interrupts the running animation. The interrupted call resolves `false`.
- `playAlive()` does not play, because the icon is empty or hidden, reduced motion is on, an animation is already running (a morph or an alive run), or the alive duration is 0 or less.

```html
<script type="module" src="https://shapcn.com/morph-icon.js"></script>
<morph-icon name="mic" size="48"></morph-icon>
<script type="module">
  const icon = document.querySelector('morph-icon');
  const done = await icon.morphTo('mic-off');   // true when the morph ends
  await icon.hide();                            // the name is now empty
  await icon.show('mic');
  console.log('done', done);
</script>
```
