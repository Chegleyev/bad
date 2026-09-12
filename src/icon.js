/**
 * Sprites out of the atlas as little DOM images, for the HUD.
 *
 * The atlas is 8-bit palette indices with 0 meaning transparent -- the same
 * bytes the WebGL renderer samples -- so an icon is one lookup per pixel into
 * `data.palette`. Nearest-neighbour on the way up, and the game's non-square
 * pixel aspect applied horizontally so a ship in the HUD has the same
 * proportions as the ship on the field.
 */
export function icon(data, atlas, gid, scale = 2) {
  const f = data.atlas.frames[gid];
  if (!f) return null;
  const src = document.createElement('canvas');
  src.width = f.w; src.height = f.h;
  const sctx = src.getContext('2d');
  const img = sctx.createImageData(f.w, f.h);
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const idx = atlas[(f.y + y) * data.atlas.w + f.x + x];
      const o = (y * f.w + x) * 4;
      if (!idx) continue;                       // index 0 is transparent
      const [r, g, b] = data.palette[idx];
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
  }
  sctx.putImageData(img, 0, 0);

  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(f.w * scale * (data.pixelAspect || 1)));
  out.height = Math.max(1, Math.round(f.h * scale));
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, out.width, out.height);
  out.className = 'ico';
  return out;
}

/** The same, scaled to fit a box rather than by a factor. */
export function iconFit(data, atlas, gid, boxW, boxH, max = 3) {
  const f = data.atlas.frames[gid];
  if (!f) return null;
  const aspect = data.pixelAspect || 1;
  // Never past `max`: several of these sprites are only a few pixels across,
  // and blown up to fill a box they read as an orange smear rather than a
  // projectile.
  // Down to half size is allowed: at HUD scale a ship still reads as a ship
  // after a nearest-neighbour halving, and three of them have to fit a panel
  // that is only about a hundred pixels wide on a 1280 screen.
  const s = Math.max(0.55, Math.min(max, boxW / (f.w * aspect), boxH / f.h));
  return icon(data, atlas, gid, s);
}
