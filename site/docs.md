# Docs

shapcn morphs one icon into another. Change the `name` of a `<morph-icon>` element and the icon moves the way an animator would draw it. No animation is pre-built. The engine plans every frame when you ask.

## Quick start

Add one script and one tag. The script defines the `<morph-icon>` element and loads the Lucide icons.

```html
<script type="module" src="https://shapcn.com/morph-icon.js"></script>
<morph-icon name="menu" size="48"></morph-icon>
```

The demo above changes its name every two seconds. To do the same in your page, set the `name` attribute.

```html
<script type="module" src="https://shapcn.com/morph-icon.js"></script>
<morph-icon name="menu" size="48"></morph-icon>
<script type="module">
  const icon = document.querySelector('morph-icon');
  setTimeout(() => icon.setAttribute('name', 'x'), 1000);
</script>
```

The icon morphs from `menu` to `x`. Set `name` to an empty string and the icon hides with an effect. Set a name again and it shows.

## What is in the docs

- [Install](https://shapcn.com/docs/install.md): the script tag and the npm package.
- [Element](https://shapcn.com/docs/element.md): every attribute of `<morph-icon>`, with a live demo each.
- [Feel](https://shapcn.com/docs/feel.md): the easing presets `smooth`, `spring`, and `elastic`.
- [Effects](https://shapcn.com/docs/effects.md): the seven ways an icon appears and disappears.
- [Icons](https://shapcn.com/docs/icons.md): Lucide, the 12 icon sets, and your own icons.
- [JavaScript](https://shapcn.com/docs/javascript.md): `planMorph`, `planAlive`, `alive`, `defineMorphIcon`, and `registerIcons`.
- [Frameworks](https://shapcn.com/docs/frameworks.md): plain HTML, React, Vue, and Svelte.
- [Accessibility](https://shapcn.com/docs/accessibility.md): reduced motion, focus, and aria.

## Back to the site

- [Examples](/#examples)
- [Playground](/#play)
- [Compare](/#compare): plain point blending next to shapcn, frame by frame.
- [How it works](/#how)
- [Install](/#install)
- [GitHub](https://github.com/seahorsecastle/shapcn)

## Markdown and LLM files

Every page has a Markdown twin. Add `.md` to the path, for example `/docs/element.md`. The file [/llms.txt](https://shapcn.com/llms.txt) lists the pages. The file [/llms-full.txt](https://shapcn.com/llms-full.txt) holds all pages in one file.
