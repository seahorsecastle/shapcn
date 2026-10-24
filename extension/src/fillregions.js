// Fill icons: the engine's hover and press plans move the closed outlines of a solid icon, one entry per outline.
// A hole is its own outline. Drawn one by one and filled, a hole would be covered. This helper groups each outer outline
// with its holes (found at rest by point-in-polygon nesting) and merges them into one entry per group.
// Holes get the opposite winding, so the nonzero rule that the engine renderer uses for a region leaves them open.

function parsePts(d) {
  const out = [];
  for (const seg of d.split('M')) {
    const s = seg.trim();
    if (!s) continue;
    const n = s.split(/\s+/).map(Number);
    if (n.length >= 4) out.push(n);
  }
  return out; // list of flat [x, y, x, y, ...] contours
}

function area(p) {
  let a = 0;
  for (let i = 0, n = p.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1];
  }
  return a / 2;
}

function inside(poly, x, y) {
  let c = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[2 * i], yi = poly[2 * i + 1], xj = poly[2 * j], yj = poly[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function reverse(d) {
  return d
    .split('M')
    .filter((s) => s.trim())
    .map((seg) => {
      const n = seg.trim().split(/\s+/);
      const out = [];
      for (let i = n.length - 2; i >= 0; i -= 2) out.push(n[i], n[i + 1]);
      return 'M' + out.join(' ');
    })
    .join('');
}

/**
 * @param {{frame: Function}} plan A planAlive or planPress plan of a fill icon.
 * @param {Array} [restEntries] The entries of the rest icon. Default: plan.frame(0). A sway (createSway) has no frame(0): pass sway.rest().
 * @returns {(entries: Array) => Array} turns plan.frame(t) into region entries, one per outer outline.
 */
export function regionMerger(plan, restEntries) {
  const rest = restEntries || plan.frame(0);
  const info = rest.map((e) => {
    const c = parsePts(e.d);
    return { slot: e.slot, c0: c[0] || [0, 0, 0, 0], area: c[0] ? area(c[0]) : 0 };
  });
  // depth = number of other outlines that contain this outline
  info.forEach((a, i) => {
    a.parent = -1;
    a.depth = 0;
    const x = a.c0[0], y = a.c0[1];
    const mx = (a.c0[0] + a.c0[2]) / 2, my = (a.c0[1] + a.c0[3]) / 2; // a point next to the first vertex, inside the edge's segment
    info.forEach((b, j) => {
      if (i === j || Math.abs(b.area) <= Math.abs(a.area)) return;
      if (inside(b.c0, mx, my) || inside(b.c0, x, y)) {
        a.depth++;
        if (a.parent < 0 || Math.abs(info[a.parent].area) > Math.abs(b.area)) a.parent = j;
      }
    });
  });
  const root = (i) => (info[i].depth % 2 === 0 ? i : root(info[i].parent));
  const group = new Map(); // slot -> { root slot, reverse }
  info.forEach((a, i) => {
    const hole = a.depth % 2 === 1;
    const positive = a.area > 0;
    group.set(a.slot, { g: info[root(i)].slot, rev: hole ? positive : !positive });
  });
  const fn = (entries) => {
    const merged = new Map();
    for (const e of entries) {
      const g = group.get(e.slot) || { g: e.slot, rev: false };
      let m = merged.get(g.g);
      if (!m) {
        m = { d: '', opacity: e.opacity, widthScale: 1, key: g.g, slot: g.g, depth: e.depth || 0, fill: true, region: true, strokeWidth: 0 };
        merged.set(g.g, m);
      }
      m.d += g.rev ? reverse(e.d) : e.d;
    }
    return [...merged.values()];
  };
  fn.groups = new Set([...group.values()].map((g) => g.g)).size;
  return fn;
}
