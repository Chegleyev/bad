import { Clock } from './clock.js';
import { Sim } from './sim.js';
import { decide } from './autopilot.js';
import { Renderer } from './render.js';
import { Hud } from './hud.js';
import { nebula } from './backdrop.js';
import { Menu, GameOver, Shop, Pause, NameEntry, HighScores,
         Credits } from './screens.js';
import { Audio } from './audio.js';
import { Intro } from './intro.js';
import { iconFit } from './icon.js';
import { pixIcon } from './pixicon.js';
import { readPref, writePref } from './prefs.js';
import { qualifies, add as addScore, rememberName,
         load as scoreRows } from './scores.js';

/**
 * The boot veil: up from the first paint, down when there is something to look
 * at.
 *
 * The bar counts *bytes*, not files. Counting files left it on nothing for the
 * seven seconds level 1's manifest takes over a thin line and then jumping a
 * fifth at a time, which reads as stuck rather than as slow. `grab` feeds it
 * from the response stream as the chunks arrive.
 *
 * The denominator is a fixed estimate of the startup payload rather than a
 * real total: `Content-Length` only turns up a response at a time, so a true
 * total is not known until the last one has started. Being wrong about it
 * costs nothing -- the bar is clamped below full and `finish` snaps it there.
 */
const boot = {
  el: document.getElementById('boot'),
  bar: document.querySelector('#boot .boot-bar i'),
  got: 0,
  total: 2.75e6,
  bytes(n) {
    if (this.finished) return;          // levels load over this bar's grave
    this.got += n;
    if (this.bar) this.bar.style.width = `${Math.min(96, this.got / this.total * 100)}%`;
  },
  finish() {
    this.finished = true;
    if (!this.el) return;
    if (this.bar) this.bar.style.width = '100%';
    this.el.classList.add('gone');
    // Out of the document once it has faded, not merely transparent: a fixed
    // layer over the whole page is a compositor layer for the rest of the run.
    this.el.addEventListener('transitionend', () => this.el.remove(), { once: true });
    setTimeout(() => this.el.remove(), 1200);      // ...and if the fade is off
  },
};

/**
 * Fetch, reporting progress as it goes. -> the bytes.
 *
 * Falls back to `arrayBuffer` when the response cannot be streamed, which is
 * every response from a `file://` page and some from a proxy: the bar then
 * moves in one jump for that file and nothing else changes.
 */
