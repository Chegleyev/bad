// Headless check: run the simulation without a browser and assert it reproduces
// the original's motion model. Node has no DOM, and none of sim.js needs one.
import { readFileSync, existsSync } from 'node:fs';
import { Sim } from '../src/sim.js';
import { Clock } from '../src/clock.js';

const data = JSON.parse(readFileSync(new URL('../public/data/level1.json', import.meta.url)));
const sim = new Sim(data);

// 1. A path segment moves for exactly `duration` ticks and then stalls one.
const gid = data.level.events[0][1];
const tpl = data.templates[gid];
const path = data.paths[tpl.path];
console.log(`template ${gid}: type ${tpl.type}, sprite ${tpl.sprite}, ` +
            `${tpl.frames} frames, path ${tpl.path} with ${path.length} segments`);

const e = sim.spawn(gid);
const x0 = e.x, y0 = e.y;
const [dur, , vx, vy] = path[0];
for (let i = 0; i < dur + 1; i++) sim.step();
const moved = [(e.x - x0) / 65536, (e.y - y0) / 65536];
const want = [vx * dur, vy * dur];
const ok = Math.abs(moved[0] - want[0]) < 1e-6 && Math.abs(moved[1] - want[1]) < 1e-6;
console.log(`segment 0: moved ${moved} over ${dur} ticks + 1 stall, want ${want} -> ${ok ? 'OK' : 'FAIL'}`);
if (!ok) process.exit(1);

// 2. Run the whole level and see that it spawns and retires sanely.
const sim2 = new Sim(data);
let peak = 0, spawned = 0;
const total = data.level.events.at(-1)[0] + 600;
for (let t = 0; t < total; t++) {
  const before = sim2.entities.length;
  sim2.step();
  spawned += Math.max(0, sim2.entities.length - before);
  peak = Math.max(peak, sim2.entities.length);
}
console.log(`full level: ${total} ticks (${(total / data.tickHz).toFixed(1)} s), ` +
            `peak ${peak} entities alive, ${sim2.entities.length} left at the end`);

// 3. The clock must produce exactly tickHz ticks per simulated second.
let now = 0, ticks = 0;
const clock = new Clock(data.tickHz, { now: () => now });
clock.advance(() => {});
for (let f = 0; f < 60; f++) { now += 1 / 60; clock.advance(() => ticks++); }
console.log(`clock: 60 frames of 1/60 s -> ${ticks} ticks (want ${Math.round(data.tickHz)})`);
if (Math.abs(ticks - data.tickHz) > 1.5) process.exit(1);

// 4. Silhouette collision: a shot placed on an enemy hits, one beside it misses.
import { hit } from '../src/collide.js';
{
  const sim3 = new Sim(data);
  const gid = data.level.events.find(([, g]) => (data.templates[g] || {}).type === 31)?.[1];
  const e = sim3.spawn(gid);
  const sg = e.tpl.sprite, ef = data.atlas.frames[sg], em = data.masks[sg];
  const bg = data.player.bullet, bf = data.atlas.frames[bg], bm = data.masks[bg];
  if (!em || !bm) { console.error('missing masks'); process.exit(1); }

  // Line the shot up with the first row of the enemy that has any pixels at all.
  // Masks are flat, `ceil(w / 32)` dwords per row, bit x meaning pixel x.
  const en = (ef.w + 31) >> 5;
  const i = em.findIndex(m => m !== 0);
  const row = (i / en) | 0;
  const col = (i % en) * 32 + 31 - Math.clz32(em[i] & -em[i]);   // lowest set bit
  const on = hit(0, 0, em, ef.w, ef.h, col, row, bm, bf.w, bf.h);
  const off = hit(0, 0, em, ef.w, ef.h, col + 60, row, bm, bf.w, bf.h);
  console.log(`collision: enemy sprite ${sg} ${ef.w}x${ef.h}, first pixel at row ${row} col ${col}`);
  console.log(`  shot on it  -> ${on ? 'hit' : 'miss'}   (want hit)`);
  console.log(`  shot 60px aside -> ${off ? 'hit' : 'miss'}   (want miss)`);
  if (!on || off) process.exit(1);
}

