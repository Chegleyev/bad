/**
 * The music and sound mixer, on the audio thread.
 *
 * The game's sound banks are complete 4-channel tracker modules -- instruments
 * and sound effects in one file -- so this is a tracker player. It is
 * deliberately self-contained: an AudioWorklet module is loaded by URL rather
 * than bundled with the rest, so the bank reader lives here beside the mixer
 * instead of being imported.
 *
 * Two clocks, and they must not be confused. The simulation runs at 70.0863 Hz;
 * the player runs at the module's own rate, 125 BPM at 6 ticks a row, which is
 * the ProTracker 50 Hz. Everything here is driven by the audio clock, so the
 * music keeps time whatever the frame rate is doing.
 */

/**
 * A cell's u16 is a period -- a *divisor* -- and the direction is confirmed by
 * the data: the bass channel carries the largest values and the melody the
 * smallest, and 0x0d60 is exactly twice 0x06b0, an octave.
 *
 * The constant it divides is not the Amiga's, though, and using the Amiga's
 * made everything about two octaves too low -- pads came out as a drone. It was
 * settled by measuring: the level-start announcement (`_01LEVEL[2]`, 36 216
 * samples) is played at period 0x597, and autocorrelating its loudest voiced
 * window puts the speaker at 66 samples a cycle. At 11 289 600 / period that is
 * 7 889 Hz and a 120 Hz voice -- the middle of a male speaking range -- and the
 * clip runs 4.6 s. The Amiga constant would have put the same voice at 38 Hz
 * and stretched the clip to fourteen seconds.
 *
 * 11 289 600 is 11 025 x 1024: period 0x400 plays a sample at 11 025 Hz, which
 * is the rate a 1997 DOS mixer would have recorded at.
 */
let CLOCK = 11289600;

/**
 * Read a bank. The layout is `re/module.py`'s, recovered from the loader
 * `sub_7494`: a 28-byte header, 16-byte sample descriptors whose three offsets
 * are stored shifted left by 8 (the original mixer keeps its play position in
 * 24.8 and uses them without conversion), the order list as one dword per
 * position in the same form, then the PCM, then the patterns packed to the end.
 */
function readBank(buf) {
  const b = new DataView(buf);
  const u16 = (o) => b.getUint16(o, true);
  const u32 = (o) => b.getUint32(o, true);
  if (u32(0) !== 0x00040004) return null;
  const channels = u16(0);
  const ns = u16(8);
  const smp = u32(0x0a) - 1;
  const pcmBytes = u32(0x0e);
  const nord = u16(0x12);
  const ordo = u32(0x14) - 1;
  const samples = [];
  for (let i = 0; i < ns; i++) {
    const o = smp + i * 16;
    const start = u32(o) >> 8, end = u32(o + 4) >> 8, third = u32(o + 8) >> 8;
    // **A sample whose third offset runs past its second is a looping
    // instrument**, and it plays to that third offset and repeats. The two
    // fields are equal on 48 of level 1's 62 samples and on 12 of the menu
    // bank's 16 -- those are the one-shots. Treating every sample as a one-shot
    // silenced three of the menu theme's four channels: its pad is a *single*
    // note of instrument 13 held across the whole intro, and instruments 6 and
    // 13 are two of the four the menu bank loops.
    samples.push({
      start, end: third > end ? third : end, loops: third > end,
      // The low byte is a default volume the caller may override.
      vol: b.getUint8(o + 12),
    });
  }
  const first = samples.length ? samples[0].start : buf.byteLength;
  const base = first + pcmBytes;
  const npat = Math.floor((buf.byteLength - base) / (channels * 6 * 64));
  const order = [];
  for (let i = 0; i < nord; i++)
    order.push(Math.floor(((u32(ordo + i * 4) >> 8) - base) / (channels * 6 * 64)));
  return {
    channels, samples, order, npat, base,
    pcm: new Int8Array(buf, 0, buf.byteLength),
    tempo: b.getUint8(0x18), speed: b.getUint8(0x19), volume: b.getUint8(0x1a),
    view: b,
  };
}