async function grab(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  if (!r.body) {
    const b = new Uint8Array(await r.arrayBuffer());
    boot.bytes(b.length);
    return b;
  }
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    boot.bytes(value.length);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

const text = new TextDecoder();
const grabJson = (url) => grab(url).then(b => JSON.parse(text.decode(b)));

const canvas = document.getElementById('field');
// The counters under the foot are a developer's readout, not a player's, so
// they are off unless `?stats=1` asks for them. Hidden rather than emptied: an
// empty element still reserves its line, and writing to it every 125 ms
// invalidates layout for something nobody is reading.
const hud = document.getElementById('stats');
const showStats = new URLSearchParams(location.search).get('stats') === '1';
hud.hidden = !showStats;

/**
 * `import.meta.env` is Vite's, and it exists both in dev and in a build. It does
 * *not* exist when this file is served as-is by a plain static host -- which is
 * what happens when GitHub Pages is set to "Deploy from a branch" rather than
 * "GitHub Actions". The repository root goes up instead of `dist`, the browser
 * runs `src/main.js` unprocessed, and the first thing it touches is undefined.
 *
 * Nothing can be done about it from here, so say which setting it is rather
 * than throwing `Cannot read properties of undefined` at whoever looks.
 */
if (!import.meta.env) {
  const veil = document.getElementById('boot');
  if (veil) {
    veil.querySelector('.boot-ring')?.remove();
    veil.querySelector('.boot-bar')?.remove();
    const t = veil.querySelector('.boot-text');
    if (t) {
      t.classList.remove('pix');
      t.style.cssText = 'font:400 13px/1.6 var(--mono);letter-spacing:.02em;' +
                        'color:var(--v-lit);text-align:center;max-width:44ch';
      t.textContent = 'This is the source tree, not the build. Set Settings → ' +
                      'Pages → Source to "GitHub Actions", or serve dist/.';
    }
  }
  throw new Error('unbuilt: serve dist/, not the repository root');
}
// BASE_URL keeps this correct in dev, in a build, and under a sub-path.
const base = import.meta.env.BASE_URL;
// ?level=N picks one of the eight. Whether the tick rate is right will be
// settled on the later levels -- if they are unpassable it is wrong -- so they
// need to be reachable without playing through everything before them.
const startLevel = Math.min(8, Math.max(1, Number(new URLSearchParams(location.search)
  .get('level')) || 1));
let level = startLevel;
let data = await grabJson(`${base}data/level${level}.json`);
let atlas = await grab(`${base}data/${data.atlas.file}`);

const menuArt = await grabJson(`${base}data/menu.json`).catch(() => null);
const menuBytes = menuArt ? await grab(`${base}data/${menuArt.file}`) : null;

const audio = new Audio(base);

/**
 * The game's mark: the ship itself, banked, mirrored so it is going somewhere.
 *
 * `tiltRight` is the far end of the strip the ship rolls through when a
 * direction is held -- a real frame of the real sprite. It is baked through the
 * pixel-art upscaler at build time (`upscale/logo.py`), which is the first
 * thing tried of the combined plan: nets on the art that is drawn large,
 * nearest on everything that has to stay chunky. If the baked file is not there
 * -- nobody has run the upscaler -- the atlas crop stands in.
 */
/**
 * The hi setting: the field composed several times over, with the sprites that
 * were baked by `upscale/atlas.py` drawn from the upscaled atlas.
 *
 * On by default, and remembered between sessions. H turns it on and off at any
 * time, and so does the switch in the header.
 */
const qs = new URLSearchParams(location.search);
// Two field pixels to one, which is 640x700, and that is where it stops: the
// sprites are baked at 2x for exactly this, and a third and fourth pixel of
// buffer buys nothing a 4x atlas resampled on the way down would not lose.
const HI = 2;
// An explicit `?hi=` wins over what was stored, for that load only -- a URL is
// somebody trying one setting, not somebody changing their mind. Only the
// switch and the key write.
const hiParam = qs.get('hi');
let hiOn = hiParam !== null ? (Number(hiParam) || 1) > 1 : readPref('hi', true);
const hiWanted = hiOn ? HI : 1;

/**
 * The baked sprites, if they have been made and if they are wanted. The atlas
 * is a PNG rather than raw bytes -- twenty-one megabytes of RGBA compresses to
 * four and a half, and the browser decodes it on a worker thread.
 *
 * Nothing is fetched until the setting is first turned on, and once a level's
 * atlas is up it stays up: toggling the mode off and on must not cost four
 * megabytes a time.
 */
let bigAt = 0;                    // the level whose baked atlas is uploaded
async function loadBig(n) {
  if (!hiOn || bigAt === n) return;
  try {
    const meta = await grabJson(`${base}data/atlas${n}.big.json`);
    // Through `grab` as well: at a megabyte and a third this is half of what a
    // first visit waits for, and a bar that ignored it would stall at the end.
    const png = await grab(`${base}data/atlas${n}.big.png`);
    renderer.setBig(await createImageBitmap(new Blob([png])), meta);
    bigAt = n;
  } catch {
    // Nobody has run `upscale/atlas.py` for this level; the hard atlas stands.
  }
}

function paintLogo() {
  const box = document.getElementById('logo');
  if (!box) return;
  box.dataset.ship = '1';
  const img = new Image();
  img.alt = '';
  img.onload = () => box.replaceChildren(img);
  img.onerror = () => {
    const ship = iconFit(data, atlas, data.player.tiltRight, 44, 40);
    if (ship) box.replaceChildren(ship);
  };
  img.src = `${base}data/logo4x.png`;
}
// The sound switch in the header. It only ever reflects the player's choice --
// the tab being away and the game being paused silence things without moving it.
const soundBtn = document.getElementById('sound');
function paintSound() {
  const on = !audio.off;
  soundBtn.setAttribute('aria-pressed', String(on));
  soundBtn.title = on ? 'Sound on (M)' : 'Sound off (M)';
  const g = pixIcon(on ? 'speaker' : 'muted', 3);
  soundBtn.firstElementChild.replaceChildren(...(g ? [g] : []));
}
function toggleSound() { audio.toggle(!audio.off); paintSound(); }
soundBtn.addEventListener('click', () => { audio.start(); toggleSound(); });
paintSound();

// The hi-res switch, beside it. Same shape of control, and the same rule: it
// only ever reflects what the player asked for.
const hiBtn = document.getElementById('hires');
function paintHi() {
  hiBtn.setAttribute('aria-pressed', String(hiOn));
  hiBtn.title = hiOn ? 'Upscaled sprites on (H)' : 'Upscaled sprites off (H)';
  const g = pixIcon(hiOn ? 'fine' : 'coarse', 3);
  hiBtn.firstElementChild.replaceChildren(...(g ? [g] : []));
  document.body.dataset.hi = hiOn ? '1' : '0';
}
function setHi(on) {
  if (on === hiOn) return;
  hiOn = on;
  writePref('hi', on);
  renderer.setScale(on ? HI : 1);
  resize();                    // the backing store follows the field's size
  paintHi();
  if (menu) menu.setBig(on);   // the title is drawn the way the field is
  if (on) loadBig(level);      // fetched the first time it is asked for
}
hiBtn.addEventListener('click', () => setHi(!hiOn));
paintHi();
const renderer = new Renderer(canvas, data, atlas,
  { fbo: qs.get('fbo') === '1', scale: hiWanted });
let sim = new Sim(data);
globalThis.sim = sim;      // the debug handle the capture scripts drive
const clock = new Clock(data.tickHz);
// The sky, drawn once. Everything behind the page is this one picture, so it
// costs a compositor layer and nothing per frame.
document.documentElement.style.setProperty('--sky', `url(${nebula()})`);
const q0 = new URLSearchParams(location.search);
// The scanline veil is off by default now. It was never what made the picture
// chunky -- that is the 320x350 buffer and `image-rendering: pixelated` -- but
// it is a taste, and a taste should be opt-in. `?crt=1` puts it back.
// The veil is on, at a gain of 1.5 on both of its parts -- one dial rather than
// two alphas buried in a gradient. `?crt=1` is lighter, `?crt=3` is about where
// it used to be before the rework, and `?crt=0` takes it off.
const crtGain = Math.max(0, Number(q0.get('crt') ?? 1.5) || 0);
document.body.dataset.crt = crtGain > 0 ? '1' : '0';
document.documentElement.style.setProperty('--crt-gain', String(crtGain || 1));
// The panel sheen is off until the polish pass -- see the note in the CSS.
document.body.dataset.sheen = q0.get('sheen') ?? '0';
const panel = new Hud(document.getElementById('stage'), data, atlas);
// Everything the capture and profiling scripts need to reach.
globalThis.dbg = { sim, renderer, panel, clock, data };
globalThis.dbgAudio = audio;
let frames = data.atlas.frames;

// ---- screens ------------------------------------------------------------
/**
 * Load level `n` in place. Each archive brings its own atlas and its own 256
 * colours, and the three things that hold a crop of the atlas -- the renderer,
 * the HUD and the shop -- are pointed at the new one rather than rebuilt.
 */
async function loadLevel(n) {
  if (n === level && data) return;
  const next = await fetch(`${base}data/level${n}.json`).then(r => r.json());
  const bytes = await fetch(`${base}data/${next.atlas.file}`)
    .then(r => r.arrayBuffer()).then(b => new Uint8Array(b));
  level = n; data = next; atlas = bytes; frames = data.atlas.frames;
  bigAt = 0;                 // another level, another set of baked sprites
  audio.level(data);
  renderer.setLevel(data, atlas);
  await loadBig(n);
  panel.setLevel(data, atlas);
  shop.setLevel(data, atlas);
  globalThis.dbg.data = data;
}

// menu -> playing -> over -> menu. The simulation is thrown away and rebuilt
// for each run rather than reset field by field: there is one place that knows
// how to set a game up, and it is the constructor.
let screen = 'menu';
let overAt = 0;
const frame3 = canvas.closest('.frame');
const menu = menuArt && new Menu(frame3, menuArt, menuBytes, startGame, base,
                                 () => showScores(-1), () => showCredits());
if (menu) menu.setBig(hiOn);        // `?hi=` starts the title the same way
// Where a run goes when it earned a place: a name, then the table, then home.
const names = new NameEntry(frame3, (name) => {
  rememberName(name);
  showScores(addScore(name, sim.score));
});
const scores = new HighScores(frame3, () => toMenu());
const credits = new Credits(frame3, () => toMenu());
const over = new GameOver(frame3);
over.onClick(() => { if (screen === 'over' && performance.now() - overAt > 700) leaveEnd(); });
// > 0 when the end screen is a level finished rather than a life lost, and a
// key press should fly on rather than go back to the menu.
let pendingLevel = 0;
// The shop buys the same way a dropped prize is caught: the pickup's own
// handler runs, and then the purse pays for it.
const shop = new Shop(frame3, data, atlas, (row) => {
  sim.collect(row.item, undefined, 0, true);   // paid for: no compensation
  sim.player.credits -= row.price;
  // The HUD is driven off the tick, and the tick is stopped.
  panel.update(sim);
}, () => closeShop());
panel.onShop(() => (screen === 'playing' ? openShop() : null));
const pause = new Pause(frame3, () => resume(), () => { resume(); toMenu(); });

// The company's name in the footer plays the original's intro. It is the one
// thing in here that is not the game, so it is behind a link rather than in
// front of every run.
const intro = new Intro(frame3, base, audio);
let beforeIntro = null;
function openIntro(which) {
  if (intro.showing) return;
  audio.start();
  beforeIntro = screen;
  intro.show(() => {
    document.body.dataset.screen = beforeIntro;
    // Put back whatever was playing: the menu's theme, or the level's bank.
    if (beforeIntro === 'menu') menuTheme();
    else if (sim) onAudio('load_soundbank', lastBank);
  }, which);
}
for (const [id, which] of [['pseudos', 'pseudos'], ['webfoot', 'webfoot']])
  document.getElementById(id)?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openIntro(which);
  });
