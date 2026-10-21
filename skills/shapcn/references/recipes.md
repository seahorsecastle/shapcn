# Recipes

All recipes use Lucide names. Script tag shown for HTML. For React or Vue, bind `name` to state (see `frameworks.md`).
Each button has a real label. Each icon is `aria-hidden="true"`.

## Contents
1. Play / pause toggle
2. Copy to check
3. Theme switch
4. Status: upload to check
5. Password eye

## 1. Play / pause

```html
<button type="button" id="pp" aria-label="Play">
  <morph-icon name="play" easing="spring" duration="380" aria-hidden="true"></morph-icon>
</button>
<script>
  let on = false;
  pp.onclick = () => {
    on = !on;
    pp.firstElementChild.setAttribute('name', on ? 'pause' : 'play');
    pp.setAttribute('aria-label', on ? 'Pause' : 'Play');
    pp.setAttribute('aria-pressed', on);   // optional: use aria-pressed OR a changing label, not both
  };
</script>
```

If you use `aria-pressed`, keep the label fixed ("Play"). If you change the label, do not set `aria-pressed`.

## 2. Copy to check

Show the check, then go back after a delay.

```html
<button type="button" id="cp" aria-label="Copy link">
  <morph-icon name="copy" aria-hidden="true"></morph-icon>
</button>
<span role="status" id="msg" class="sr-only"></span>
<script>
  cp.onclick = async () => {
    await navigator.clipboard.writeText(location.href);
    const icon = cp.firstElementChild;
    icon.setAttribute('name', 'check');
    msg.textContent = 'Copied';
    setTimeout(() => { icon.setAttribute('name', 'copy'); msg.textContent = ''; }, 1500);
  };
</script>
```

`.sr-only` is the usual visually hidden class. Add it if the project does not have one.

A fast second click is safe: a new morph starts from the picture on screen.

## 3. Theme switch (sun / moon)

```html
<button type="button" id="th" aria-label="Switch to dark theme">
  <morph-icon name="sun" easing="spring" aria-hidden="true"></morph-icon>
</button>
<script>
  th.onclick = () => {
    const dark = document.documentElement.classList.toggle('dark');
    th.firstElementChild.setAttribute('name', dark ? 'moon' : 'sun');
    th.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  };
</script>
```

Set the first `name` from the real theme at load, so the icon matches the page.

React version:

```tsx
const [dark, setDark] = useState(false);
<button type="button" onClick={() => setDark(!dark)} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}>
  <morph-icon name={dark ? 'moon' : 'sun'} easing="spring" aria-hidden="true" />
</button>
```

## 4. Status: upload to check

Idle shows `upload`. Busy shows `loader`. Done shows `check`. Error shows `x`. Use `await` on the work, then set the name.

```js
const icon = document.querySelector('#status morph-icon');
const live = document.getElementById('live');   // <p role="status">
async function send(file) {
  icon.setAttribute('name', 'loader');
  live.textContent = 'Uploading';
  try {
    await upload(file);
    icon.setAttribute('name', 'check');
    live.textContent = 'Upload complete';
  } catch {
    icon.setAttribute('name', 'x');
    live.textContent = 'Upload failed';
  }
}
```

To clear the icon after a delay, hide it: `icon.setAttribute('name', '')` (or `icon.hide()`), and show it again with `icon.show('upload')`. Set `effect="scale"` or another effect on the tag to change the look of hide and show.

The icon is not announced by itself. The `role="status"` text is the accessible result.

## 5. Password eye

```html
<label>Password <input id="pw" type="password"></label>
<button type="button" id="eye" aria-label="Show password" aria-pressed="false">
  <morph-icon name="eye" aria-hidden="true"></morph-icon>
</button>
<script>
  eye.onclick = () => {
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    eye.firstElementChild.setAttribute('name', show ? 'eye-off' : 'eye');
    eye.setAttribute('aria-pressed', show);
  };
</script>
```

Here the label stays "Show password" and `aria-pressed` carries the state.

## Hover life animation

```html
<button type="button" aria-label="Notifications">
  <morph-icon name="bell" hover="alive" aria-hidden="true"></morph-icon>
</button>
```

The icon plays a short animation on hover and on keyboard focus, then rests. Use it on icon buttons that do not change icon.
