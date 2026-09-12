/**
 * The Pseudos intro, as an easter egg.
 *
 * The original plays it before anything else; here it is behind the company's
 * name in the footer, because a remaster that makes you sit through a logo
 * before every run is a remaster nobody finishes.
 *
 * Two cards, and each company's name in the footer opens its own: Webfoot, who
 * published it, on the 320x350 field the game itself uses, and Pseudos, who
 * wrote it, on a 632x478 sixteen-colour screen from the front end with the eye
 * opening in the middle of it. Neither is the shape of anything else here, so
 * this draws on its own 2D canvas rather than going through the sprite
 * renderer, and it sits inside the field's frame rather than over the window --
 * art this old stretched to a 4K desktop is mostly grain.
 */
const el = (tag, cls) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};

export class Intro {
  /** `host` is where the overlay lives; `audio` is optional. */
  constructor(host, base, audio) {
    this.base = base;
    this.audio = audio;
    this.data = null;
    this.loading = null;
    this.root = el('div', 'intro');
    this.root.hidden = true;
    // A 4:3 box that fills the frame, with the canvas filling the box. Sizing
    // the canvas itself cannot do this: it has an intrinsic size, and every
    // combination of width/height/max- either refuses to grow past it or
    // squashes it.
    this.fit = el('div', 'fit');
    this.canvas = el('canvas');
    this.fit.append(this.canvas);
    this.root.append(this.fit);
    this.hint = el('div', 'hint');
    this.hint.textContent = 'press any key or click';
    this.root.append(this.hint);
    host.append(this.root);
    this.frame = 0;
    this.timer = 0;
    this.raf = 0;
    this.onDone = null;
    this.root.addEventListener('click', () => this.advance());
  }

  /** Fetch the bundle once, the first time anyone asks for it. */
  load() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const d = await fetch(`${this.base}data/intro.json`).then(r => r.json());
      const grab = (f) => fetch(`${this.base}data/${f}`)
        .then(r => r.arrayBuffer()).then(b => new Uint8Array(b));
      d.logoPix = await grab(d.logo.file);
      d.eyePix = await grab(d.eye.file);
      // Both pictures are palette indices, so each becomes an ImageData once
      // and is blitted rather than being recoloured every frame.
      d.logoImg = this.toImage(d, d.logoPix, d.logo.w, d.logo.h, 0);
      if (d.webfoot) {
        const w = await grab(d.webfoot.file);
        d.webfootImg = this.toImage({ palette: d.webfoot.palette }, w,
                                    d.webfoot.w, d.webfoot.h, 0);
      }
      d.eyeImgs = [];
      for (let i = 0; i < d.eye.n; i++)
        d.eyeImgs.push(this.toImage(d, d.eyePix, d.eye.w, d.eye.h, i * d.eye.w * d.eye.h));
      this.data = d;
      return d;
    })();
    return this.loading;
  }

  toImage(d, src, w, h, off) {
    const img = new ImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const [r, g, b] = d.palette[src[off + i]] || [0, 0, 0];
      const o = i * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
    return img;
  }

  get showing() { return !this.root.hidden; }

  /** `which` is 'both', 'webfoot' or 'pseudos'. */
  async show(onDone, which = 'both') {
    this.onDone = onDone;
    const d = await this.load();
    this.ctx = this.canvas.getContext('2d');
    this.frame = 0;
    this.timer = d.eye.every;
    // The publisher's card first when both are asked for, and it holds until it
    // is dismissed the same way the second one is.
    this.only = which;
    this.card = (which !== 'pseudos' && d.webfootImg) ? 0 : 1;
    this.root.hidden = false;
    document.body.dataset.screen = 'intro';
    if (this.audio && d.music) {
      // The intro has a module of its own -- `_PSEUDOS[0]`.
      await this.audio.load('intro', d.music);
      this.audio.use('intro', true);
    }
    this.draw();
    const tick = () => {
      if (this.root.hidden) return;
      if (this.card === 0) { this.raf = requestAnimationFrame(tick); return; }
      if (--this.timer <= 0) {
        this.timer = d.eye.every;
        // It plays once and holds on the open eye rather than looping: the
        // animation *is* the reveal.
        if (this.frame < d.eye.n - 1) { this.frame++; this.draw(); }
      }
      this.raf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(tick);
  }

  /** Sizing the canvas clears it, so only do it when the card changes. */
  sizeTo(w, h) {
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w; this.canvas.height = h;
  }

  draw() {
    const d = this.data;
    if (this.card === 0) {
      this.sizeTo(d.webfoot.w, d.webfoot.h);
      this.ctx.putImageData(d.webfootImg, 0, 0);
      return;
    }
    this.sizeTo(d.logo.w, d.logo.h);
    this.ctx.putImageData(d.logoImg, 0, 0);
    this.ctx.putImageData(d.eyeImgs[this.frame], d.eye.at[0], d.eye.at[1]);
  }

  /** A key or a click: on to the next card, or out. */
  advance() {
    if (this.root.hidden) return;
    if (this.card === 0 && this.only === 'both') {
      this.card = 1; this.frame = 0; this.draw();
      return;
    }
    this.close();
  }

  close() {
    if (this.root.hidden) return;
    this.root.hidden = true;
    cancelAnimationFrame(this.raf);
    const done = this.onDone;
    this.onDone = null;
    if (done) done();
  }
}