// A card sits inside the field's frame, so a click beside it never reaches it.
// While one is up, the whole page dismisses it.
addEventListener('click', () => { if (intro.showing) intro.advance(); });
// The badge says "press any key", and a click is one: an attract loop that
// ignored the mouse would be a page that looks broken to anyone who reaches for
// it rather than for the keyboard.
addEventListener('pointerdown', () => {
  if (!demo || screen !== 'playing') return;
  demo = false;
  demoPlan = null;
  if (demoBadge) demoBadge.hidden = true;
  toMenu();
  idleSince = performance.now();
});
// What the script last handed to the driver, so the intro can hand it back.
let lastBank = 0;

function openPause() {
  if (screen !== 'playing') return;
  audio.pause(true);
  screen = 'paused';
  document.body.dataset.screen = screen;
  held.clear();
  panel.update(sim);
  pause.show(true);
}

/** Back to the game from whatever stopped it. */
function resume() {
  if (screen !== 'paused' && screen !== 'shop') return;
  pause.show(false);
  shop.show(false);
  audio.pause(false);
  screen = 'playing';
  document.body.dataset.screen = screen;
  // The clock kept running while the game was stopped; without this the first
  // frame back spends its whole catch-up allowance at once.
  clock.resync();
}

function openShop() {
  if (screen !== 'playing') return;
  screen = 'shop';
  document.body.dataset.screen = screen;
  held.clear();                       // nothing should still be held down after
  panel.update(sim);                  // the HUD is tick-driven, and the tick stops
  shop.show(true, sim);
}

const closeShop = resume;

/**
 * The script's music opcodes. `play_music n` is a jump to order position n-1,
 * not a song id; `sound_bank n` selects `n >> 1`, which is how a level switches
 * between its two banks.
 */
function onAudio(op, v) {
  // Handing a bank to the driver starts it playing from the top; `sound_bank`
  // selects `n >> 1` and only bit 0 hands it over at once.
  if (op === 'load_soundbank') { lastBank = v; audio.use(v, true); }
  else if (op === 'sound_bank') audio.use(v >> 1, (v & 1) === 1);
  else if (op === 'play_music') audio.play(v);
  else if (op === 'music_fade') audio.fade(v);
  else if (op === 'music_stop') audio.stop();
}

/** Hand the simulation's sound events to the mixer. */
function wireSound(s) {
  s.onSfx = (n, period, x, gain) => audio.sfx(n, period, x, gain);
  s.onPickupSfx = (i, x) => audio.pickup(i, data.player.pickup.period, x);
}

/**
 * True from the moment a level transition starts until the next level is up.
 *
 * `advance` awaits three fetches, which is milliseconds on a development
 * machine and *seconds* on a real connection. Every key and click in that
 * window reached `leaveEnd` again, where `pendingLevel` had already been
 * cleared -- so a finished level was read as a finished run and the high score
 * prompt came up over a level that was still loading.
 */
let advancing = false;

/**
 * What the end screen leads to: the next level, the name prompt, or the menu.
 *
 * The prompt only comes up when the run actually beat the tenth row, and never
 * for a run that took the " disco " cheat. Asking every time and then quietly
 * dropping the answer is worse than not asking.
 */
function leaveEnd() {
  if (advancing) return;
  if (pendingLevel) { advance(pendingLevel); return; }
  if (!sim.cheated && qualifies(sim.score)) {
    over.show(false);
    screen = 'name';
    document.body.dataset.screen = screen;
    names.show(true, sim.score, placeFor(sim.score));
    return;
  }
  toMenu();
}

/** Which line a score would land on, 0-based, for the prompt to name it. */
function placeFor(score) {
  return scoreRows().filter(r => r.score >= score).length;
}

function showScores(highlight) {
  over.show(false);
  names.show(false);
  if (menu) menu.show(false);
  screen = 'scores';
  document.body.dataset.screen = screen;
  scores.show(true, highlight);
}

function showCredits() {
  if (menu) menu.show(false);
  screen = 'credits';
  document.body.dataset.screen = screen;
  credits.show(true);
}

/**
 * Put up the end screen. `sub_3538` is the original's; this one also has to say
 * which of three endings it is.
 */
function endScreen() {
  const last = level >= 8;
  pendingLevel = sim.won && !last ? level + 1 : 0;
  screen = 'over';
  document.body.dataset.screen = screen;
  over.show(true, sim.score, sim.player.rank,
            !sim.won ? 'GAME OVER' : last ? 'GAME COMPLETE' : `LEVEL ${level} COMPLETE`,
            pendingLevel ? `press any key for level ${pendingLevel}` : 'press any key or click');
  overAt = performance.now();
}

/** On to level `n`, in the same ship. */
async function advance(n) {
  pendingLevel = 0;
  advancing = true;
  try {
    await loadLevel(n);
  } catch (err) {
    advancing = false;
    throw err;
  }
  const prev = sim;
  sim = new Sim(data);
  sim.carryOver(prev);
  sim.onAudio = onAudio;
  wireSound(sim);
  if (q.has('idle')) sim.idleCap = Number(q.get('idle'));
  sim.skipGates = q.has('nogates');
  globalThis.sim = sim;
  globalThis.dbg.sim = sim;
  over.show(false);
  held.clear();
  clock.tick = 0;
  clock.resync();
  screen = 'playing';
  document.body.dataset.screen = screen;
  if (demoBadge) demoBadge.hidden = !demo;
  demoLives = sim.player.lives;
  demoPc = sim.pc; demoPcAt = sim.tick;
  advancing = false;
}