/**
 * A soft knee, in place. Linear to 0.6, then bent so nothing ever leaves
 * [-1, 1]: a hard clip on a loud volley is a click, and this is not.
 */
function soften(buf) {
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i], a = x < 0 ? -x : x;
    if (a <= 0.6) continue;
    const y = 0.6 + (1 - 0.6) * (1 - Math.exp(-(a - 0.6) / (1 - 0.6)));
    buf[i] = x < 0 ? -y : y;
  }
}

/**
 * One voice. Positions are in samples and fractional, because the output rate
 * is whatever the browser decided and nothing divides evenly into it.
 */
class Voice {
  constructor() {
    this.on = false;
    this.loops = false;
    this.pos = 0; this.step = 0;
    this.start = 0; this.end = 0;
    this.vol = 0;               // 0..64
    this.pan = 0.5;
    this.period = 0;
    // Effect state, named after the voice fields the original keeps it in.
    this.volStep = 0;           // +0x34, signed, applied once a tick
    this.volFine = false;       // +0x35: already applied at row time
    this.perStep = 0;           // +0x38, signed
    this.perFine = false;       // +0x3c
    this.target = 0;            // +0x3a, the tone-portamento destination
    this.portaSpeed = 0;
  }

  /** A period change, clamped and turned back into a step. */
  repitch(period) {
    this.period = Math.max(28, Math.min(8192, period));
    this.step = CLOCK / this.period / sampleRate;
  }
}

