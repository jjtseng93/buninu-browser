// A bounded, conservative dirty rectangle for two immutable display lists.
// null means replay the full tile; callers validate page-wide raster inputs.
const finite = Number.isFinite;
function rectangle(bounds, dx = 0, dy = 0) {
  if (!bounds || !finite(bounds.x) || !finite(bounds.y)
    || !finite(bounds.width) || !finite(bounds.height)
    || bounds.width < 0 || bounds.height < 0) return null;
  const x = bounds.x + dx, y = bounds.y + dy;
  const right = x + bounds.width, bottom = y + bounds.height;
  return finite(x) && finite(y) && finite(right) && finite(bottom) ? {x, y, right, bottom} : null;
}
const intersects = (a, b) => a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
const contains = (a, b) => a.x <= b.x && a.y <= b.y && a.right >= b.right && a.bottom >= b.bottom;
const curved = item => item.op === 'drawSvg' || item.op === 'drawShadow' || item.op === 'border'
  || item.op === 'drawAudio' || item.transform
  || item.roundedClips?.length || item.radii?.x > 0 || item.radii?.y > 0;

export function displayListDamage(old, next, region, scale = 1, fixedOffset = {x:0, y:0}) {
  const tile = rectangle(region);
  if (!old || !next || !tile || !finite(scale) || scale <= 0
    || old.items.some(item => item.op === 'drawVideo')
    || next.items.some(item => item.op === 'drawVideo')) return null;
  let damage = null;
  // Include at least two device pixels even when the page is zoomed out.
  const edgePad = Math.max(2, 2 / scale);
  const padding = item => {
    // The painter rounds local coordinates before transforming them. Also
    // transform glyph overhangs, not just the measured advance-width bounds.
    const m = item.transform;
    const norm = m ? Math.max(1, Math.abs(m.a) + Math.abs(m.c ?? 0), Math.abs(m.b ?? 0) + Math.abs(m.d)) : 1;
    return (item.op === 'drawText' ? Math.max(edgePad, item.font?.size * 2) : edgePad) * norm;
  };
  const include = (bounds, pad = edgePad) => {
    const b = rectangle(bounds);
    if (!b || !finite(pad) || pad < 0) return false;
    const x = b.x - pad, y = b.y - pad, right = b.right + pad, bottom = b.bottom + pad;
    if (!finite(x) || !finite(y) || !finite(right) || !finite(bottom)) return false;
    damage = damage ? {x:Math.min(damage.x,x), y:Math.min(damage.y,y),
      right:Math.max(damage.right,right), bottom:Math.max(damage.bottom,bottom)} : {x,y,right,bottom};
    return true;
  };
  const covers = item => !item.fixed && include(item.bounds, padding(item));
  const same = (before, after) => Bun.deepEquals(before, after)
    && (before.image === undefined || old.images[before.image] === next.images[after.image]);
  const was = old.items, items = next.items;
  if (was.length === items.length) {
    for (let i = 0; i < items.length; i++)
      if (!same(was[i], items[i]) && (!covers(was[i]) || !covers(items[i]))) return null;
  } else {
    // Preserve the common prefix/suffix when DOM insertion changes list length.
    const shorter = Math.min(was.length, items.length);
    let head = 0, tail = 0;
    while (head < shorter && same(was[head], items[head])) head++;
    while (tail < shorter - head && same(was[was.length - 1 - tail], items[items.length - 1 - tail])) tail++;
    for (let i = head; i < was.length - tail; i++) if (!covers(was[i])) return null;
    for (let i = head; i < items.length - tail; i++) if (!covers(items[i])) return null;
  }
  if (!damage || !intersects(damage, tile) || contains(damage, tile)) return null;

  // Cutting through an antialiased curve can change its rasterization. Grow
  // past intersecting curves, but never spend unbounded work finding closure:
  // a reverse-ordered chain of touching rounded boxes otherwise takes O(N²).
  const candidates = [];
  for (const item of items) if (curved(item)) {
    const b = rectangle(item.bounds, item.fixed ? fixedOffset.x : 0, item.fixed ? fixedOffset.y : 0);
    const pad = padding(item);
    if (!b || !finite(pad)) return null;
    // Match the full painter's tile culling: off-tile curves cannot affect it.
    if (!intersects(b, tile)) continue;
    const bounds = {x:b.x-pad,y:b.y-pad,right:b.right+pad,bottom:b.bottom+pad};
    if (!finite(bounds.x) || !finite(bounds.y) || !finite(bounds.right) || !finite(bounds.bottom)) return null;
    candidates.push({item, bounds, pad});
  }
  let budget = candidates.length * 4;
  for (let grew = true; grew;) {
    grew = false;
    for (const {item, bounds, pad} of candidates) {
      if (--budget < 0) return null;
      if (!intersects(bounds, damage) || contains(damage, bounds)) continue;
      if (item.fixed) return null;
      const before = damage;
      if (!include(item.bounds, pad) || contains(before, damage)) return null;
      if (contains(damage, tile)) return null;
      grew = true;
    }
  }
  // Native clip/readback coordinates only need the visible intersection.
  // Finite CSS endpoints far outside the tile can still overflow a Float32
  // scissor (or their difference) if passed through unchanged.
  return {x:Math.max(damage.x,tile.x), y:Math.max(damage.y,tile.y),
    right:Math.min(damage.right,tile.right), bottom:Math.min(damage.bottom,tile.bottom)};
}