async function startGame() {
  shop.show(false);
  pause.show(false);
  pendingLevel = 0;
  // A demo deals itself a level; everything else starts where the URL says.
  const plan = demo ? dealDemo() : null;
  await loadLevel(plan ? plan.level : startLevel);
  sim = new Sim(data);
  audio.start();
  // `?clock=11289600` is the pitch constant and `?loop=1` makes samples repeat.
  // Both were settled by measurement rather than read out of the code, so both
  // can be tried without a rebuild.
  audio.tune(Number(q.get('clock')) || 0, q.has('loop'));
  audio.level(data);
  if (q.has('idle')) sim.idleCap = Number(q.get('idle'));
  // A warp always skips the wave gates. They are what hold the level back until
  // the last wave is dead, and with nobody playing the first one blocks for
  // ever -- which is why `?tick=19400` used to land in wave 1 rather than at
  // the boss. Gates an anchor is holding are never skipped, so a warp past the
  // end of the level stops at the boss fight instead of running through it.
  // A warp runs the whole script up to where it lands, and every music opcode
  // in it would fire at once. Remember only the last of each instead, and apply
  // those once: the bank the level was on and the tune it was playing.
  const heard = {};
  sim.onAudio = (op, v) => { heard[op] = v; };
  sim.skipGates = true;
  // A dealt demo lands on a wave rather than at the top of the level: an
  // attract loop that always opened on the same empty sky would be showing the
  // loading, not the game. The stretch is measured on a scratch run rather than
  // written down, so it holds for every level and survives the data changing.
  let at = warp;
  if (plan) {
    if (plan.tick === null) {
      const [first, end] = wavesIn(data);
      const span = Math.max(0, end - first - 900);
      plan.tick = Math.round(first + Math.random() * span);
    }
    at = plan.tick;
  }
  if (at === 'boss') {
    while (sim.tick < 40000 && !sim.entities.some(e => e.tpl.type === 33)) sim.step();
    // Getting here skipped every gate on the way, so a dozen waves a player
    // would have shot are still flying and their anchors are still dripping
    // reinforcements in. Asking for the boss means asking for the boss fight,
    // so clear the field of everything that is not the boss or the backdrop.
    for (const e of sim.entities) if (e.tpl.type !== 10 && e.tpl.type < 33) e.dead = true;
    sim.enemyShots.length = 0;
    sim.drops.length = 0;
  } else {
    for (let i = 0; i < at; i++) sim.step();
    // Landing anywhere but the top of a level means every gate on the way was
    // skipped, and a gate is what the level uses to say "this wave is over".
    // So a dozen waves a player would have shot down are still on the field
    // with their anchors alive, and an anchor never stops: `stepAnchor` adds a
    // member every `interval` ticks and winds that interval down to 560, each
    // arrival `hardened` -- a quarter of its hit points as ram damage, half the
    // reload. Left alone, the demo fills with elites from waves that are not
    // happening any more.
    //
    // The program says which wave *is* happening: the next gate names the slot
    // it is waiting on. Everything that is not that wave is a leftover, and the
    // ship was flown through their part of the level without firing a shot.
    if (plan) {
      // The program says which wave *is* happening: the next gate names the
      // slot it is waiting on, and the registry says which anchor is in that
      // slot now. Not the slot number on its own -- a level reuses one slot for
      // every wave it has, so on level 5 all twelve anchors answer to 0 and
      // keeping "the ones in the gate's slot" kept every one of them.
      // `sub_3b4d` binds a member to its anchor at birth, so an object belongs
      // to the wave it was born into and the current wave is exactly the
      // registered anchor and the members pointing at it.
      const gate = sim.prog.slice(sim.pc).find(op => op[0] === 'g');
      const wave = gate ? sim.anchors[gate[1]] : null;
      for (const e of sim.entities) {
        if (e.tpl.type === 10) continue;                   // the backdrop
        if (e === wave || (wave && e.anchor === wave)) continue;
        e.dead = true;
        // An anchor is emptied rather than only killed: `sub_2738` reads a
        // gate's answer out of the registry, so one left in it still counting
        // members would block the next gate on that slot for ever.
        if (e.tpl.type === 11) {
          e.alive = 0;
          if (sim.anchors[e.tpl.anchorSlot] === e) delete sim.anchors[e.tpl.anchorSlot];
        }
      }
      sim.enemyShots.length = 0;
      sim.drops.length = 0;
    }
  }
  sim.skipGates = q.has('nogates');
  clock.tick = sim.tick;
  sim.onAudio = onAudio;
  wireSound(sim);
  for (const op of ['load_soundbank', 'sound_bank', 'play_music'])
    if (heard[op] !== undefined) onAudio(op, heard[op]);
  // The warp is a debugging fast-forward, not a run: it flies the ship through
  // everything the level throws with nobody steering, so it arrives dead and
  // the program may have run off its end. Land at that moment ready to play.
  if (at) {
    sim.won = false;
    sim.player.lives = data.player.lives;
    sim.player.hp = sim.player.maxHp;
    sim.player.state = 'fly';
    sim.player.frame = data.player.tiltMid;
    sim.player.x = Math.round(data.player.x * 65536);
    sim.player.y = Math.round(data.player.y * 65536);
    sim.player.px = sim.player.x; sim.player.py = sim.player.y;
    sim.enemyShots.length = 0;
  }
  if (q.has('weapon') || plan) {
    const id = plan ? plan.weapon : Number(q.get('weapon'));
    sim.player.weapon = null;
    sim.player.equip(id, sim);
    if (plan) {
      // At its cap, which is what " WEAPON BOOST " walks a gun up to and what a
      // player is holding by the time these waves come round. The magazine goes
      // with it: `equip` leaves two volleys, the amount a gun just picked up
      // carries, and a demo opening on an empty gun shows the reload and not
      // the game.
      const P = data.player, w = P.weapons[id];
      sim.player.damage = Math.round(w.damage * P.weaponUpCap);
      sim.player.fireEvery = P.fireEveryMin;
      sim.player.ammo = w.mag;
      // And the speed that goes with a gun at its cap. A ship that has been
      // collecting " SIDE SPEED UP " all the way to this wave is not still on
      // the one it starts with, and for the narrow guns the speed is not a
      // comfort -- a cannon has to get under the thing it is shooting.
      sim.player.maxSpeed = Math.min(P.maxSpeed * 3, 3);
    }
  }
  if (q.has('item')) sim.collect(Number(q.get('item')));
  globalThis.sim = sim;
  globalThis.dbg.sim = sim;
  held.clear();
  screen = 'playing';
  if (menu) menu.show(false);
  over.show(false);
  document.body.dataset.screen = screen;
  if (demoBadge) demoBadge.hidden = !demo;
  demoLives = sim.player.lives;
  demoPc = sim.pc; demoPcAt = sim.tick;
}