// 4b. Collision layers: `sub_56a6` pairs the ship with enemy fire but not with
//     an enemy's body, so a fly flown straight through the ship is harmless.
import { pairs, exact } from '../src/collide.js';
{
  const P = data.player;
  const en = data.templates[data.level.events.find(
    ([, g]) => (data.templates[g] || {}).type === 31)[1]];
  const fire = Object.values(data.templates).find(t => t.fire && t.fire.layer);
  const drop = Object.values(P.dropItems)[0];
  const rows = [
    ['ship vs enemy body ', pairs(P.layer, P.hits, en.layer, en.hits), false],
    ['ship vs enemy shot ', pairs(P.layer, P.hits, fire.fire.layer, fire.fire.hits), true],
    ['ship vs pickup     ', pairs(P.layer, P.hits, drop.layer, drop.hits), true],
    ['shot vs enemy body ', pairs(P.bulletLayer, P.bulletHits, en.layer, en.hits), true],
    ['shot vs ship       ', pairs(P.bulletLayer, P.bulletHits, P.layer, P.hits), false],
  ];
  for (const [what, got, want] of rows) {
    console.log(`layers: ${what} -> ${got ? 'pair' : 'no pair'}   (want ${want ? 'pair' : 'no pair'})`);
    if (got !== want) process.exit(1);
  }
  // And only pairs carrying 0x10 -- the ship and the type-35 enemies -- are
  // decided on silhouettes; a shot against a fly is a bounding box.
  const px = exact(P.layer, drop.layer), bx = exact(P.bulletLayer, en.layer);
  console.log(`layers: ship vs pickup ${px ? 'silhouette' : 'box'} (want silhouette), ` +
              `shot vs enemy ${bx ? 'silhouette' : 'box'} (want box)`);
  if (!px || bx) process.exit(1);
}

// 4c. The guns. A weapon is its projectile template; a type-16 one fires a
//     barrel per record at +0xb4, and the magazine counts projectiles, so the
//     volley costs exactly one round per barrel.
{
  const P = data.player;
  for (const [item, id] of Object.entries(P.weaponOf)) {
    const s = new Sim(data);
    s.player.weapon = null;
    s.player.equip(Number(id), s);
    const g = s.player.gun;
    s.player.cool = 0;
    const before = s.bullets.length, ammo = s.player.ammo;
    s.player.step({ dx: 0, dy: 0, fire: true }, s);
    const fired = s.bullets.length - before;
    const vx = s.bullets.map(b => (b.vx / 65536).toFixed(2)).join(' ');
    console.log(`weapon ${id} (item ${item}): ${fired} barrels, ` +
                `${ammo}->${s.player.ammo} rounds of ${g.mag}, dmg ${s.player.damage}, vx [${vx}]`);
    if (fired !== g.barrels.length) process.exit(1);
    if (s.player.ammo !== ammo - fired) process.exit(1);
    if (g.cost !== g.barrels.length) process.exit(1);
    // Picking the same gun up again sharpens it instead of re-equipping.
    const d0 = s.player.damage;
    s.player.equip(Number(id), s);
    s.player.equip(Number(id), s);
    s.player.equip(Number(id), s);
    s.player.equip(Number(id), s);
    if (s.player.damage <= d0 || s.player.damage > g.damage * P.weaponUpCap) process.exit(1);
    console.log(`  four more of the same: dmg ${d0} -> ${s.player.damage} (cap ${g.damage * P.weaponUpCap})`);
  }
}

// 4d. The announcement banner: the level script says its lines in the grey
//     ramp, a pickup says its own name in the player's, and the marquee lands
//     centred after `text.length + 40` ticks of 4 pixels.
{
  const T = data.text;
  const s = new Sim(data);
  const said = [];
  let last = null;
  for (let t = 0; t < 700; t++) {
    s.step({ dx: 0, dy: 0, fire: false });
    if (s.msg && s.msg !== last) { last = s.msg; said.push([t, s.msg.text]); }
  }
  console.log(`banner: ${said.length} lines in the first 10 s, first at tick ${said[0][0]}: ` +
              `"${said[0][1]}"`);
  if (said.length < 2) process.exit(1);

  // Centring: after segment 0 the line should sit within a few pixels of centre.
  const s2 = new Sim(data);
  s2.announce(16, T.playerColour);
  const n = T.strings[16].text.length + 40;
  for (let i = 0; i <= n; i++) s2.stepMessage();
  const w = s2.msg.text.length * T.cell, off = s2.msg.x - (320 - w) / 2;
  console.log(`banner: " ${s2.msg.text.trim()}" holds at x=${s2.msg.x}, ` +
              `${off} px off centre, colour ${s2.msg.colour} (want the player ramp)`);
  if (Math.abs(off) > 8 || s2.msg.colour !== T.playerColour) process.exit(1);

  // And every glyph a line can use has to be in the atlas.
  let missing = 0;
  for (const [i, st] of Object.entries(T.strings))
    for (const c of st.text)
      for (let b = 0; b < T.bases.length; b++)
        if (!data.atlas.frames[T.glyph + b * 256 + c.charCodeAt(0)]) missing++;
  console.log(`banner: ${missing} glyphs missing from the atlas (want 0)`);
  if (missing) process.exit(1);
}

