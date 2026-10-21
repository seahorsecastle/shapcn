# Accessibility

## Reduced motion

When the user sets `prefers-reduced-motion: reduce`, icons change at once with no animation. The attribute `hover="alive"` does nothing. In code, `morphTo`, `hide`, and `show` resolve `true` at once. `playAlive` resolves `false`.

To turn this off, pass `respectReducedMotion: false` to `MorphIcon`.

```js
import { MorphIcon } from 'shape-aware-morph';

const icon = new MorphIcon(document.querySelector('#slot'), {
  name: 'mic',
  respectReducedMotion: false,   // always animate
});
```

The engine reads the setting each time an animation starts. Turn on reduced motion in your system settings, then reload this page. The demos here then change without motion.

## Focus

The element is not focusable. It is a picture. Put it in a `button` or a link, and the control takes focus as usual.

With `hover="alive"`, the alive animation plays on pointer enter and on keyboard focus. The focus handler goes on the nearest ancestor that is a `button`, `a`, `input`, `select`, or `textarea`, or that has a `tabindex` or `role="button"`. If there is none, it goes on the element.

```html
<button type="button" aria-label="Notifications"><morph-icon name="bell" size="32" hover="alive"></morph-icon></button>
```

Press Tab to move focus to the button above. The bell swings.

## aria

The element sets no aria attributes. You add them.

- An icon next to a text label is decoration. Set `aria-hidden="true"` on the icon.
- An icon that carries meaning alone needs a name. Set `role="img"` and `aria-label` on the element, or put an `aria-label` on the button that holds it.
- A name that changes needs a label that changes with it. Update the label when you change the `name`.

```html
<!-- decoration: the button has text -->
<button type="button"><morph-icon name="mic" aria-hidden="true"></morph-icon> Mute</button>

<!-- the icon is the only content -->
<button type="button" aria-label="Mute"><morph-icon name="mic" aria-hidden="true"></morph-icon></button>

<!-- a standalone icon with a meaning -->
<morph-icon name="bell" role="img" aria-label="Notifications"></morph-icon>
```