function toMenu() {
  screen = 'menu';
  over.show(false);
  names.show(false);
  scores.show(false);
  credits.show(false);
  if (menu) menu.show(true);
  document.body.dataset.screen = screen;
  menuTheme();
}

// `_00LEVEL[0]` -- the one bank that belongs to no level, 43 order positions of
// it. Every level's data lists the common banks as well as its own, so it is
// already loaded; starting a game hands the level's bank over and replaces it.
function menuTheme() { audio.use(0, true); }

// The context is built at load -- suspended, which is all a browser allows
// before the page has been touched -- so the banks can be fetched and handed
// over in the background. The first key or click is what resumes it, and the
// menu's theme starts there.
paintLogo();
loadBig(level);
audio.start().then(() => { audio.level(data); menuTheme(); });
{
  const wake = () => {
    audio.start();
    if (screen === 'menu') menuTheme();
  };
  addEventListener('keydown', wake, { once: true });
  addEventListener('pointerdown', wake, { once: true });
}

// ?tick=N fast-forwards the simulation before the first frame. Waves are minutes
// apart, so this is how you look at a specific moment without waiting for it.
// Start just before the first wave while we are debugging: the original plays a
// greeting message and an intro animation in front of it, and neither exists yet.
const q = new URLSearchParams(location.search);
// `?tick=boss` runs until the boss is actually on the field: cutting the dead
// waits moves every later tick number, so naming the moment beats guessing it.
// No warp by default any more. It used to start just before the first wave --
// the greeting and the announcements in front of it were dead air worth
// skipping while debugging -- but with the empty waits cut the opening is short
// enough to play, and it is what the level actually begins with.
// ?demo=1 hands the ship to the bot in `autopilot.js` -- the same brain the
// weapon sweep is flown with, so what it does here is what those numbers are
// measuring. It plays the game's own rules: three lives, no gates skipped, and
// when the run ends it starts again.
let demo = q.get('demo') === '1';
const demoBadge = document.getElementById('demo');
// A menu nobody has touched for three quarters of a minute plays the game to
// itself, which is what the cabinet this is descended from did with the floor
// empty. `?demo=0` turns it off -- for a screenshot, or for reading the credits
// slowly. `?demo=1` is the other door: straight in, no waiting.
const ATTRACT_AFTER = 45000;
const attract = q.get('demo') !== '0';
let idleSince = performance.now();
const stirred = () => { idleSince = performance.now(); };
addEventListener('keydown', stirred, true);
addEventListener('pointerdown', stirred, true);
addEventListener('pointermove', stirred, true);
addEventListener('wheel', stirred, { capture: true, passive: true });
const warp = q.has('tick')
  ? (q.get('tick') === 'boss' ? 'boss' : Number(q.get('tick')))
  : 0;
// ?speed=0.5 runs the simulation at half rate, for comparing side by side with
// the original in DOSBox. It changes the wall-clock pace and nothing else.
clock.dt = 1 / (data.tickHz * (Number(q.get('speed')) || 1));
// ?nogates=1 lets the wave gates pass while fast-forwarding, so a later part of
// the level -- the asteroid belt, say -- can be reached without playing to it.
// ?weapon=1060 starts with that gun equipped and ?item=3 applies a pickup at
// once, for looking at either without waiting for it. All of it is applied by
// `startGame`, which is the one place a run is set up.

