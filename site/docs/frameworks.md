# Frameworks

The examples that import `shape-aware-morph` use the npm package. It is not published yet. See [Install](https://shapcn.com/docs/install.md).

`<morph-icon>` is a custom element, so it works in any framework. Define the element once, then use the tag.

## Plain HTML

Use the script tag. Set the `name` attribute, or the `name` property, or call a method.

```html
<script type="module" src="https://shapcn.com/morph-icon.js"></script>
<button id="toggle" type="button" aria-label="Toggle microphone">
  <morph-icon name="mic" size="32" duration="420"></morph-icon>
</button>
<script type="module">
  const icon = document.querySelector('morph-icon');
  let on = true;
  document.getElementById('toggle').addEventListener('click', () => {
    on = !on;
    icon.name = on ? 'mic' : 'mic-off';   // same as setAttribute('name', ...)
  });
  await icon.morphTo('mic-off');          // methods return a Promise
</script>
```

## React

Define the element once, then use the tag. Use string or number values for the attributes.

```tsx
import { useEffect, useState } from 'react';
import { registerLucide, defineMorphIcon } from 'shape-aware-morph';

export function MicButton() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    registerLucide().then(() => defineMorphIcon());
  }, []);
  return (
    <button onClick={() => setOn(!on)}>
      <morph-icon name={on ? 'mic' : 'mic-off'} duration="420" />
    </button>
  );
}
```

Call `defineMorphIcon` in an effect. On the server there is no DOM, and `defineMorphIcon` returns `null`.

### React types

The package types add `morph-icon` to `JSX.IntrinsicElements`, to the `react` module, and to `HTMLElementTagNameMap`. Any import of `shape-aware-morph` brings them in. The attributes are typed as `name`, `size`, `color`, `stroke-width`, `duration`, `easing`, `stagger`, `effect`, and `hover`, plus `class`, `className`, `style`, `id`, `key`, and `ref`.

To call the methods, type the ref with `MorphIconElement`.

```tsx
import { useRef } from 'react';
import type { MorphIconElement } from 'shape-aware-morph';

export function Hide() {
  const ref = useRef<MorphIconElement>(null);
  return (
    <>
      <morph-icon ref={ref} name="heart" />
      <button onClick={() => ref.current?.hide()}>Hide</button>
    </>
  );
}
```

## Vue

Tell Vue that `morph-icon` is a custom element. Then use the tag.

```ts
// vite.config.ts
import vue from '@vitejs/plugin-vue';

export default {
  plugins: [
    vue({ template: { compilerOptions: { isCustomElement: (tag) => tag === 'morph-icon' } } }),
  ],
};
```

```vue
<script setup>
import { ref, onMounted } from 'vue';
import { registerLucide, defineMorphIcon } from 'shape-aware-morph';

const on = ref(true);
onMounted(async () => {
  await registerLucide();
  defineMorphIcon();
});
</script>

<template>
  <button @click="on = !on">
    <morph-icon :name="on ? 'mic' : 'mic-off'" duration="420" />
  </button>
</template>
```

## Svelte

Svelte passes the tag through. Define the element when the component mounts.

```svelte
<script>
  import { onMount } from 'svelte';
  import { registerLucide, defineMorphIcon } from 'shape-aware-morph';

  let on = true;
  onMount(async () => {
    await registerLucide();
    defineMorphIcon();
  });
</script>

<button on:click={() => (on = !on)}>
  <morph-icon name={on ? 'mic' : 'mic-off'} duration="420"></morph-icon>
</button>
```

## Custom element rules

- The element reads its attributes when it connects. It then watches the nine attributes in [Element](https://shapcn.com/docs/element.md).
- The element keeps its state if you move it in the DOM. It stops any running frame when it disconnects.
- Define the element before or after you add the tag. A tag that exists before the definition upgrades with its attributes.
