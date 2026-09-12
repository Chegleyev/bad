/**
 * The audio host: everything the main thread does about sound.
 *
 * The mixing and the tracker sequencing happen on the audio thread (see
 * `mixer-worklet.js`); this side loads the banks, starts the context on the
 * first gesture the browser will accept one from, and turns the level script's
 * music opcodes into messages.
 *
 * A bank is the game's own resource, shipped byte for byte: it is the music
 * *and* the sound effects, and re-encoding it to anything else would be both
 * bigger and less capable -- `play_music` is a jump to an order position, which
 * a rendered stream cannot do.
 */
import { readPref, writePref } from './prefs.js';

export class Audio {
  constructor(base) {
    this.base = base;
    this.ctx = null;
    this.node = null;
    this.loaded = new Set();
    this.wanted = null;          // the bank to select once it has arrived
    this.pending = [];           // commands issued before the context existed
    this.musicGain = 0.7;
    // Effects sit *under* the music rather than over it: several of the bank's
    // effect samples run half a second and more, and at equal weight a burst of
    // them buries the tune.
    this.sfxGain = 0.5;
    this.ready = false;
    // Three separate reasons to be quiet, and only the first is the player's.
    // The context is suspended rather than turned down: it stops the mixer
    // running at all, which is the honest thing to do when nobody is listening.
    this.off = false;            // the switch, remembered between sessions
    this.hidden = false;         // the tab is not in front
    this.stopped = false;        // the game is paused
    this.off = !readPref('sound', true);
    document.addEventListener('visibilitychange', () => {
      this.hidden = document.hidden;
      this.apply();
    });
    addEventListener('blur', () => { this.hidden = true; this.apply(); });
    addEventListener('focus', () => { this.hidden = document.hidden; this.apply(); });
  }

  /** Should the mixer be running at all? */
  get audible() { return !this.off && !this.hidden && !this.stopped; }