// 4e. The ship's condition: it has hit points, not one life per touch, and the
//     six-marker set promotes it.
{
  const P = data.player;
  const s = new Sim(data);
  const p = s.player;
  console.log(`ship: ${p.hp}/${p.maxHp} hp, ${p.lives} lives, rank ${p.rank}, ` +
              `condition ${p.dignity} of 3`);
  if (p.hp !== 11 || p.maxHp !== 11 || p.lives !== 3) process.exit(1);

  // The level-1 shooter's projectile does 2, so it takes six to finish you.
  const dmg = Object.values(data.templates).find(t => t.fire && t.fire.damage).fire.damage;
  let hits = 0;
  while (p.deaths === 0 && hits < 20) {
    p.decay += dmg;
    p.step({ dx: 0, dy: 0, fire: false }, s);
    hits++;
  }
  console.log(`ship: ${dmg} damage a shot, dead after ${hits} of them, ` +
              `state "${p.state}", ${p.lives} lives still showing`);
  if (hits !== Math.floor(11 / dmg) + 1 || p.state !== 'dying') process.exit(1);
  if (p.lives !== 3) process.exit(1);        // the life goes when the wreck starts

  // Condition falls as the ship is worn down, by the table at data:0x24a5.
  const s2 = new Sim(data), q = s2.player;
  const seen = [];
  for (let hp = 11; hp >= 0; hp--) { q.hp = hp; seen.push(q.dignity); }
  console.log(`ship: condition by hp 11..0 -> ${seen.join('')}`);
  if (seen.join('') !== '332222211111') process.exit(1);   // 3 at 10+, 2 at 5..9, 1 below

  // Six markers promote: +2 to the cap, a refill, and a rank.
  const s3 = new Sim(data), r = s3.player;
  r.hp = 4;
  const markers = Object.entries(P.effects).filter(([, e]) => e === 'marker').map(([i]) => Number(i));
  for (const it of markers) s3.collect(it, P.itemArg[it]);
  console.log(`ship: six markers -> rank ${r.rank}, ${r.hp}/${r.maxHp} hp, ` +
              `queued "${(data.text.strings[26] || {}).text}"`);
  if (r.rank !== 2 || r.maxHp !== 13 || r.hp !== 13) process.exit(1);
  if (!s3.queued || s3.queued[0] !== 26) process.exit(1);
  // A seventh marker is a duplicate now that the mask has reset: credits.
  s3.collect(markers[0], P.itemArg[markers[0]]);
  s3.collect(markers[0], P.itemArg[markers[0]]);
  console.log(`ship: a repeated marker pays ${r.credits} credits instead`);
  if (r.credits !== 1) process.exit(1);
}

// 4f. The rest of the prizes.
{
  const P = data.player;
  const fresh = () => new Sim(data);

  // " ENGINES BOOST " is a hop: up to 268 without steering, back down to 308.
  {
    const s = fresh(), p = s.player;
    p.y = Math.round(P.boost.fromY * 65536);
    s.collect(21);
    let top = p.y, ticks = 0;
    while (p.state !== 'fly' && ticks < 2000) {
      s.step({ dx: 1, dy: 0, fire: false });
      top = Math.min(top, p.y); ticks++;
    }
    console.log(`boost: rose to y=${(top / 65536).toFixed(1)} (want ${P.boost.topY}), ` +
                `back at ${(p.y / 65536).toFixed(1)} after ${ticks} ticks`);
    if (Math.abs(top / 65536 - P.boost.topY) > 2) process.exit(1);
    if (p.y !== Math.round(P.boost.fromY * 65536)) process.exit(1);
  }

  // " MEGABLAST " does 48 to everything wearing the enemy layer, at once.
  {
    const s = fresh();
    for (let t = 0; t < 1200; t++) s.step({ dx: 0, dy: 0, fire: false });
    const live = s.entities.filter(e => !e.dead && !e.exploding && (e.tpl.layer & 0x40));
    s.collect(3);
    const dealt = live.filter(e => e.decay >= P.megablast).length;
    console.log(`megablast: ${dealt} of ${live.length} enemies took ${P.megablast}`);
    if (live.length === 0 || dealt !== live.length) process.exit(1);
  }

  // " PARALYSER " puts one companion 70 px above the ship for 700 ticks.
  {
    const s = fresh(), p = s.player;
    s.collect(2);
    s.collect(2);                                   // a second is refused
    const o = s.pod;
    console.log(`paralyser: pod at (${(o.x - p.x) / 65536}, ${(o.y - p.y) / 65536}) ` +
                `from the ship, ${o.life} ticks`);
    if (!o || o.life !== P.pod.life) process.exit(1);
    if ((o.y - p.y) / 65536 !== P.pod.off[1]) process.exit(1);
    for (let t = 0; t < P.pod.life + 2; t++) s.step({ dx: 0, dy: 0, fire: false });
    console.log(`paralyser: gone after its ${P.pod.life} ticks: ${s.pod === null}`);
    if (s.pod !== null) process.exit(1);
  }

  // " CREDIT DOUBLER " is all or nothing against the 999 cap.
  {
    const s = fresh(), p = s.player;
    p.credits = 40; s.collect(25);
    const doubled = p.credits;
    p.credits = 600; s.collect(25);
    console.log(`credits: 40 -> ${doubled}, 600 -> ${p.credits} (cap ${P.creditCap})`);
    if (doubled !== 80 || p.credits !== 600) process.exit(1);
  }

  // " RANDOMIZER " lands on something the drop table can give.
  {
    const s = fresh();
    const before = JSON.stringify([s.player.maxSpeed, s.player.weapon, s.player.credits,
                                   s.player.lives, s.player.ammo]);
    let changed = 0;
    for (let i = 0; i < 40; i++) {
      const t = JSON.stringify([s.player.maxSpeed, s.player.weapon, s.player.credits,
                                s.player.lives, s.player.ammo]);
      s.collect(23);
      if (JSON.stringify([s.player.maxSpeed, s.player.weapon, s.player.credits,
                          s.player.lives, s.player.ammo]) !== t) changed++;
    }
    console.log(`randomizer: 40 rolls changed the ship ${changed} times`);
    if (changed === 0) process.exit(1);
    void before;
  }
}

