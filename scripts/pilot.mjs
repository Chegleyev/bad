/**
 * Fly the game with a bot, so weapons can be compared by outcome rather than
 * by arithmetic.
 *
 *   node scripts/pilot.mjs                     every weapon, levels 1..8
 *   node scripts/pilot.mjs --levels 1,5,8      some of them
 *   node scripts/pilot.mjs --seeds 6           six runs of each, for spread
 *   node scripts/pilot.mjs --tiers 1,2         damage multipliers to try
 *
 * The bot plays each weapon the way a player who has learned it would, which
 * means it *does* know its own barrels. An earlier version was deliberately
 * weapon-blind for fairness and that turned out to measure the wrong thing: it
 * could not hold a target in a two-barrel lane, so it understated every
 * precision weapon and flattered every spread one. What a balance question
 * wants is each gun played as well as that gun can be played.
 *
 * Three things it does that the blind version did not:
 *
 *   * **It works out whether a volley would actually connect**, by flying each
 *     barrel's shot -- its own dx, vx, vy -- against every enemy's box and
 *     solving for the tick their rows meet. No smooth "is it roughly in front"
 *     field: either the shot arrives inside the silhouette or it does not.
 *
 *   * **It holds fire.** The blind version kept the trigger down and spent its
 *     magazine on empty sky, which is most of why it starved 60-90% of the
 *     time. A round only comes back when its shot hits or leaves the screen, so
 *     firing at nothing is not free -- it is the most expensive thing in the
 *     game. This one shoots when a shot would land, or when the magazine is
 *     full enough that a wasted round costs nothing.
 *
 *   * **It dodges what would actually hit it.** For each direction it could
 *     hold, the ship's own trajectory is walked ninety ticks out, and every
 *     enemy shot is solved for the tick it reaches the ship's row -- then
 *     compared against where the ship will be *at that tick*. Bullets are what
 *     kill it, about fifteen times as often as bodies, and a wide smooth field
 *     of "danger nearby" mostly taught it to back into them.
 */
import { readFileSync } from 'node:fs';
import { Sim } from '../src/sim.js';
// The brain lives in the game, so the bot measured here is the bot that plays.
import { decide } from '../src/autopilot.js';

const FP = 65536;

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
const levels = String(arg('levels', '1,2,3,4,5,6,7,8')).split(',').map(Number);
const seeds = Number(arg('seeds', 4));
const tiers = String(arg('tiers', '1,2')).split(',').map(Number);
const only = arg('weapon', null);
// `fireEveryMin` is 4 and the template's own cadence is 7: " RELOAD " walks the
// gun from one to the other. Pinned like the damage tier, and for the same
// reason -- a death drops it back and an unpinned run measures the ladder.
const reload = arg('reload', null);
// And the same for " SIDE SPEED UP ", which starts at 1 and stops at 4. Nobody
// arrives at level 5 on a cold ship: they arrive on whatever four levels of
// pickups built. Pinning it is the only way to ask what a level is like for the
// ship that actually reaches it.
const speed = arg('speed', null);

const load = (n) =>
  JSON.parse(readFileSync(new URL(`../public/data/level${n}.json`, import.meta.url)));

/**
 * One run. -> what happened, not how it felt.
 *
 * Three things make this an instrument rather than a game. **Lives are not
 * counted down**: with three of them every run ends early and the numbers
 * describe how far the bot got before it ran out, which is a fact about the
 * bot. Given unlimited lives, every weapon gets the same exposure and dying
 * becomes a *rate* -- which is the thing worth comparing.
 *
 * **A stalled run is cut off.** A wave reinforces: `stepAnchor` adds a member
 * every `interval` ticks and winds that interval down to 560, and the script
 * gate after the wave waits for the last member. A gun that cannot kill faster
 * than one enemy per eight seconds therefore does not merely go slowly -- it
 * never gets past the gate at all, and the screen fills with thirty enemies,
 * which is a state no game reaches. Unlimited lives would let that state run
 * for the rest of the cap and swamp every other number in the row. So a run is
 * cut off when it stops getting anywhere: while the program waits on a gate,
 * the fewest members that wave has ever been down to is remembered, and 8 000
 * ticks without a new low ends the run -- the worst such spell in a run that
 * went on to win the level was 4 373, so the bar is set at not quite twice it. Grinding slowly is not a stall -- the
 * floor keeps dropping and the gate will open. Hovering at four of them for a
 * minute, killing exactly as fast as the wave rebuilds itself, is: the gate
 * wants the last one. That is the sharpest thing a weapon can fail at, so it
 * is reported rather than buried in a low average.
 *
 * And **the weapon is pinned across respawns**. `sub_327a` drops the gun one
 * rung down its ladder on every death, so an unpinned run testing TRIDENT is
 * really testing TRIDENT, then ANNIHILATOR, then BLASTER. Re-equipping after
 * each death keeps the question the one that was asked.
 */