  apply() {
    if (!this.ctx) return;
    // A resume the browser has not been given a gesture for is refused, and
    // that refusal is a rejected promise nobody is waiting on.
    if (this.audible) { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); }
    else if (this.ctx.state === 'running') this.ctx.suspend();
  }

  /** The switch, and the M key. -> whether sound is now on. */
  toggle(on = this.off) {
    this.off = on;
    writePref('sound', !on);
    this.apply();
    return !this.off;
  }

  /** The game stopped for the pause menu; the shop is not quiet, it is brief. */
  pause(on) { this.stopped = on; this.apply(); }

  /**
   * Build the context, or -- if it is already there -- have another go at
   * resuming it.
   *
   * Both halves matter. The promise is cached rather than the context checked,
   * because two callers arriving together used to have the second see
   * `this.ctx` already set, return while the first was still awaiting
   * `addModule`, and then post a bank into a port that did not exist yet. But
   * caching it alone is worse: the context is built at load, where no browser
   * will let it run, and every later call then returned the settled promise
   * without trying again -- so the game started in silence and the only way
   * back was toggling the sound switch off and on, which calls `apply` itself.
   * A later call is a gesture; it has to be treated as one.
   */
  start() {
    if (!this.starting) this.starting = this.open();
    else this.apply();
    return this.starting;
  }

  async open() {
    if (this.ctx) { this.apply(); return; }
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) return;
    // `playback` rather than `interactive`: a bigger buffer, which is what
    // stops the mixer running dry when the tab is busy -- the hiccups and the
    // occasional tick. It costs latency on the effects, and at 70 ticks a
    // second a shot that is heard one buffer late is not a shot that is heard
    // wrong. `?latency=interactive` puts the small buffer back.
    const hint = new URLSearchParams(location.search).get('latency') || 'playback';
    this.ctx = new Ctx({ latencyHint: hint });
    const url = new URL('./mixer-worklet.js', import.meta.url);
    await this.ctx.audioWorklet.addModule(url);
    // Two outputs: the music on 0 and the effects on 1. The effects get a
    // reverb, because a sampled explosion panned across a flat stereo field
    // sounds like it happened in a cupboard; the music does not, because a
    // tracker module is already mixed and smearing it only muddies it.
    this.node = new AudioWorkletNode(this.ctx, 'bad-mixer',
                                     { numberOfOutputs: 2, outputChannelCount: [2, 2] });
    this.node.connect(this.ctx.destination, 0);

    const dry = this.ctx.createGain();
    dry.gain.value = 0.78;
    const wet = this.ctx.createGain();
    wet.gain.value = 0.32;
    const verb = this.ctx.createConvolver();
    verb.buffer = this.impulse(1.15, 2.6);
    this.node.connect(dry, 1);
    this.node.connect(verb, 1);
    verb.connect(wet);
    dry.connect(this.ctx.destination);
    wet.connect(this.ctx.destination);
    this.verb = { dry, wet, verb };
    this.ready = true;
    this.post({ cmd: 'gain', music: this.musicGain, sfx: this.sfxGain });
    for (const m of this.pending) this.post(m);
    this.pending.length = 0;
    this.apply();
  }

  /**
   * An impulse response, made rather than shipped: exponentially decaying noise,
   * which is the cheapest thing that sounds like a room. `seconds` is the tail
   * and `decay` how fast it falls away. A file would be a download and a
   * licence for something four lines of arithmetic does.
   */
  impulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const n = Math.max(1, Math.floor(rate * seconds));
    const buf = this.ctx.createBuffer(2, n, rate);
    for (let c = 0; c < 2; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < n; i++) {
        // A short silence before the tail: a reflection that arrives with the
        // sound itself is not a reflection, it is a chorus.
        const t = i / n;
        const pre = i < rate * 0.012 ? 0 : 1;
        ch[i] = pre * (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
    }
    return buf;
  }

  /** How much room the effects sit in. 0 is dry. */
  setReverb(amount) {
    if (!this.verb) return;
    this.verb.wet.gain.value = Math.max(0, Math.min(1, amount));
    this.verb.dry.gain.value = 1 - 0.22 * Math.max(0, Math.min(1, amount));
  }

  post(m) {
    if (this.node) this.node.port.postMessage(m, m.data ? [m.data] : []);
    else if (m.cmd !== 'bank') this.pending.push(m);
  }

  /** Fetch a bank and hand its bytes to the mixer. */
  async load(gid, file) {
    if (this.loaded.has(gid)) return;
    // `gid` is a number for the game's banks and a name for the intro's.
    this.loaded.add(gid);
    const buf = await fetch(`${this.base}data/${file}`).then(r => r.arrayBuffer());
    await this.start();
    this.post({ cmd: 'bank', gid, data: buf });
  }

  /** The pickups' PCM, which lives outside the banks. */
  async pickups(data) {
    const P = data.player.pickup;
    if (!P || this.loaded.has('pickups')) return;
    this.loaded.add('pickups');
    const buf = await fetch(`${this.base}data/${P.file}`).then(r => r.arrayBuffer());
    await this.start();
    this.post({ cmd: 'pcm', spans: P.spans, data: buf });
  }

  /** Load every bank a level names, and select the one the script starts with. */
  async level(data) {
    const m = data.music;
    if (!m || !m.banks) return;
    const ids = Object.keys(m.banks).map(Number).sort((a, b) => a - b);
    // The level's own bank is the big one; the script switches to the others.
    for (const gid of ids) await this.load(gid, m.banks[gid].file);
    await this.pickups(data);
  }

  use(gid, start = false) { this.wanted = gid; this.post({ cmd: 'use', gid, start }); }
  /** The two things that were measured rather than read, so they are tunable. */
  tune(clockHz, loopAll) {
    if (clockHz) this.post({ cmd: 'clock', hz: clockHz });
    if (loopAll !== undefined) this.post({ cmd: 'loop', on: loopAll });
  }
  play(n) { this.post({ cmd: 'play', n }); }
  fade(v) { this.post({ cmd: 'fade', v }); }
  stop() { this.post({ cmd: 'stop' }); }

  /**
   * A sound effect: `n` counts back from the end of the current bank, the
   * period is one of the three the game uses, and `x` across the field becomes
   * the pan the table at data:0x24f5 would have given.
   */
  sfx(n, period = 0x400, x = 160, gain = 1) {
    this.post({ cmd: 'sfx', n, period, pan: Math.max(0, Math.min(1, x / 320)),
                vol: Math.round(64 * gain) });
  }

  /** One of the eight pickup voices. */
  pickup(i, period, x = 160, gain = 0.7) {
    this.post({ cmd: 'pcmplay', i, period,
                pan: Math.max(0, Math.min(1, x / 320)), vol: Math.round(64 * gain) });
  }

  setGain(music, sfx) {
    this.musicGain = music; this.sfxGain = sfx;
    this.post({ cmd: 'gain', music, sfx });
  }
}