// 4g. A prize is solid: it can be shot down instead of caught, and a hit it
//     survives knocks it up and back towards the middle of the screen.
{
  const P = data.player;
  const kind = Object.values(P.dropItems).find(k => k.hp > 0);
  /** A sim with exactly one pickup, at x, built the way `dropAt` builds them. */
  const withDrop = (x) => {
    const s = new Sim(data);
    s.drops.length = 0;
    s.rnd = () => 0;                      // the roll passes, and lands on entry 0
    s.dropAt({ x: x * 65536, y: 100 * 65536, tpl: { sprite: kind.sprite } });
    const d = s.drops[0];
    d.x = x * 65536; d.vx = 0; d.vy = 0;
    return [s, d];
  };

  for (const [side, x] of [['right', 250], ['left', 60]]) {
    const [s, d] = withDrop(x);
    d.decay = 1;                          // a hit it survives
    s.step({ dx: 0, dy: 0, fire: false });
    console.log(`prize (${side} of centre): vy 0 -> ${(d.vy / 65536).toFixed(3)}, ` +
                `vx ${(d.vx / 65536).toFixed(4)}`);
    if (d.vy >= 0) process.exit(1);                            // it hopped
    if (side === 'right' && d.vx >= 0) process.exit(1);        // shoved left
    if (side === 'left' && d.vx <= 0) process.exit(1);         // shoved right
  }

  // Enough damage and it explodes rather than being collected.
  {
    const [s, d] = withDrop(160);
    const dmg = P.weapons[P.startWeapon].damage;
    let shots = 0;
    while (!d.exploding && shots < 40) {
      d.decay += dmg;
      s.step({ dx: 0, dy: 0, fire: false });
      shots++;
    }
    console.log(`prize: ${d.hp} hp left after ${shots} hits of ${dmg}, ` +
                `exploding on sprite ${d.sprite} of ${JSON.stringify(d.explode)}`);
    if (!d.exploding) process.exit(1);
    let t = 0;
    while (!d.dead && t++ < 200) s.step({ dx: 0, dy: 0, fire: false });
    console.log(`prize: the explosion runs out after ${t} ticks and it is gone`);
    if (!d.dead) process.exit(1);
  }

  // " RANDOMIZER " must name what you actually got, not itself.
  {
    const s = new Sim(data);
    const names = new Set();
    for (let i = 0; i < 30; i++) {
      s.msg = null; s.queued = null;
      s.collect(23);
      if (s.queued) names.add(data.text.strings[s.queued[0]].text.trim());
    }
    console.log(`randomizer: announced ${names.size} different effects, ` +
                `e.g. ${[...names].slice(0, 3).map(n => `"${n}"`).join(', ')}`);
    if (names.has('RANDOMIZER') || names.size < 2) process.exit(1);
  }
}

