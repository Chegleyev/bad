/**
 * Fixed-step clock.
 *
 * The original ticks once per vertical retrace of its tweaked VGA mode, which
 * is 25.175 MHz / 800 dots / 449 lines = 70.0863 Hz. That rate is part of the
 * game: every speed, every `wait` in the level script and every flight-path
 * segment is denominated in those ticks. So the simulation runs at exactly that
 * rate on any display, and the renderer interpolates.
 *
 * `alpha` is the fraction of a tick elapsed since the last one, which is what
 * the renderer blends previous and current positions with. At 60 Hz that means
 * some frames advance two ticks and some one; at 240 Hz most frames advance
 * none. Both are correct, and neither changes the simulation.
 */
export class Clock {
  constructor(hz, { maxTicksPerFrame = 5, now = () => performance.now() / 1000 } = {}) {
    this.dt = 1 / hz;
    this.now = now;
    this.maxTicksPerFrame = maxTicksPerFrame;
    this.acc = 0;
    this.last = null;
    this.tick = 0;
  }

  /** Call once per animation frame; runs `step` 0..maxTicksPerFrame times. */
  advance(step) {
    const t = this.now();
    if (this.last === null) { this.last = t; return; }
    this.acc += t - this.last;
    this.last = t;
    // A backgrounded tab stops rAF while the clock keeps running. Without this
    // clamp the first frame back would try to catch up thousands of ticks.
    const cap = this.maxTicksPerFrame * this.dt;
    if (this.acc > cap) this.acc = cap;
    let n = 0;
    while (this.acc >= this.dt) {
      this.acc -= this.dt;
      this.tick++;
      step(this.tick);
      n++;
    }
    return n;
  }

  /**
   * Forget the time since the last frame.
   *
   * Called when the game comes back from a pause: without it the clock has
   * been running all the while the shop was open and the first frame back
   * would spend its whole catch-up allowance at once.
   */
  resync() { this.last = null; this.acc = 0; }

  get alpha() { return this.acc / this.dt; }
}
