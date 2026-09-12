/**
 * Pixel-exact hit tests using the original's own silhouettes.
 *
 * Each sprite's mask is one bit per pixel, LSB-first, packed into
 * `ceil(width / 32)` dwords per row and stored flat, row-major. The original
 * carries the same table after its pixels (header +0x14) for everything up to
 * 32 pixels wide and matches this bit for bit; wider sprites have no such
 * table, so the exporter generates all of them from the decoded pixels.
 *
 * So collision here is not an approximation with boxes. It is the same test the
 * original could make, on the same data.
 */

/** Do two masked sprites overlap? Positions are the sprites' top-left corners. */
export function hit(ax, ay, am, aw, ah, bx, by, bm, bw, bh) {
  if (!am || !bm) return false;
  const an = (aw + 31) >> 5, bn = (bw + 31) >> 5;
  const dx = Math.round(bx) - Math.round(ax);
  if (dx <= -(an << 5) || dx >= (bn << 5)) return false;
  const dy = Math.round(by) - Math.round(ay);
  const r0 = Math.max(0, dy), r1 = Math.min(ah, bh + dy);
  for (let r = r0; r < r1; r++) {
    const ao = r * an, bo = (r - dy) * bn;
    for (let i = 0; i < an; i++) {
      const a = am[ao + i];
      if (!a) continue;
      // b sits dx columns to the right of a, so line it up in a's coordinates:
      // a's word i wants b's bits starting at column (i * 32 - dx).
      const s = (i << 5) - dx, j = s >> 5, o = s & 31;
      let v = 0;
      if (j >= 0 && j < bn) v = bm[bo + j] >>> o;
      if (o && j + 1 >= 0 && j + 1 < bn) v |= bm[bo + j + 1] << (32 - o);
      if (a & v) return true;
    }
  }
  return false;
}

/**
 * Do these two objects collide at all? `sub_56a6` pairs them when either one's
 * layers (+0x48) intersect the other's interests (+0x4c). Enemies are 0x40 and
 * want 0x0c, the player is 0x11 and wants 0x80: neither direction pairs the
 * player with an enemy's body, so flying an enemy through the ship is harmless.
 */
export function pairs(aLayer, aHits, bLayer, bHits) {
  return ((aLayer & bHits) | (aHits & bLayer)) !== 0;
}

/**
 * And how precisely: `test al, 0x10` at 0x5702 on the two layers OR'd together
 * decides whether the silhouettes are compared at all. Only the player and the
 * type-35 enemies carry 0x10, so every other pair -- a shot against a fly
 * included -- is settled on bounding boxes.
 */
export function exact(aLayer, bLayer) { return ((aLayer | bLayer) & 0x10) !== 0; }

/** Plain rectangle overlap, the fallback the original uses for most pairs. */
export function overlap(ax, ay, aw, ah, bx, by, bw, bh) {
  ax = Math.round(ax); ay = Math.round(ay);
  bx = Math.round(bx); by = Math.round(by);
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}