// 4h. Dying: an explosion, then the wreck falls off the bottom, then the ship
//     comes back one gun poorer.
{
  const P = data.player;
  const s = new Sim(data), p = s.player;
  p.weapon = null; p.equip(1060, s);                 // the four-way
  p.maxSpeed += P.sideStep;                          // one side-speed upgrade
  p.fireEvery = P.fireEveryMin;                      // and a fully rapid trigger
  const before = { gun: p.weapon, speed: p.maxSpeed, fire: p.fireEvery, lives: p.lives };

  p.decay = 99;
  s.step({ dx: 0, dy: 0, fire: false });
  const frames = [];
  let t = 0, sawWreck = false;
  while (p.state !== 'fly' && t++ < 4000) {
    if (p.state === 'wreck') sawWreck = true;
    frames.push(p.frame);
    s.step({ dx: 0, dy: 0, fire: false });
  }
  const ex = frames.filter(f => f >= P.explode[0] && f <= P.explode[1]);
  const wr = frames.filter(f => f >= P.wreck[0] && f <= P.wreck[1]);
  console.log(`death: ${new Set(ex).size} explosion frames of ` +
              `${P.explode[1] - P.explode[0]}, then ${new Set(wr).size} wreck frames, ` +
              `${t} ticks in all`);
  if (!sawWreck || new Set(ex).size < 10 || new Set(wr).size < 5) process.exit(1);

  console.log(`death: lives ${before.lives} -> ${p.lives}, ` +
              `gun ${before.gun} -> ${p.weapon}, ` +
              `side speed ${before.speed} -> ${p.maxSpeed}, ` +
              `reload ${before.fire} -> ${p.fireEvery}, ${p.hp}/${p.maxHp} hp`);
  if (p.lives !== before.lives - 1) process.exit(1);
  if (p.weapon !== P.weapons[1060].prev) process.exit(1);      // one rung down
  if (p.maxSpeed !== before.speed - P.sideStep) process.exit(1);
  if (p.fireEvery !== P.fireEvery || p.hp !== p.maxHp) process.exit(1);

  // The starting gun has nothing below it, and the last life ends the game.
  const s2 = new Sim(data), q = s2.player;
  q.lives = 1;
  q.decay = 99;
  let u = 0;
  while (q.state !== 'over' && u++ < 4000) s2.step({ dx: 0, dy: 0, fire: false });
  console.log(`death: last life -> state "${q.state}" after ${u} ticks, ` +
              `gun still ${q.weapon}`);
  if (q.state !== 'over' || q.weapon !== P.startWeapon) process.exit(1);
}