// The field is 320x350 with non-square pixels; presented at 4:3.
function resize() {
  const wrap = canvas.closest('.field-wrap');
  const stage = document.getElementById('stage');
  const bar = wrap.querySelector('.progress');
  const aspect = 4 / 3;

  // The HUD is measured against the *field*, not the window. Sized off the
  // viewport the panels stayed at their cap while the field grew, so on a big
  // screen two narrow strips of HUD sat marooned at either edge. The field's
  // height is the stage's height, which does not depend on the panels, so the
  // scale comes out of one pass rather than a circular one.
  const root = document.documentElement.style;
  const COL = 140;                                  // the HUD's design width
  // The scale comes from the *window*, not from the stage. Taking it from the
  // stage fed back on itself -- zooming the head made the stage shorter, which
  // changed the scale -- and the foot ended up pushed off the bottom.
  const ui = Math.max(0.75, Math.min(2.2, innerHeight / 1050));
  root.setProperty('--col-w', `${COL}px`);
  root.setProperty('--ui', ui.toFixed(3));

  const panel = Math.round(COL * ui);
  const gap = parseFloat(getComputedStyle(stage).columnGap) || 0;

  // Collapse what this function set last time *before* measuring. The middle
  // column and the canvas are explicit pixel sizes, and a grid container is as
  // wide as its columns: measured with last time's values still in place, the
  // box holds itself open and the layout can only ever grow. Which is exactly
  // what happened -- maximise then restore left the page scaled for the big
  // window, with scrollbars. Reading a geometry property straight after the
  // writes forces the layout, so what comes back is the collapsed box.
  root.setProperty('--field-w', '0px');
  root.setProperty('--shell-w', 'auto');
  canvas.style.width = '0px';
  canvas.style.height = '0px';
  // The frame's own chrome -- its border and the metal padding inside it -- is
  // read from the stylesheet rather than written here twice.
  const edge = parseFloat(getComputedStyle(document.documentElement)
    .getPropertyValue('--frame-edge')) || 1;
  const availW = stage.clientWidth - 2 * panel - 2 * gap - 2 * edge;
  const availH = stage.clientHeight - (bar ? bar.offsetHeight + 7 : 0) - 2 * edge;

  // ...and then the field takes what is left, capped by the height it has.
  let w = Math.max(120, Math.min(availW, availH * aspect));
  let h = w / aspect;
  canvas.style.width = `${Math.round(w)}px`;
  canvas.style.height = `${Math.round(h)}px`;
  // The middle column is exactly the field, so the panels sit against it.
  root.setProperty('--field-w', `${Math.round(w) + 2}px`);
  // One source row, in CSS pixels. The scanline veil is drawn on this pitch, so
  // it stays in step with the picture at any window size -- and at both H
  // settings, since what it imitates is the display, not the buffer.
  root.setProperty('--scan', `${(h / data.screen[1]).toFixed(3)}px`);
  // ...and the head and foot span the same cluster. In its own units, since
  // they are zoomed by the same factor.
  const shell = 2 * panel + 2 * gap + Math.round(w) + 2;
  root.setProperty('--shell-w', `${(shell / ui).toFixed(1)}px`);

  // The drawing buffer is the *field*, not the window.
  //
  // Every pixel of the drawing buffer is written every frame -- by the sprites,
  // by the clear, or by the blit when the buffer path is on -- so a frame costs
  // what the buffer is big, almost regardless of what is in it. Sizing it to
  // the window meant three quarters of a million pixels for a picture that has
  // a hundred and twelve thousand in it, and the browser then scaled it anyway.
  // Backing it at 320x350 and letting CSS stretch it hands that one upscale to
  // the compositor, which was going to composite the layer regardless.
  //
  // `?res=2` (or 3, 4) backs it at a multiple, for crisper pixel edges at the
  // old cost. `?dpr=N` goes back to sizing it by the window, for comparison.
  const res = Number(q.get('res')) || 0;
  const dpr = Number(q.get('dpr')) || 0;
  if (dpr) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  } else {
    // ...and at the hi setting it is backed at the scale the field is composed
    // at. Leaving it at 320x350 there composes 1280x1400 and then resamples it
    // straight back down, which is every bit of the upscale thrown away one
    // step before it reaches the screen.
    const n = Math.max(1, Math.min(8, res || renderer.scale || 1));
    canvas.width = data.screen[0] * n;
    canvas.height = data.screen[1] * n;
  }
}
addEventListener('resize', resize);
// After the HUD exists: the panels and the progress strip change what is left
// for the field.
resize();
// And again once the faces are in. The first pass measures a page set in the
// fallback fonts; the display face is taller, so the head and the foot grow by
// about thirty pixels when it arrives and the field -- already sized for the
// shorter page -- pushes the document past the window. That is the scrollbar
// that appeared on load and went away at the first nudge of the window.
document.fonts?.ready.then(resize);
addEventListener('load', resize);
// And whenever the progress strip changes height, because the field's height is
// measured against it. It starts as a bare 2px track and grows to 25 when its
// label gets a line box, and which side of that the last pass landed on came
// down to how long the assets took -- loading straight into `?hi=4` measured
// the short one and left the field thirty pixels too tall for good. Guarded on
// the height actually changing, so this settles rather than chases itself.
const bar = document.querySelector('.progress');
if (bar && globalThis.ResizeObserver) {
  let was = bar.offsetHeight;
  new ResizeObserver(() => {
    if (bar.offsetHeight === was) return;
    was = bar.offsetHeight;
    resize();
  }).observe(bar);
}

// Input. The original reads a device through a vtable and dispatches on
// direction bits; none of that survives the port, only the resulting dx/dy/fire.
const held = new Set();
const KEYS = {
  ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r',
  ArrowUp: 'u', KeyW: 'u', ArrowDown: 'd', KeyS: 'd',
  Space: 'f', KeyJ: 'f',
};
addEventListener('keydown', e => {
  // A focused text field owns every key, full stop. Without this the ship's
  // controls still run: `KeyD` is "right", it calls `preventDefault`, and the
  // letter never reaches the field -- and the same for A, W, S and J. The
  // screen checks below would normally keep them apart, but they depend on
  // `screen` being right, and `screen` is exactly what a mistimed level
  // transition can get wrong. This does not depend on it.
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
    if (e.code === 'Escape' && screen === 'name') { names.key(e.code); e.preventDefault(); }
    return;
  }
  // First, because the shop and the pause menu both return early and the cheat
  // is allowed in the shop -- which is where a full purse is worth having.
  if (!e.repeat) cheatKey(e.key);
  if (screen === 'shop') {
    if (shop.key(e.code)) e.preventDefault();
    return;
  }
  if (screen === 'paused') {
    if (pause.key(e.code)) e.preventDefault();
    return;
  }
  // A text field has the focus: every key is the field's, including M and H.
  // The form's own submit handler is what Enter reaches.
  if (screen === 'name') {
    if (e.code === 'Escape') { names.key(e.code); e.preventDefault(); }
    return;
  }
  if (screen === 'scores') {
    if (scores.key(e.code)) e.preventDefault();
    return;
  }
  if (screen === 'credits') {
    if (credits.key(e.code)) e.preventDefault();
    return;
  }
  if (intro.showing) { intro.advance(); e.preventDefault(); return; }
  // M works everywhere, including on the menu and the end screen.
  if (e.code === 'KeyM' && !e.repeat) { audio.start(); toggleSound(); e.preventDefault(); return; }
  // H likewise: the picture is not a thing you should have to leave a fight to
  // change your mind about.
  if (e.code === 'KeyH' && !e.repeat) { setHi(!hiOn); e.preventDefault(); return; }
  // Any key ends the demo. It is a thing to watch, not a thing to play -- and
  // this is the door the attract mode will need.
  if (demo && screen === 'playing') {
    demo = false;
    demoPlan = null;
    if (demoBadge) demoBadge.hidden = true;
    toMenu();
    idleSince = performance.now();
    e.preventDefault();
    return;
  }
  if (screen === 'playing' && e.code === 'KeyB') { openShop(); e.preventDefault(); return; }
  if (screen === 'playing' && e.code === 'Escape') { openPause(); e.preventDefault(); return; }
  if (screen === 'menu') {
    if (menu && menu.key(e.code)) e.preventDefault();
    return;
  }
  // Any key leaves the end screen -- after a moment, so that the shot that
  // killed you does not also dismiss it.
  if (screen === 'over') {
    if (performance.now() - overAt > 700) { leaveEnd(); e.preventDefault(); }
    return;
  }
  const k = KEYS[e.code];
  if (k) { held.add(k); e.preventDefault(); }
});
addEventListener('keyup', e => {
  const k = KEYS[e.code];
  if (k) { held.delete(k); e.preventDefault(); }
});
/**
 * Type " disco " while flying and the purse fills.
 *
 * A rolling buffer rather than an index into the word, so a mistyped letter
 * does not need a reset: " dodisco " works, and so does holding D down and then
 * getting it right. The gap between letters has to stay under a second, which
 * is what "quickly" means and also what keeps D-I-S-C-O typed across a whole
 * level of flying from adding up to a cheat by accident.
 *
 * It costs the run: `Sim.disco` raises a flag the end of the game checks, and
 * the score never reaches the table. That is the point. A cheat that left the
 * table alone would be a lie told to whoever reads it later.
 */
