// Writes fixtures/lucide.html from the Lucide data of the engine package (stroke icons, 24 px, plain markup).
import { writeFileSync } from 'node:fs';
import * as L from '../../package/lucide.js';
const svg = (nodes, id, extra = '') => {
  const inner = nodes.map(([t, a]) => '<' + t + Object.entries(a).map(([k, v]) => ` ${k}="${v}"`).join('') + '/>').join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide"${extra}>${inner}</svg>`;
};
const names = ['heart', 'bell', 'bookmark', 'settings', 'search', 'plus'];
const btns = names.map((n) => `<button type="button" id="${n}" aria-label="${n}">${svg(L[n], n)}</button>`).join('\n');
const sym = L.star.map(([t, a]) => '<' + t + Object.entries(a).map(([k, v]) => ` ${k}="${v}"`).join('') + '/>').join('');
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Lucide toolbar</title>
<style>
body{margin:0;font:14px system-ui;background:#fff;color:#111}
.bar{display:flex;gap:8px;padding:16px}
button{width:44px;height:44px;display:inline-grid;place-items:center;border:1px solid #ddd;border-radius:8px;background:#fff;color:#111;cursor:pointer}
button:hover{background:#f4f4f4}
</style></head><body>
<svg width="0" height="0" style="position:absolute"><symbol id="s-star" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${sym}</symbol></svg>
<div class="bar" id="bar">
${btns}
<button type="button" id="star"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#s-star"/></svg></button>
<button type="button" id="styled"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #b00; opacity: 1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg></button>
<button type="button" id="img"><img alt="" width="24" height="24" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='8'/%3E%3C/svg%3E"></button>
</div>
<script>
window.clicks={};
for(const el of document.querySelectorAll('button')) el.addEventListener('click',()=>{window.clicks[el.id]=(window.clicks[el.id]||0)+1;});
</script>
</body></html>
`;
writeFileSync(new URL('./fixtures/lucide.html', import.meta.url), html);