// 4i. The asteroid belt. It is not a mini-game between levels: it is a stretch
//     of the level, run by a type-13 emitter the script turns up in stages.
import { pairs as layerPairs } from '../src/collide.js';
{
  const P = data.player;
  const em = Object.entries(data.templates).find(([, t]) => t.emitter);
  if (!em) { console.error('no emitter template'); process.exit(1); }
  const [eid, etpl] = em;
  console.log(`belt: emitter ${eid}, ${etpl.emitter.rocks.length} rocks, ` +
              `default 1 roll per ${etpl.emitter.period} ticks at ` +
              `${(etpl.emitter.density * 100 / 256).toFixed(0)}%`);

  // Driven at the belt's last and thickest setting.
  const s = new Sim(data);
  const e = s.spawn(Number(eid));
  e.density = 176; e.period = 16; e.speed = 2816; e.emitTimer = 16;
  const kinds = new Set(), speeds = [], xs = [], seen = new Set();
  let peak = 0;
  for (let t = 0; t < 4000; t++) {
    s.step({ dx: 0, dy: 0, fire: false });
    const rocks = s.entities.filter(r => r.tpl.type === 14 && !r.dead);
    peak = Math.max(peak, rocks.length);
    for (const r of rocks) {
      kinds.add(r.gid);
      if (seen.has(r)) continue;            // measure each rock once, as thrown
      seen.add(r);
      speeds.push(r.vy / 65536);
      xs.push(r.x / 65536);
    }
  }
  console.log(`belt: ${seen.size} rocks thrown over 4000 ticks`);
  console.log(`belt: ${kinds.size} of ${etpl.emitter.rocks.length} kinds thrown, ` +
              `peak ${peak} on screen, falling ${Math.min(...speeds).toFixed(1)}..` +
              `${Math.max(...speeds).toFixed(1)} px/tick across x ` +
              `${Math.min(...xs).toFixed(0)}..${Math.max(...xs).toFixed(0)}`);
  // The belt is a stream, not a wall: a roll every 16 ticks at 69% is a rock
  // every ~23, and one crosses the screen in 45..85, so a handful are in the
  // air at any moment. It looked like sixty until rocks stopped wrapping.
  if (kinds.size !== etpl.emitter.rocks.length || peak < 3) process.exit(1);
  if (Math.min(...xs) > 60 || Math.max(...xs) < 260) process.exit(1);

  // A rock is layer 0xc0 -- unlike a fly, the ship's 0x80 interest picks it up,
  // so the belt is the one place a body hurts you. And it can be shot.
  const rock = data.templates[etpl.emitter.rocks[0][0]];
  const vsShip = layerPairs(P.layer, P.hits, rock.layer, rock.hits);
  const vsShot = layerPairs(P.bulletLayer, P.bulletHits, rock.layer, rock.hits);
  console.log(`belt: rock vs ship ${vsShip ? 'pairs' : 'no pair'} (want pairs), ` +
              `vs shot ${vsShot ? 'pairs' : 'no pair'} (want pairs), ` +
              `hp ${etpl.emitter.rocks.map(r => data.templates[r[0]].hp).join('/')}`);
  if (!vsShip || !vsShot) process.exit(1);

  // A rock breaks up rather than blinking out, and the bigger it is the bigger
  // the debris: each size points at its own type-5 object through +0x8c.
  const sizes = [...new Set(etpl.emitter.rocks.map(r => data.templates[r[0]].explode.join('-')))];
  console.log(`belt: ${sizes.length} distinct debris animations for ${etpl.emitter.rocks.length} rocks: ` +
              sizes.join(', '));
  if (sizes.length < 3) process.exit(1);
  for (const [tid] of etpl.emitter.rocks) {
    const t = data.templates[tid];
    if (!t.explode || !t.explodeCentred) process.exit(1);
    for (let g = t.explode[0]; g < t.explode[1]; g++)
      if (!data.atlas.frames[g]) { console.error('missing debris frame', g); process.exit(1); }
  }
  {
    const s3 = new Sim(data);
    const r = s3.spawn(etpl.emitter.rocks[11][0]);
    r.free = true; r.vx = 0; r.vy = 0;
    r.x = 160 * 65536; r.y = 100 * 65536;
    r.decay = 9999;
    let shown = 0, ticks = 0;
    while (!r.dead && ticks++ < 200) {
      s3.step({ dx: 0, dy: 0, fire: false });
      if (r.exploding && !r.dead) shown++;
    }
    console.log(`belt: the 300-point rock breaks up over ${ticks} ticks ` +
                `(${data.templates[etpl.emitter.rocks[11][0]].explode.join('..')})`);
    if (ticks < 30 || !r.dead) process.exit(1);
  }

  // The script's own staging, in order.
  const stages = data.level.prog.filter(o => o[0] === 'er' || o[0] === 'es' || o[0] === 'ex');
  console.log(`belt: script stages ${JSON.stringify(stages)}`);
  if (stages.length < 8 || stages[stages.length - 1][0] !== 'ex') process.exit(1);
}

// 4j. Where a DIGNITY MARKER comes from. Not the weighted drop table -- it
//     holds none -- but types 30, 32 and 35, which leave one every time.
{
  const P = data.player, M = P.markerDrop;
  const inTable = new Set(P.dropTable.map(g => P.dropItems[g].item));
  const markers = Object.entries(P.effects).filter(([, e]) => e === 'marker').map(([i]) => +i);
  console.log(`markers: ${markers.filter(i => inTable.has(i)).length} of ` +
              `${markers.length} reachable from the weighted table (want 0)`);
  if (markers.some(i => inTable.has(i))) process.exit(1);

  const s = new Sim(data);
  const heavy = Object.entries(data.templates).find(([, t]) => t.type === 30)[0];
  const got = {};
  for (let i = 0; i < 200; i++) {
    s.drops.length = 0;
    s.dropAt(s.spawn(Number(heavy)));
    const d = s.drops[0];
    if (d) got[d.item] = (got[d.item] || 0) + 1;
  }
  const total = Object.values(got).reduce((a, b) => a + b, 0);
  console.log(`markers: 200 heavy kills -> ${total} drops, all markers: ` +
              `${Object.keys(got).every(i => markers.includes(+i))}, ${JSON.stringify(got)}`);
  if (total !== 200) process.exit(1);
  if (!Object.keys(got).every(i => markers.includes(+i))) process.exit(1);

  // The two loose slots follow what you still owe.
  const s2 = new Sim(data);
  const before = s2.markerSlots.slice(0, 2);
  s2.collect(markers[0], P.itemArg[markers[0]]);
  console.log(`markers: slots ${before} -> ${s2.markerSlots.slice(0, 2)} ` +
              `after taking item ${markers[0]} (want ${M.next[1]})`);
  if (String(s2.markerSlots.slice(0, 2)) !== String(M.next[1])) process.exit(1);
}