class Mixer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.banks = new Map();
    this.bank = null;
    this.voices = [new Voice(), new Voice(), new Voice(), new Voice(),
                   new Voice(), new Voice(), new Voice(), new Voice()];
    this.musicVoices = 4;       // the rest are for sound effects
    this.order = 0; this.row = 0; this.tick = 0;
    this.speed = 6; this.tempo = 125;
    this.playing = false;
    this.acc = 0;               // output samples owed to the next player tick
    this.gain = 0;              // master music volume, 0..63
    this.fadeStep = 0; this.fadeLeft = 0; this.fadeAcc = 0;
    this.sfxGain = 1;
    this.musicGain = 1;
    this.peak = 0; this.fxPeak = 0; this.blocks = 0;
    this.effTally = {}; this.loopAll = false;
    this.port.onmessage = (e) => this.command(e.data);
  }

  command(m) {
    if (m.cmd === 'bank') {
      const bank = readBank(m.data);
      if (bank) this.banks.set(m.gid, bank);
      // A `use` that arrived before its bytes did.
      if (this.want && this.want.gid === m.gid) {
        const w = this.want; this.want = null; this.command(w);
      }
      return;
    }
    if (m.cmd === 'use') {
      const bank = this.banks.get(m.gid);
      if (!bank) { this.want = m; return; }
      this.bank = bank;
      this.speed = bank.speed || 6;
      this.tempo = bank.tempo || 125;
      for (const v of this.voices) v.on = false;
      // Handing a bank to the driver starts it: the script's first `play_music`
      // on level 1 is at 43 s, and orders 0..14 are the music before it.
      if (m.start) {
        this.order = 0; this.row = 0; this.tick = 0; this.acc = 0;
        this.gain = 63; this.playing = true;
      }
      return;
    }
    // `sub_761a`: not a song id -- an order position, counted from one, and
    // everything else reset behind it.
    if (m.cmd === 'play') {
      if (!this.bank) return;
      this.order = Math.max(0, Math.min(this.bank.order.length - 1, m.n - 1));
      this.row = 0; this.tick = 0; this.acc = 0;
      this.gain = 63;
      this.playing = true;
      for (let i = 0; i < this.musicVoices; i++) this.voices[i].on = false;
      return;
    }
    // `sub_285f`: the low word is a signed 8.8 step applied once a tick, the
    // high word is how many ticks to apply it for.
    if (m.cmd === 'fade') {
      this.fadeStep = (m.v & 0xffff) << 16 >> 16;
      this.fadeLeft = (m.v >>> 16) & 0xffff;
      this.fadeAcc = this.gain << 8;
      return;
    }
    if (m.cmd === 'stop') { this.playing = false; for (const v of this.voices) v.on = false; return; }
    if (m.cmd === 'gain') { this.musicGain = m.music; this.sfxGain = m.sfx; return; }
    // The pickups: standalone PCM resources rather than bank instruments, so
    // they arrive as one blob with an index into it.
    if (m.cmd === 'pcm') { this.extra = { pcm: new Int8Array(m.data), spans: m.spans }; return; }
    if (m.cmd === 'pcmplay') {
      const e = this.extra;
      if (!e || !e.spans[m.i]) return;
      const [off, len] = e.spans[m.i];
      // The resource is a 16-byte descriptor and then the samples.
      this.startVoice(e, off + 16, off + len, m.period, m.pan, m.vol);
      return;
    }
    // `?clock=N` -- the one constant that was measured rather than read, so it
    // is worth being able to try another without a rebuild.
    if (m.cmd === 'clock') { CLOCK = m.hz || CLOCK; return; }
    // `?loop=1` forces *every* sample to repeat, which is not the rule -- see
    // `readBank` -- but is worth being able to hear.
    if (m.cmd === 'loop') { this.loopAll = !!m.on; return; }
    // A round-trip for the headless checks: what did the bank parse to, and is
    // anything actually sounding?
    if (m.cmd === 'stat') {
      const bank = this.bank;
      this.port.postMessage({ stat: {
        banks: [...this.banks.keys()], has: !!bank, playing: this.playing,
        order: this.order, row: this.row, gain: this.gain,
        orders: bank ? bank.order.slice(0, 6) : null,
        npat: bank ? bank.npat : null, base: bank ? bank.base : null,
        samples: bank ? bank.samples.length : null,
        s0: bank && bank.samples[1],
        voices: this.voices.slice(0, 4).map(v => ({ on: v.on, vol: v.vol, step: +v.step.toFixed(4),
                                                    pos: v.pos | 0, start: v.start, end: v.end })),
        peak: +this.peak.toFixed(4), fxPeak: +this.fxPeak.toFixed(4),
        blocks: this.blocks, effects: this.effTally,
      } });
      return;
    }
    // A sound effect is an instrument counted back from the end of the bank
    // (`sub_228c`), played at a fixed period and panned by the object's x.
    if (m.cmd === 'sfx') {
      const bank = this.banks.get(m.gid ?? -1) || this.bank;
      if (!bank) return;
      const idx = bank.samples.length - m.n;
      this.startSfx(bank, idx, m.period, m.pan, m.vol);
    }
  }

  startSfx(bank, idx, period, pan, vol) {
    const s = bank.samples[idx];
    if (!s || s.end <= s.start || !period) return;
    this.startVoice(bank, s.start, s.end, period, pan, vol);
  }

  /** Put a stretch of PCM on the first free voice the music is not using. */
  startVoice(src, from, to, period, pan, vol) {
    if (to <= from || !period) return;
    // Round-robin over the voices the music is not using, oldest first.
    let pick = this.musicVoices;
    for (let i = this.musicVoices; i < this.voices.length; i++)
      if (!this.voices[i].on) { pick = i; break; }
    const v = this.voices[pick];
    v.bank = src;
    // An effect is one-shot whatever its descriptor says: a looping one would
    // never stop.
    v.on = true; v.pos = from; v.start = from; v.end = to; v.loops = false;
    v.step = CLOCK / period / sampleRate;
    v.vol = vol; v.pan = pan;
    v.music = false;
  }

  /** One player tick: the row on tick 0, the per-tick effects after it. */
  playerTick() {
    const bank = this.bank;
    if (!bank || !this.playing) return;
    if (this.fadeLeft > 0) {
      this.fadeLeft--;
      this.fadeAcc = Math.max(0, Math.min(63 << 8, this.fadeAcc + this.fadeStep));
      this.gain = this.fadeAcc >> 8;
    }
    if (this.tick === 0) this.playRow();
    else for (let c = 0; c < this.musicVoices; c++) this.tickEffect(this.voices[c]);
    if (++this.tick >= this.speed) {
      this.tick = 0;
      if (++this.row >= 64) {
        this.row = 0;
        this.order++;
        if (this.order >= bank.order.length) this.order = 0;
      }
    }
  }

  /**
   * The row half of an effect, `call [ebx*4 + 0x83d4]`.
   *
   * The table is at **0x83d4**, not 0x8400 -- an earlier note here had it
   * eleven entries late, which shifted every effect's meaning by eleven. Forty
   * entries, and the ones that carry the weight across the eight banks are the
   * volume slides and the portamentos: 0x10 alone is seven per cent of every
   * cell in the game.
   */
  rowEffect(v, eff, par) {
    if (eff) this.effTally[eff] = (this.effTally[eff] || 0) + 1;
    switch (eff) {
      // The three that change the whole section rather than one voice.
      case 0x01: if (par) this.speed = par; break;   // `sub_78a6`: ticks a row
      case 0x02: if (par) this.tempo = par; break;   // `sub_78b1`: BPM
      case 0x03: this.gain = Math.min(63, par); break;  // `sub_78be`: global volume
      case 0x0b:                                     // position jump / break
        if (par) { this.order = Math.max(0, par - 1); this.row = -1; }
        else this.row = 63;                          // finish this row, then wrap
        break;
      case 0x10: v.volStep = -par; v.volFine = false; break;   // `sub_79db`
      case 0x11: v.volStep = par; v.volFine = false; break;    // `sub_79e1`
      case 0x12: v.vol = Math.max(0, v.vol - par); v.volFine = true; break;
      case 0x13: v.vol = Math.min(64, v.vol + par); v.volFine = true; break;
      case 0x14: v.perStep = par << 2; v.perFine = false; break;   // `sub_7a8c`
      case 0x15: v.perStep = par; v.perFine = false; break;        // `sub_7a9a`
      case 0x16: v.perStep = -(par << 2); v.perFine = false; break;// `sub_7aa3`
      case 0x17: v.perStep = -par; v.perFine = false; break;       // `sub_7ab1`
      case 0x1b:                                     // `sub_7b68`: at once
        v.perStep = -par; v.perFine = true; v.repitch(v.period - par);
        break;
      case 0x1c: case 0x1d:                          // tone portamento
        if (par) v.portaSpeed = eff === 0x1c ? par << 2 : par;
        break;
      default: break;                                // the rest are not in use
    }
  }

  /** The per-tick half, `call [ebx*4 + 0x8474]`: the slides actually moving. */
  tickEffect(v) {
    if (!v.on) return;
    if (v.volStep && !v.volFine) v.vol = Math.max(0, Math.min(64, v.vol + v.volStep));
    if (v.perStep && !v.perFine) v.repitch(v.period + v.perStep);
    if (v.target) {
      const d = v.target - v.period;
      const s = v.portaSpeed || 8;
      if (Math.abs(d) <= s) { v.repitch(v.target); v.target = 0; }
      else v.repitch(v.period + Math.sign(d) * s);
    }
  }

  playRow() {
    const bank = this.bank;
    const pat = bank.order[this.order];
    if (!(pat >= 0 && pat < bank.npat)) return;
    const stride = bank.channels * 6;
    const rowOff = bank.base + pat * 64 * stride + this.row * stride;
    for (let c = 0; c < bank.channels && c < this.musicVoices; c++) {
      const o = rowOff + c * 6;
      if (o + 6 > bank.view.byteLength) continue;
      const ins = bank.view.getUint8(o);
      const period = bank.view.getUint16(o + 1, true);
      const vol = bank.view.getUint8(o + 3);
      const v = this.voices[c];
      v.music = true;
      v.bank = bank;
      if (ins !== 0xff && ins < bank.samples.length) {
        const s = bank.samples[ins];
        if (s && s.end > s.start) {
          v.start = s.start; v.end = s.end; v.pos = s.start; v.on = true;
          v.loops = s.loops;
          v.vol = 64;
        }
      }
      const eff = bank.view.getUint8(o + 4);
      const par = bank.view.getUint8(o + 5);
      // Tone portamento does not jump to the new note, it slides to it.
      if (period && (eff === 0x1c || eff === 0x1d)) v.target = period;
      else if (period) { v.target = 0; v.repitch(period); }
      if (vol !== 0xff) v.vol = Math.min(64, vol);
      this.rowEffect(v, eff, par);
      // ProTracker panning: 1 and 4 left, 2 and 3 right, softened.
      v.pan = (c === 0 || c === 3) ? 0.28 : 0.72;
    }
  }

  /**
   * Two outputs, not one: the music on 0 and the effects on 1, so the host can
   * put a reverb on the effects without smearing the tune through it.
   */
  process(_in, outputs) {
    const out = outputs[0], fx = outputs[1] || outputs[0];
    const L = out[0], R = out[1] || out[0];
    this.fxL = fx[0]; this.fxR = fx[1] || fx[0];
    const n = L.length;
    if (!this.bank) {
      L.fill(0); if (R !== L) R.fill(0);
      this.fxL.fill(0); if (this.fxR !== this.fxL) this.fxR.fill(0);
      return true;
    }
    // ProTracker: ticks a second = BPM * 2 / 5.
    const perTick = sampleRate / (this.tempo * 2 / 5);
    let i = 0;
    while (i < n) {
      if (this.acc <= 0) { this.playerTick(); this.acc += perTick; }
      const run = Math.min(n - i, Math.ceil(this.acc));
      this.mix(L, R, i, run);
      this.acc -= run;
      i += run;
    }
    // A soft knee on both busses. Eight voices summed can pass 1.0 on a loud
    // volley, and a hard clip there is the click you hear -- this bends the
    // last of the range instead of cutting it off.
    soften(L); if (R !== L) soften(R);
    soften(this.fxL); if (this.fxR !== this.fxL) soften(this.fxR);
    this.blocks++;
    for (let k = 0; k < n; k++) {
      const v = Math.abs(L[k]); if (v > this.peak) this.peak = v;
      const w = Math.abs(this.fxL[k]); if (w > this.fxPeak) this.fxPeak = w;
    }
    return true;
  }

  mix(L, R, at, n) {
    const FL = this.fxL, FR = this.fxR;
    for (let k = 0; k < n; k++) {
      L[at + k] = 0; if (R !== L) R[at + k] = 0;
      FL[at + k] = 0; if (FR !== FL) FR[at + k] = 0;
    }
    for (const v of this.voices) {
      if (!v.on || !v.bank) continue;
      const pcm = v.bank.pcm;
      const dst = v.music ? L : FL, dstR = v.music ? R : FR;
      const g = (v.vol / 64) * (v.music ? (this.gain / 63) * this.musicGain : this.sfxGain)
                * 0.28;                      // headroom: four voices summed
      const gl = g * (1 - v.pan), gr = g * v.pan;
      let p = v.pos;
      for (let k = 0; k < n; k++) {
        if (p >= v.end) {
          if (!(v.loops || (this.loopAll && v.music))) { v.on = false; break; }
          p = v.start + (p - v.end);
        }
        // Linear interpolation: an 8-bit sample stepped at a fraction of its
        // own rate sounds like sandpaper without it.
        const i0 = p | 0;
        const f = p - i0;
        const a = pcm[i0], b = i0 + 1 < v.end ? pcm[i0 + 1] : a;
        // A short release. Eight-bit samples from 1997 do not end at zero --
        // they stop wherever the recording stopped -- and cutting one off mid
        // waveform is a click. Sixty-four samples is about a millisecond and a
        // half: inaudible as a fade, and the difference between a clean end
        // and a tick.
        let s = (a + (b - a) * f) / 128;
        const left = v.end - p;
        if (left < 64 && !v.loops) s *= left / 64;
        dst[at + k] += s * gl;
        if (dstR !== dst) dstR[at + k] += s * gr;
        p += v.step;
      }
      v.pos = p;
    }
  }
}

registerProcessor('bad-mixer', Mixer);