const CHEAT = 'disco';
let typed = '', typedAt = 0;
function cheatKey(key) {
  if (screen !== 'playing' && screen !== 'shop') return;
  if (!key || key.length !== 1) return;
  const now = performance.now();
  if (now - typedAt > 1000) typed = '';
  typedAt = now;
  typed = (typed + key.toLowerCase()).slice(-CHEAT.length);
  if (typed !== CHEAT) return;
  typed = '';
  if (sim.disco()) { panel.update(sim); if (screen === 'shop') shop.refresh(sim); }
}

/**
 * The engine, burning, under the ship.
 *
 * The flight frames stop at the hull -- they are thirty rows and the last of
 * them is the nozzles with a two-pixel nub of flame. The flame proper lives in
 * the thruster strip, which is fifty-nine rows and is only ever shown for the
 * boost hop and the two flights in and out. The original had little reason to
 * draw it the rest of the time: the ship never leaves its home row, and from
 * there the plume runs off the bottom of the screen.
 *
 * What fits is the top of it, which is the bright part, so that is what this
 * draws: rows 30 and down of a thruster frame, at the ship's own position,
 * clipped by the field edge like anything else.
 *
 * No horizontal adjustment, and that is not luck. Every sprite the ship owns
 * has its content centred on x = 15.5 in its own coordinates whatever its
 * declared width -- 796 is 24 wide with pixels in 8..23, 799 is 26 with pixels
 * in 6..25, both centred at 15.5 -- which is how the original swaps a flight
 * frame for a thruster frame without the ship moving sideways.
 */
function exhaust(gid) {
  const P = data.player;
  const hull = frames[P.tiltMid] && frames[P.tiltMid].h;
  const f = frames[gid];
  if (!hull || !f || f.h <= hull) return null;
  const big = renderer.bigOf(gid);
  const s = big ? big.h / f.h : 1;
  return {
    hard: { x: f.x, y: f.y + hull, w: f.w, h: f.h - hull },
    big: big ? { x: big.x, y: big.y + hull * s, w: big.w, h: big.h - hull * s } : undefined,
    top: hull,
  };
}
// A flicker rather than a ramp: 0, 1, 2, 1 of the thruster strip, a step every
// third tick, which is the cadence every other animation in the game moves on.
const BURN = [0, 1, 2, 1];
function drawExhaust(frame, x, y) {
  const P = data.player;
  // Only under a *flight* frame. The thruster frames carry their own flame, and
  // the wreck and the explosion should not be lit from underneath.
  if (frame < P.tiltLeft || frame > P.tiltRight) return;
  if (sim.player.state !== 'fly') return;
  const gid = P.boostAnim[0] + BURN[Math.floor(clock.tick / 3) % BURN.length];
  // Not cached: it is four property reads, and a cache would go stale on the H
  // switch and again when the baked atlas finishes loading.
  const b = exhaust(gid);
  if (b) renderer.draw(b.hard, x, y + b.top, b.big);
}

const input = () => {
  // The bot only has an opinion while the ship is flying. Coming in, dying and
  // waiting are the same for it as for a player: nothing to decide.
  if (demo && sim.player.state === 'fly' && sim.player.gun) {
    const a = decide(sim, sim.player.gun);
    return { dx: a.dx, dy: 0, fire: a.fire };
  }
  return {
    dx: (held.has('r') ? 1 : 0) - (held.has('l') ? 1 : 0),
    dy: (held.has('d') ? 1 : 0) - (held.has('u') ? 1 : 0),
    fire: held.has('f'),
  };
};

/**
 * What the end of a run means with nobody watching the keyboard.
 *
 * No end screen and no name prompt: on to the next level if the bot won one,
 * and back to the start if it did not. `demoBusy` is the guard `advancing` is
 * for the player's path -- both of these await three fetches, and the frame
 * loop would call this again on every frame in between.
 */
/**
 * Anything on the field the demo should not be in the middle of.
 *
 * The asteroid belt is an emitter and a boss is a type 33 core with its wings
 * and guns; neither is a wave, and neither is what a thirty-second look at the
 * game should open on. Reaching one is a reason to cut and deal again, not a
 * thing to fly through.
 */
const hazard = (s) => s.entities.some(
  e => !e.dead && (e.tpl.emitter || e.tpl.type >= 33));

/**
 * How far into a level the waves run before the first of those.
 *
 * Run on a scratch simulation with the gates skipped, which is the same
 * fast-forward `?tick=` uses, and with the ship made unkillable so that a run
 * with nobody steering does not stall at the `ship_in` that blocks until it is
 * back. Returns the tick the first wave is on screen and the tick the safe
 * stretch ends, so a demo can be dealt anywhere between them.
 */
function wavesIn(d) {
  const s = new Sim(d);
  s.skipGates = true;
  s.player.lives = 9999;
  let first = 0;
  while (s.tick < 40000) {
    s.step();
    if (!first && s.entities.some(e => !e.dead && e.tpl.drawn && (e.tpl.layer & 0x40)))
      first = s.tick;
    if (s.won || hazard(s)) break;
  }
  return [first || 200, s.tick];
}

/**
 * A hand for the demo: a level, a wave in it, and a gun at its cap.
 *
 * Random, because the point of an attract loop is that the second look is not
 * the first one -- but never over anything the URL has already named, so
 * `?demo=1&level=5&weapon=1061` still means exactly what it says.
 */
let demoPlan = null, demoLives = 0, demoPc = -1, demoPcAt = 0;
function dealDemo() {
  const P = data.player;
  const ids = Object.keys(P.weapons).map(Number);
  demoPlan = {
    level: q.has('level') ? startLevel : 1 + Math.floor(Math.random() * 8),
    weapon: q.has('weapon') ? Number(q.get('weapon'))
                            : ids[Math.floor(Math.random() * ids.length)],
    tick: q.has('tick') ? warp : null,        // null means "pick one once loaded"
  };
  return demoPlan;
}

let demoBusy = false;
async function demoNext() {
  if (demoBusy || advancing) return;
  demoBusy = true;
  try {
    if (!demoPlan && sim.won && level < 8) await advance(level + 1);
    else await startGame();
  } finally { demoBusy = false; }
}