// 4k. Damage lands once. +0x5e is a per-tick inbox that the same instruction
//     that applies it clears (`mov [esi+0x5c], eax` is a dword store), not a
//     decay rate -- which is what it was modelled as, so anything hit once kept
//     taking that hit every tick afterwards.
{
  const s = new Sim(data);
  const heavy = Object.entries(data.templates).find(([, t]) => t.type === 30);
  const e = s.spawn(Number(heavy[0]));
  const hp0 = e.hp;
  e.decay = 20;
  s.step({ dx: 0, dy: 0, fire: false });
  const after1 = e.hp;
  for (let t = 0; t < 30; t++) s.step({ dx: 0, dy: 0, fire: false });
  console.log(`damage: ${hp0} hp, one hit of 20 -> ${after1}, ` +
              `and ${after1 - e.hp} more over the next 30 ticks (want 0)`);
  if (after1 !== hp0 - 20 || e.hp !== after1) process.exit(1);

  // So the biggest rock really does need the volleys the numbers say it does.
  const P = data.player, rock = data.templates[P.markerDrop ? 2076 : 2076];
  const gun = P.weapons[1060];
  const volley = gun.barrels.length * gun.damage;
  const s2 = new Sim(data);
  const r = s2.spawn(2076);
  let volleys = 0;
  while (!r.dead && !r.exploding && volleys < 50) {
    r.decay += volley;
    s2.step({ dx: 0, dy: 0, fire: false });
    volleys++;
  }
  console.log(`damage: ${rock.hp} hp rock takes ${volleys} ANNIHILATOR volleys ` +
              `of ${volley} (want ${Math.ceil((rock.hp + 1) / volley)})`);
  if (volleys !== Math.ceil((rock.hp + 1) / volley)) process.exit(1);
}

// 5. Play it: hold fire and drift right, and see that shots retire enemies.
{
  const sim4 = new Sim(data);
  for (let t = 0; t < 1200; t++) sim4.step({ dx: 0, dy: 0, fire: false });
  let fired = 0;
  for (let t = 0; t < 900; t++) {
    const before = sim4.bullets.length;
    sim4.step({ dx: t % 240 < 120 ? 1 : -1, dy: 0, fire: true });
    if (sim4.bullets.length > before) fired++;
  }
  console.log(`play: ${fired} shots fired, ${sim4.kills} enemies destroyed, ` +
              `${sim4.drops.length} drops in flight, ` +
              `player died ${sim4.player.deaths}x`);
  if (fired === 0) process.exit(1);
  if (sim4.kills === 0) { console.error('nothing was ever hit'); process.exit(1); }
}

