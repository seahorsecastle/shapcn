// The shapcn engine, bundled for the extension. Imports only the pure core, the planners, the renderer, and the DOM class.
// No icon data is bundled here (the page's own icons are registered at run time with registerSVGs).
import * as core from '../../package/core.js';
import { setIconResolver } from '../../package/regions.js';

if (typeof core.getIconInfo === 'function') setIconResolver(core.getIconInfo);

export { registerSVGs } from '../../package/svg.js';
export { planAlive, planPress, createSway, retargetPlan, HOVER_STYLES, PRESS_STYLES, hoverMs, pressMs, RETARGET_MS } from '../../package/effects.js';
export { renderInto } from '../../package/render.js';
export { MorphIcon, defineMorphIcon } from '../../package/dom.js';
export { registerFamily, registerIcons, unregisterIcons, getIconNames, iconToSVG } from '../../package/core.js';
