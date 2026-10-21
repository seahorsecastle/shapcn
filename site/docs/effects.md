# Effects

An effect plays when an icon appears or disappears. Set the `name` of a `<morph-icon>` to an empty string to hide it. Set a name to show it. The `effect` attribute picks the effect.

```html
<morph-icon name="heart" effect="explode"></morph-icon>
```

```html
<script type="module" src="https://shapcn.com/morph-icon.js"></script>
<morph-icon name="heart" size="48" effect="explode"></morph-icon>
<script type="module">
  const icon = document.querySelector('morph-icon');
  setTimeout(() => icon.setAttribute('name', ''), 500);        // hide with explode
  setTimeout(() => icon.setAttribute('name', 'heart'), 1500);  // show with assemble
</script>
```

There are seven names: `implode`, `explode`, `assemble`, `draw`, `erase`, `scale`, and `expand`. Each name works in both directions. The direction picks the variant. The default is `implode` to hide and `expand` to show.

The names come in pairs that play the same effect: `implode` and `expand`, `explode` and `assemble`, `draw` and `erase`. `scale` stands alone. So the seven names make four looks.

In code, call `hide()` and `show(name)`. Both take an `effect` option. See [Element](https://shapcn.com/docs/element.md).

Each demo below hides and shows the icon again every two seconds.

## implode

The parts go into the body. The body becomes a simple shape. The shape shrinks to the center. This is the default for hiding.

```html
<morph-icon name="heart" size="56" effect="implode"></morph-icon>
```

## expand

The reverse of `implode`, with an ease-out. This is the default for showing. The parts grow out of a point at the center.

```html
<morph-icon name="heart" size="56" effect="expand"></morph-icon>
```

## explode

Every stroke flies away from the center, turns, and shrinks.

```html
<morph-icon name="heart" size="56" effect="explode"></morph-icon>
```

## assemble

The reverse of `explode`, with an ease-out. The strokes fly in and settle into the icon.

```html
<morph-icon name="heart" size="56" effect="assemble"></morph-icon>
```

## draw

The strokes draw on along their own path, in source order.

```html
<morph-icon name="heart" size="56" effect="draw"></morph-icon>
```

## erase

The strokes erase along their own path.

```html
<morph-icon name="heart" size="56" effect="erase"></morph-icon>
```

## scale

The whole icon scales to or from zero about the center. Showing uses the `gentle` easing.

```html
<morph-icon name="heart" size="56" effect="scale"></morph-icon>
```