// 6. Death is an explosion, not a disappearance: `sub_41f8` puts the entity in
//    state 5 and `sub_2a69` walks [+0xac, +0xb0] one frame every third tick.
{
  const sim = new Sim(data);
  const seen = new Map();          // entity -> [firstTick, frames seen]
  let peak = 0, completed = 0;
  for (let t = 0; t < 4000; t++) {
    sim.step({ dx: t % 160 < 80 ? 1 : -1, dy: 0, fire: true });
    const boom = sim.entities.filter(e => e.exploding);
    peak = Math.max(peak, boom.length);
    for (const e of boom) {
      if (!seen.has(e)) seen.set(e, { start: t, frames: new Set() });
      seen.get(e).frames.add(e.frame);
    }
    for (const [e, info] of seen)
      if (e.dead && !info.done) { info.done = true; info.end = t; completed++; }
  }
  const lives = [...seen.values()].filter(i => i.done).map(i => i.end - i.start);
  const frames = [...seen.values()].filter(i => i.done).map(i => i.frames.size);
  const span = data.templates[data.level.events.find(
    ([, g]) => data.templates[g].explode)[1]].explode;
  console.log(`explosions: ${seen.size} started, ${completed} finished, peak ${peak} at once`);
  console.log(`  frames walked ${Math.min(...frames)}..${Math.max(...frames)} ` +
              `of ${span[1] - span[0]} in the range, lasting ${Math.min(...lives)}..` +
              `${Math.max(...lives)} ticks (want ~${3 * (span[1] - span[0])})`);
  if (!completed) { console.error('nothing ever exploded'); process.exit(1); }
  if (Math.max(...frames) < 2) { console.error('explosion never animated'); process.exit(1); }
}
// 7. The boss. Level 1 ends with six objects: two cores that are never drawn,
//    each carrying a wing and a head. Only the head has a collision layer, and
//    killing it has to bring the rest of its half down with it.
{
  const boss = data.level.events.filter(([, g]) => (data.templates[g] || {}).type >= 33);
  const kinds = boss.map(([, g]) => data.templates[g].type);
  console.log(`boss: ${boss.length} objects, types ${kinds.join(',')}`);
  if (kinds.join(',') !== '33,34,35,33,34,35') {
    console.error('the level does not end with two three-part bosses'); process.exit(1);
  }

  const sim = new Sim(data);
  for (const [, g] of boss) sim.spawn(g);
  const [core, wing, gun] = sim.entities;
  if (!wing.parent || !gun.parent) { console.error('parts never found their core'); process.exit(1); }

  // Fly it in and watch the head's animation and its spit.
  let volleys = 0;
  const spit = sim.bossSpit.bind(sim);
  sim.bossSpit = (e, f) => { volleys++; spit(e, f); };
  const frames = new Set(), shotPaths = new Set();
  const start = [core.x, core.y];
  for (let t = 0; t < 1200; t++) {
    sim.step();
    frames.add(sim.spriteOf(gun));
    for (const b of sim.enemyShots) if (b.path) shotPaths.add(b.path);
  }
  const moved = Math.hypot(core.x - start[0], core.y - start[1]) / 65536;
  console.log(`  core flew ${moved.toFixed(0)} px, head used frames ` +
              `${Math.min(...frames)}..${Math.max(...frames)}, ` +
              `${volleys} volleys, ${shotPaths.size} distinct droplet paths`);
  if (moved < 50) { console.error('the core never moved'); process.exit(1); }
  if (Math.max(...frames) < data.templates[gun.gid].fireTo - 2) {
    console.error('the head never played its wind-up'); process.exit(1);
  }
  if (!volleys || shotPaths.size < 4) { console.error('the head never spat a fan'); process.exit(1); }

  // And the kill. The head clears its bit in the core's +0xc8; the core counts
  // out, vacates its anchor slot and drops +0xaa, which retires the wing.
  const before = sim.score;
  gun.decay = 9999;
  let boom = false;
  for (let t = 0; t < 60; t++) {
    sim.step();
    boom = boom || sim.entities.some(e => e.tpl.type === 5);
  }
  console.log(`  head killed: core dead ${core.dead}, wing dead ${wing.dead}, ` +
              `+${sim.score - before} points, ${sim.drops.length} prize, second boom ${boom}, ` +
              `slot ${core.tpl.anchorSlot} ${sim.slots[core.tpl.anchorSlot] ? 'held' : 'free'}`);
  if (!core.dead || !wing.dead) { console.error('the half outlived its head'); process.exit(1); }
  if (sim.slots[core.tpl.anchorSlot]) { console.error('the anchor slot was never freed'); process.exit(1); }
  if (sim.score === before || !sim.drops.length) { console.error('no score or no prize'); process.exit(1); }
  if (!boom) { console.error('no death explosion of its own'); process.exit(1); }
}

// 8. Every level ends with one, and they get more elaborate: level 4's is a
//    single head, level 2's is a core with three wings and seven of them, and
//    two of level 7's carry 65535 hit points because they are not meant to die.
{
  const problems = [];
  for (let n = 1; n <= 8; n++) {
    const url = new URL(`../public/data/level${n}.json`, import.meta.url);
    if (!existsSync(url)) continue;
    const d = JSON.parse(readFileSync(url));
    const ids = d.level.events.filter(([, g]) => (d.templates[g] || {}).type >= 33).map(([, g]) => g);
    const sim = new Sim(d);
    for (const g of ids) sim.spawn(g);
    const cores = sim.entities.filter(e => e.tpl.type === 33);
    const heads = sim.entities.filter(e => e.tpl.type === 35);
    const orphans = sim.entities.filter(e => e.tpl.type !== 33 && !e.parent).length;
    let volleys = 0;
    const spit = sim.bossSpit.bind(sim);
    sim.bossSpit = (e, f) => { volleys++; spit(e, f); };
    for (let t = 0; t < 400; t++) sim.step();
    // Killing every head that can be killed has to bring every core down.
    const mortal = heads.filter(h => h.tpl.hp < 60000);
    for (const h of mortal) h.decay = 99999;
    for (let t = 0; t < 200; t++) sim.step();
    const standing = cores.filter(c => !c.dead).length;
    console.log(`  L${n}: ${cores.length} cores, ${heads.length} heads ` +
                `(${heads.length - mortal.length} indestructible), ${volleys} volleys ` +
                `-> ${standing} cores standing, +${sim.score} points`);
    if (orphans) problems.push(`L${n}: ${orphans} parts never found a core`);
    if (standing) problems.push(`L${n}: ${standing} cores outlived their heads`);
  }
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
}

console.log('all checks passed');