function run({ level, weapon, tier, seed }) {
  const data = load(level);
  const sim = new Sim(data);
  sim.rngState = seed;
  const p = sim.player;
  const W = data.player.weapons[weapon];
  p.weapon = null;
  p.equip(weapon, sim);
  p.damage = Math.round(W.damage * tier);
  if (reload) p.fireEvery = Number(reload);
  if (speed) p.maxSpeed = Number(speed);
  // `equip` leaves two volleys' worth, which is what a gun just picked up
  // carries. A comparison wants the steady state instead: a full magazine, the
  // way a run that has been collecting WEAPON BOOST all level actually flies.
  p.ammo = W.mag;
  const barrels = W.barrels.length;

  const cap = (data.level.events.at(-1)[0] + 1200) * 2;
  let deaths = 0, volleys = 0, starved = 0, ticks = 0;
  let pc = sim.pc, stalled = false;
  // What the gate the script is parked on is waiting for, counted the way the
  // interpreter counts it. -1 when the program is not waiting on one at all.
  const waveLeft = () => {
    const op = sim.prog[sim.pc];
    if (!op || op[0] !== 'g') return -1;
    const a = sim.slots[op[1]];
    if (a) return a.alive;
    return sim.entities.reduce((n, e) => n + (!e.dead && !e.exploding &&
      (e.tpl.type === 31 || e.tpl.type === 30) && e.tpl.group === op[1] ? 1 : 0), 0);
  };
  let fewest = Infinity, fewestAt = 0;
  p.lives = 9999;
  let lives = p.lives;
  let prevCool = p.cool ?? 0;
  while (ticks < cap) {
    const flying = p.state === 'fly';
    const act = flying ? decide(sim, W) : { dx: 0, fire: true };
    sim.step({ dx: act.dx, dy: 0, fire: act.fire });
    ticks++;
    if (flying) {
      // A volley is `cool` jumping back up to the reload. It is never *seen* at
      // zero from out here: `Player.step` decrements it and fires in the same
      // call, so it reads 7,6,5,4,3,2,1,7 and never 0.
      if (p.cool === p.fireEvery && prevCool < p.fireEvery) volleys++;
      // ...and starved is simply "could not have fired a full volley", which is
      // the constraint that actually binds. See the note in the report.
      if (p.ammo < barrels) starved++;
    }
    prevCool = p.cool;
    if (p.lives < lives) {
      deaths += lives - p.lives;
      lives = p.lives;
      // put the gun back: the respawn just dropped it a rung
      if (p.weapon !== weapon) { p.weapon = null; p.equip(weapon, sim); }
      p.damage = Math.round(W.damage * tier);
      p.fireEvery = Number(reload) || data.player.fireEvery;
      if (speed) p.maxSpeed = Number(speed);
      p.ammo = W.mag;
    }
    if (sim.pc !== pc) { pc = sim.pc; fewest = Infinity; fewestAt = ticks; }
    const left = waveLeft();
    if (left < 0 || left < fewest) { fewest = left < 0 ? Infinity : left; fewestAt = ticks; }
    else if (ticks - fewestAt > 8000) { stalled = true; break; }
    if (sim.won) break;
  }
  const mins = ticks / data.tickHz / 60;
  return {
    won: sim.won, stalled, ticks, deaths, kills: sim.kills, score: sim.score,
    shots: volleys * barrels,
    starved: starved / Math.max(1, ticks),
    progress: 100 * sim.pc / sim.prog.length,
    deathsPerMin: deaths / mins,
    killsPerMin: sim.kills / mins,
    progPerMin: 100 * sim.pc / sim.prog.length / mins,
    secs: ticks / data.tickHz,
  };
}

// ---- the sweep -------------------------------------------------------------
const NAMES = { 1057: 'CANNON', 1058: 'PHASER', 1059: 'BLASTER',
                1060: 'ANNIHILATOR', 1061: 'TRIDENT' };
const ORDER = Object.keys(NAMES).map(Number).filter(id => !only || NAMES[id] === only);

const pad = (s, n) => String(s).padStart(n);
for (const tier of tiers) {
  console.log(`\n${'='.repeat(78)}\ndamage x${tier}${tier === 2 ? '  (the upgrade ceiling)' : '  (as picked up)'}${reload ? `, reload every ${reload}` : ''}${speed ? `, speed ${speed}` : ''}\n`);
  console.log('  level  weapon           won  stalled  through  deaths/min  kills/min  %/min  starved');
  for (const level of levels) {
    for (const id of ORDER) {
      const rs = [];
      for (let s = 0; s < seeds; s++) rs.push(run({ level, weapon: id, tier, seed: 12345 + s * 7919 }));
      const avg = (f) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
      const wins = rs.filter(r => r.won).length;
      console.log(
        `  ${pad(level, 5)}  ${NAMES[id].padEnd(14)}` +
        `${pad(`${wins}/${rs.length}`, 5)}` +
        `${pad(`${rs.filter(r => r.stalled).length}/${rs.length}`, 9)}` +
        `${pad(avg(r => r.progress).toFixed(0) + '%', 9)}` +
        `${pad(avg(r => r.deathsPerMin).toFixed(1), 12)}` +
        `${pad(avg(r => r.killsPerMin).toFixed(0), 11)}` +
        `${pad(avg(r => r.progPerMin).toFixed(1), 7)}` +
        `${pad((avg(r => r.starved) * 100).toFixed(0) + '%', 9)}`);
    }
    if (levels.length > 1) console.log();
  }
}
