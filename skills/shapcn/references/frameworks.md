# Frameworks

Rule for all: `name` is an attribute. Change it to morph. Pass strings or numbers. Do not pass objects or functions as attributes.

## Plain HTML

Script path:

```html
<script type="module" src="https://shapcn.com/morph-icon.js"></script>
<button type="button" id="b" aria-label="Show password">
  <morph-icon name="eye" aria-hidden="true" easing="spring"></morph-icon>
</button>
<script>
  b.onclick = () => {
    const i = b.querySelector('morph-icon');
    i.setAttribute('name', i.getAttribute('name') === 'eye' ? 'eye-off' : 'eye');
  };
</script>
```

Order does not matter. If the tag is in the HTML before the script loads, the browser upgrades it when `customElements.define` runs.

## React

### Script tag path

Add the script to `index.html` (Vite, CRA) or to the layout head. Then use the tag:

```tsx
export function PlayButton({ playing, onToggle }: { playing: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} aria-label={playing ? 'Pause' : 'Play'}>
      <morph-icon name={playing ? 'pause' : 'play'} duration="400" easing="spring" aria-hidden="true" />
    </button>
  );
}
```

For TypeScript without the npm package, add a type once (`src/morph-icon.d.ts`):

```ts
declare namespace JSX {
  interface IntrinsicElements {
    'morph-icon': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
      name?: string; size?: string | number; duration?: string | number; easing?: string;
      effect?: string; hover?: string; color?: string; 'stroke-width'?: string | number;
    };
  }
}
```

### npm path

The package types `<morph-icon>` for you (`import 'shape-aware-morph'` once makes the types global). Define the element once in the browser:

```tsx
import { useEffect } from 'react';
import { defineMorphIcon, registerIcons } from 'shape-aware-morph';
import { sun, moon } from 'shape-aware-morph/lucide';

registerIcons({ sun, moon });   // module scope is safe: it only fills a map

export function useMorphIcon() {
  useEffect(() => { defineMorphIcon(); }, []);   // browser only
}
```

Call `useMorphIcon()` once near the root. `defineMorphIcon()` is safe to call many times.

Notes:
- Style the parent button with a class. Put layout CSS on the button, not on `<morph-icon>`.
- Pass `duration="420"` or `duration={420}`. Both become attributes.
- React 18 sets unknown props on custom elements as attributes. Booleans do not work. Do not use them.

## Vue 3

Tell Vue that `morph-icon` is not a Vue component (Vite):

```ts
// vite.config.ts
import vue from '@vitejs/plugin-vue';
export default { plugins: [vue({ template: { compilerOptions: { isCustomElement: (tag) => tag === 'morph-icon' } } })] };
```

Then:

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { defineMorphIcon, registerIcons } from 'shape-aware-morph'; // npm path; skip with the script tag
import { sun, moon } from 'shape-aware-morph/lucide';
registerIcons({ sun, moon });
const dark = ref(false);
onMounted(() => defineMorphIcon());
</script>

<template>
  <button type="button" :aria-label="dark ? 'Switch to light' : 'Switch to dark'" @click="dark = !dark">
    <morph-icon :name="dark ? 'moon' : 'sun'" easing="spring" aria-hidden="true" />
  </button>
</template>
```

## Svelte (and SvelteKit)

Svelte supports custom elements with no setup:

```svelte
<script>
  import { onMount } from 'svelte';
  import { defineMorphIcon, registerIcons } from 'shape-aware-morph';  // npm path
  import { check, copy } from 'shape-aware-morph/lucide';
  registerIcons({ check, copy });
  let done = false;
  onMount(() => defineMorphIcon());                      // browser only
</script>

<button type="button" aria-label={done ? 'Copied' : 'Copy'} on:click={() => (done = !done)}>
  <morph-icon name={done ? 'check' : 'copy'} aria-hidden="true" />
</button>
```

## SSR (Next.js, Nuxt, SvelteKit)

- The server renders an empty `<morph-icon>` tag. The icon draws after the element is defined in the browser. Reserve space with `size` or CSS (`width` and `height` on the tag) to avoid layout shift.
- Call `defineMorphIcon()` only in the browser: `useEffect` (React), `onMounted` (Vue), `onMount` (Svelte), or a client-only component (`'use client'` in Next).
- `defineMorphIcon()` returns `null` when there is no DOM, so it does not throw on the server. Still, keep it in a browser hook so that registration runs at the right time.
- Script tag path in Next: use `<Script src="https://shapcn.com/morph-icon.js" strategy="afterInteractive" />` in the layout, and mark the component that uses the tag as a client component.