let fps = 0, fpsT = performance.now(), fpsN = 0, hudTick = -1, statsT = 0, hudT = 0;

function frame() {
  // Nothing has happened on the menu for long enough: hand the ship to the bot.
  if (attract && !demo && !demoBusy && screen === 'menu' && !intro.showing &&
      performance.now() - idleSince > ATTRACT_AFTER) {
    demo = true;
    demoBusy = true;
    startGame().finally(() => { demoBusy = false; });
  }
  if (screen === 'playing') {
    clock.advance(() => sim.step(input()));
    // The last life ends the run. `sub_3538` puts up the original's own screen;
    // this is ours. Running off the end of the level program is the other way
    // out -- the boss is down and the section's outro has played.
    if (sim.player.state === 'over' || sim.won) {
      if (demo) demoNext(); else endScreen();
    } else if (demoPlan && demo) {
      // A death, the asteroid belt or a boss: deal again rather than show the
      // respawn, the rocks or a fight the bot was not put here for.
      if (sim.player.lives < demoLives || hazard(sim)) demoNext();
      // And a hand that is going nowhere. A wave reinforces, so a gun that
      // kills at about the rate the anchor rebuilds holds the level's program
      // on one gate indefinitely -- true of the game and fine to lose a run
      // to, but nothing to watch for half a minute. Thirty-five seconds on the
      // same opcode is a new deal.
      else if (sim.pc !== demoPc) { demoPc = sim.pc; demoPcAt = sim.tick; }
      else if (sim.tick - demoPcAt > 2500) demoNext();
    }
  }
  const a = clock.alpha;

  renderer.begin();
  // One place that knows a sprite id can have a baked twin.
  const put = (gid, x, y, fallback) =>
    renderer.draw(frames[gid] || fallback, x, y, renderer.bigOf(gid));
  for (const e of sim.entities) {
    // `+0x0c` bit 0 is what says an object is drawn at all, and a formation
    // anchor or a boss core is not one: it is a position with behaviour, and it
    // has no sprite. Drawing them anyway meant `sprite + frame` resolved to
    // whatever gid the frame index happened to name -- which is the stray fly's
    // head that sat motionless in the corner of the level 2 boss fight.
    if (!e.tpl.drawn) continue;
    // Sim.spriteOf, not a second copy of the rule: it is what knows an entity
    // is mid-explosion, and a local copy here silently drew the idle animation
    // through the whole death sequence.
    put(sim.spriteOf(e), Sim.lerpX(e, a), Sim.lerpY(e, a), frames[e.tpl.sprite]);
  }
  // Three loops rather than `bullets.concat(drops, enemyShots)`: that built a
  // fresh array every frame, and this one runs up to 240 times a second.
  for (const list of [sim.bullets, sim.drops, sim.enemyShots])
    for (const b of list)
      put(b.sprite, Sim.lerpX(b, a), Sim.lerpY(b, a));
  if (sim.pod)
    put(sim.pod.sprite, Sim.lerpX(sim.pod, a), Sim.lerpY(sim.pod, a));
  // The ship, or -- while it is dying -- its explosion and then its wreck: all
  // three live in the same `frame`, which is how the original does it too.
  // A ship inside its mercy period blinks, at eight or so a second off the
  // simulation's own clock so the rate does not follow the frame rate.
  const blink = sim.player.invuln > 0 && (Math.floor(sim.tick / 4) & 1);
  if (sim.player.state !== 'over' && !blink) {
    const sx = Sim.lerpX(sim.player, a), sy = Sim.lerpY(sim.player, a);
    drawExhaust(sim.player.frame, sx, sy);
    put(sim.player.frame, sx, sy);
  }
  // The announcement banner, over everything else. Each character is its own
  // 8-pixel cell in the atlas, baked in the ramp the line was queued with.
  if (sim.msg) {
    const T = data.text, m = sim.msg;
    const mx = m.px + (m.x - m.px) * a;
    for (let i = 0; i < m.text.length; i++) {
      const f = frames[T.glyph + m.colour * 256 + m.text.charCodeAt(i)];
      if (f) renderer.draw(f, mx + i * T.cell, m.y);
    }
  }
  renderer.flush(canvas.width, canvas.height);

  fpsN++;
  const now = performance.now();
  if (now - fpsT > 500) { fps = fpsN * 1000 / (now - fpsT); fpsT = now; fpsN = 0; }
  // The HUD is DOM. Nothing in it can change between ticks, and nobody can read
  // seventy distinct states a second anyway -- thirty is plenty, and it keeps
  // style and layout work off most frames.
  if (clock.tick !== hudTick && now - hudT > 33) {
    hudTick = clock.tick; hudT = now;
    panel.update(sim);
  }
  // Only what the HUD does not already say: the HUD is the readout now, this
  // line is for watching the machinery. Eight times a second is plenty -- a
  // text change here invalidates layout, and doing that every frame is a real
  // cost for something nobody can read at 240 Hz.
  if (!showStats || now - statsT < 125) { requestAnimationFrame(frame); return; }
  statsT = now;
  hud.textContent =
    `L${level} · tick ${clock.tick} · ${(clock.tick / data.tickHz).toFixed(1)}s · ` +
    `${sim.entities.length} entities · ${sim.bullets.length + sim.enemyShots.length} shots · ` +
    `${sim.kills} kills · ${sim.picked} picked · ${sim.drops.length} drops · ` +
    `${fps.toFixed(0)} fps · sim ${data.tickHz.toFixed(4)} Hz · α ${a.toFixed(2)}`;
  requestAnimationFrame(frame);
}
// Straight into the game when a debug flag says which moment to look at;
// otherwise the menu, which is what a player sees.
if (!menu || q.has('tick') || q.has('nogates') || demo) startGame();
else { document.body.dataset.screen = 'menu'; menu.show(true); }
requestAnimationFrame(frame);

/**
 * Lift the veil once there is a finished picture behind it.
 *
 * Three things, and each of them moved the layout when it arrived late: the
 * display face, which makes the head and the foot taller; the baked title,
 * which swaps under the eye; and one composed frame, after which `resize` has
 * measured the real page rather than the CSS fallbacks. The race is a guard
 * against a network that never answers -- a veil that sticks is worse than a
 * page that shifts.
 */
(async () => {
  const settled = Promise.all([
    document.fonts?.ready ?? Promise.resolve(),
    menu ? menu.ready : Promise.resolve(),
  ]);
  await Promise.race([settled, new Promise(r => setTimeout(r, 10000))]);
  resize();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  boot.finish();
})();
