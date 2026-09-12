/**
 * The nebula behind the page.
 *
 * Drawn once into an offscreen canvas and handed to CSS as a background image,
 * so it costs nothing per frame -- the compositor caches it like any other
 * picture. Value noise summed over a few octaves for the cloud, then stars
 * scattered on top, most of them faint.
 *
 * It is generated rather than shipped because a JPEG of a nebula large enough
 * not to tile visibly is a megabyte, and this is four hundred bytes of code.
 */

/** Deterministic, so the sky is the same every load. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Value noise on a lattice, smoothly interpolated. */
function noiseField(w, h, rand) {
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = rand();
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
    const at = (a, b) => g[((b % h) + h) % h * w + ((a % w) + w) % w];
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
  };
}

/**
 * -> a data URL of a `w` x `h` nebula, in the game's violet.
 *
 * Kept small and stretched by CSS: a nebula has no detail worth the pixels, and
 * a 480-wide image scaled over a screen is indistinguishable from a native one.
 */
export function nebula(w = 480, h = 300, seed = 0x5eed) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const rand = rng(seed);
  const n1 = noiseField(8, 6, rand);
  const n2 = noiseField(17, 13, rand);
  const n3 = noiseField(37, 29, rand);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w, v = y / h;
      // Three octaves, each finer and fainter than the last.
      let f = n1(u * 8, v * 6) * 0.60 + n2(u * 17, v * 13) * 0.28
            + n3(u * 37, v * 29) * 0.12;
      // Push most of it to nothing so the clouds are wisps, not fog.
      f = Math.max(0, f - 0.42) / 0.58;
      f *= f;
      const o = (y * w + x) * 4;
      // Violet, drifting to blue where it is thickest.
      img.data[o] = 6 + f * 52;
      img.data[o + 1] = 5 + f * 34;
      img.data[o + 2] = 14 + f * 96;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Stars: many faint, a few bright, none of them large.
  for (let i = 0; i < w * h / 420; i++) {
    const x = Math.floor(rand() * w), y = Math.floor(rand() * h);
    const bright = rand();
    const a = bright > 0.94 ? 0.9 : bright > 0.75 ? 0.45 : 0.2;
    ctx.fillStyle = bright > 0.94 ? `rgba(226,226,255,${a})` : `rgba(198,190,230,${a})`;
    ctx.fillRect(x, y, 1, 1);
    if (bright > 0.97) {                      // the brightest get a soft halo
      ctx.fillStyle = 'rgba(170,160,220,0.18)';
      ctx.fillRect(x - 1, y, 3, 1);
      ctx.fillRect(x, y - 1, 1, 3);
    }
  }
  return c.toDataURL('image/png');
}
