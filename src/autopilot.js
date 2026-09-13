/**
 * The bot pilot's brain: one function that turns the state of a running
 * simulation into the input a player would have given it this tick.
 *
 * It lives here rather than in the harness that measures weapons because the
 * game itself runs it too -- `?demo=1` hands the ship to this file -- and a bot
 * that plays a different game from the one it is measured in is worth nothing.
 * Nothing in here touches the DOM, the renderer or the clock: it reads a `Sim`
 * and returns `{ dx, fire }`.
 *
 * It plays each weapon the way a player who had learned that weapon would,
 * which means it knows its own barrels. Three things it does:
 *
 *   * **It works out whether a volley would actually connect**, by flying each
 *     barrel's shot -- its own dx, vx, vy -- against every enemy's box and
 *     solving for the tick their rows meet. Either the shot arrives inside the
 *     silhouette or it does not.
 *
 *   * **It holds fire.** A round only comes back when its shot hits or leaves
 *     the screen, so firing at nothing is the most expensive thing in the game.
 *     It shoots when a shot would land, or when the magazine is full enough
 *     that a wasted round costs nothing.
 *
 *   * **It dodges what would actually hit it.** For each direction it could
 *     hold, the ship's own trajectory is walked ninety ticks out, and every
 *     enemy shot is solved for the tick it reaches the ship's row -- then
 *     compared against where the ship will be *at that tick*.
 */
const FP = 65536;
const SHIP_W = 26, SHIP_H = 30;

/**
 * Where the ship will be, tick by tick, if it holds `dx` from here.
 *
 * The whole dodge rests on this: at half a pixel of acceleration and a top
 * speed of one, a ship that starts moving now arrives somewhere in about a
 * second, and a bullet fired now arrives in about the same time. Asking "would
 * this hit me where I am going to be" needs both, so the trajectory is walked
 * once a tick, with the real physics, and everything else reads off it.
 */
function traj(sim, dx, n) {
  const p = sim.player, P = sim.data.player;
  let x = p.x / FP, vx = p.vx / FP;
  const a = P.accel, m = p.maxSpeed;
  const out = new Float64Array(n + 1);
  out[0] = x;
  for (let i = 1; i <= n; i++) {
    if (dx) vx = Math.max(-m, Math.min(m, vx + a * dx));
    else vx += vx > 0 ? -Math.min(a, vx) : Math.min(a, -vx);
    x = Math.max(P.minX, Math.min(P.maxX, x + vx));
    out[i] = x;
  }
  return out;
}

const HORIZON = 90;

/**
 * How badly the ship wants *not* to fly the trajectory `xs`.
 *
 * Not a smooth field of nearby danger: for each enemy shot the tick it reaches
 * the ship's row is solved for, and the ship's own position *at that tick* is
 * read off the trajectory. Either the two boxes overlap there or they do not.
 * Something that will cross the ship's row thirty pixels away is not a threat
 * and dodging it is how a pilot backs into the one that would have hit.
 *
 * A margin outside the box still counts, falling off to nothing, because the
 * search needs to know which way is safer before the answer flips -- but it is
 * worth a tenth of a hit, not most of one. Bodies are handled the same way and
 * matter less: the bot is killed by bullets about fifteen times as often.
 */
function threat(sim, xs) {
  const p = sim.player;
  const py = p.y / FP;
  let t = 0;
  /**
   * One thing falling at the ship, in expected hits.
   *
   * Not one crossing but the whole overlap: the ship is thirty pixels tall and
   * a shot at four pixels a tick is level with it for seven of them, during
   * which the ship moves as far as it accelerates. Testing the single tick the
   * shot passes the ship's top row is how a dodge that started too late still
   * scored as clean -- so the pass is walked, and if the two boxes overlap at
   * any tick of it, that is a hit.
   */
  const sweep = (x0, vx, w, tEnter, tLeave, weight) => {
    if (tLeave < 0 || tEnter > HORIZON) return;
    const from = Math.max(0, Math.floor(tEnter));
    const to = Math.min(HORIZON, Math.ceil(tLeave));
    const hw = (SHIP_W + w) / 2;
    let near = Infinity;
    for (let k = from; k <= to; k++) {
      const at = xs[k] + SHIP_W / 2;
      const d = Math.abs(x0 + vx * k + w / 2 - at) - hw;
      if (d < near) near = d;
      if (near <= 0) break;
    }
    if (near > 14) return;
    // Soon is worse: there is no room left to answer it.
    const urgency = 1 / (1 + Math.max(0, tEnter) / 25);
    // A hit is one hit. Anything that only comes close is worth a fiftieth of
    // one: enough to break a tie towards the safer side, and no more. It was a
    // tenth, and a tenth is not a tie-breaker -- a hit is priced at eight
    // volleys, so a near miss was vetoing four fifths of a volley, and the ship
    // would sit with a firing solution in front of it refusing to take it
    // because something was going to pass fourteen pixels away.
    t += weight * urgency * (near <= 0 ? 1 : 0.02 * (1 - near / 14));
  };
  for (const b of sim.enemyShots) {
    if (b.dead) continue;
    const vy = b.vy / FP;
    if (vy <= 0.01) continue;
    const f = sim.frameOf(b.sprite);
    const bw = f ? f.w : 4, bh = f ? f.h : 4;
    const by = b.y / FP;
    sweep(b.x / FP, b.vx / FP, bw, (py - bh - by) / vy, (py + SHIP_H - by) / vy, 1);
  }
  for (const e of sim.entities) {
    if (e.dead || e.exploding || !e.tpl.drawn) continue;
    if (!(e.tpl.layer & 0x40)) continue;              // not a body that hurts
    const f = sim.frameOf(sim.spriteOf(e)) || sim.frameOf(e.tpl.sprite);
    if (!f) continue;
    const vy = (e.y - e.py) / FP;
    if (vy <= 0.01) continue;
    const ey = e.y / FP;
    sweep(e.x / FP, (e.x - e.px) / FP, f.w,
          (py - f.h - ey) / vy, (py + SHIP_H - ey) / vy, 1);
  }
  // the walls: being pinned in a corner is how a dodge runs out of room
  const P = sim.data.player, x = xs[xs.length - 1];
  t += Math.max(0, 26 - (x - P.minX)) * 0.004;
  t += Math.max(0, 26 - (P.maxX - x)) * 0.004;
  return t;
}

/**
 * How much the ship wants to be at `x` to *catch* something.
 *
 * A falling prize is worth going for, and going for them is most of what a real
 * run does: WEAPON BOOST is where the magazine comes from, and without chasing
 * them the bot starves at ninety per cent and no weapon can be told from any
 * other. Weighted by how soon it lands, so a prize about to leave the screen
 * pulls harder than one that just dropped.
 */
function want(sim, x) {
  const p = sim.player;
  const py = p.y / FP;
  let best = 0;
  for (const d of sim.drops) {
    if (d.dead) continue;
    const dy = py - d.y / FP;
    if (dy < -20) continue;                           // already past us
    const vy = Math.max(0.2, (d.vy ?? 0) / FP);
    const ticks = dy / vy;
    const cross = d.x / FP + ((d.vx ?? 0) / FP) * ticks;
    const gap = Math.abs(cross - (x + SHIP_W / 2));
    const reach = 1 - Math.min(1, gap / 70);
    best = Math.max(best, reach * (ticks < 200 ? 1 : 0.4));
  }
  return best;
}

/**
 * The live enemies worth shooting at, with their boxes and drift, gathered once
 * a tick rather than once per candidate position.
 */
function targets(sim) {
  const out = [];
  const py = sim.player.y / FP;
  for (const e of sim.entities) {
    if (e.dead || e.exploding || !e.tpl.drawn) continue;
    if (!(e.tpl.layer & 0x40)) continue;
    const f = sim.frameOf(sim.spriteOf(e));
    if (!f) continue;
    const ey = e.y / FP;
    if (ey > py - 12) continue;                       // level with us or below
    out.push({
      x: e.x / FP, y: ey, w: f.w, h: f.h,
      vx: (e.x - e.px) / FP, vy: (e.y - e.py) / FP,
      hp: Math.max(1, e.hp),
      // something diving at us is worth killing before something loitering
      urgent: (e.y - e.py) > 0 ? 1.6 : 1,
    });
  }
  return out;
}

/**
 * What a volley fired from `x` would be worth.
 *
 * Each barrel's shot is flown at its own velocity until its row meets the
 * target's, and the two are compared there. Solved rather than stepped: at four
 * barrels and forty enemies, three candidate positions a tick, stepping would
 * be tens of millions of operations a run for an answer that is one division.
 */
function volleyValue(sim, x, gun, tgts) {
  const p = sim.player;
  const [mx, my] = sim.data.player.muzzle;
  const py = p.y / FP;
  const dmg = p.damage;
  for (const t of tgts) t.hits = 0;
  // Counted in *volleys landed* rather than points of damage, so that what the
  // gun is worth and what a hit taken costs are in the same units and the
  // weights in `decide` mean something. A trident volley is 56 points and a
  // cannon's is 11; scoring raw damage made the same weight a different
  // instruction for each gun -- and made every gun's shooting drown out its
  // dodging, which is exactly how this bot used to fly into things.
  const volley = dmg * gun.barrels.length;
  let value = 0;
  for (const b of gun.barrels) {
    const sx = x + mx + b.dx, sy = py + my + b.dy;
    const f = sim.frameOf(b.frm);
    const sw = f ? f.w : 4;
    for (const t of tgts) {
      // the tick their rows meet: shot travels vy, target vy
      const rel = b.vy - t.vy;
      if (rel >= -0.01) continue;                     // never closes
      const tt = (t.y + t.h / 2 - sy) / rel;
      if (tt < 0 || tt > 140) continue;
      const shotX = sx + b.vx * tt + sw / 2;
      const tx = t.x + t.vx * tt + t.w / 2;
      if (Math.abs(shotX - tx) > (t.w + sw) / 2) continue;
      // Damage that lands, not shots that arrive: a fourth barrel into a target
      // with ten points left is a wasted round. Overkill is worth nothing, and
      // the round it cost is worth something.
      const done = t.hits * dmg;
      if (done >= t.hp) continue;
      t.hits++;
      const landed = Math.min(dmg, t.hp - done);
      // A near target is worth more than a far one, and not only because it is
      // more dangerous: the round comes back sooner. `sub_3641` returns a round
      // when its shot dies, so the magazine is really a budget of *shot-ticks*,
      // and a shot fired at the top of the screen ties up its round for the
      // length of the screen. Firing at what is close is how the gun stays fed.
      value += t.urgent * (landed / volley) / (1 + tt / 30);
      // And finishing something is worth more than wounding two things. Waves
      // in this game reinforce -- `sub_3b34` adds a member every 560 ticks once
      // the interval has wound down -- so damage spread thin is damage that the
      // level simply grows back. Killing is the only thing that counts.
      if (t.hits * dmg >= t.hp) value += t.urgent * 0.6 / gun.barrels.length / (1 + tt / 30);
    }
  }
  return value;
}


/**
 * Left, nothing or right -- and whether to pull the trigger.
 *
 * Each direction is judged at two horizons, near and far, because a dodge that
 * looks safe in ten ticks and fatal in thirty is not a dodge. The trigger is a
 * separate question: a volley that would hit is always worth firing, and one
 * that would not is worth it only when the magazine is full enough that the
 * round is not missed.
 */
function decide(sim, gun) {
  const tgts = targets(sim);
  let bestDx = 0, bestScore = -Infinity;
  for (const dx of [-1, 0, 1]) {
    const xs = traj(sim, dx, HORIZON);
    // A firing solution anywhere along the trajectory, not only at the near end
    // of it. An exact hit test has no gradient: a target sixty pixels away is
    // worth exactly zero from here and also exactly zero nine pixels closer, so
    // scoring one position told the ship that going after it gained nothing,
    // and it sat in the middle of the screen with a full magazine while the
    // wave it was supposed to clear circled out of reach. Looking down the
    // whole trajectory is what makes closing the distance worth something.
    // Discounted with distance in time, so a shot available now still beats one
    // available in a second and a half.
    let value = 0;
    for (const k of [8, 22, 40, 62, 88])
      value = Math.max(value, volleyValue(sim, xs[k], gun, tgts) * (1 - k / 150));
    // A hit taken is worth far more than a volley landed, and not by a little:
    // it costs a life, a rung of the weapon ladder and half a unit of speed,
    // and the speed never comes back. Eight volleys is the exchange rate, and
    // a bot that will not take that trade is a bot that lives.
    const s = value
            + want(sim, xs[14]) * 0.5
            - threat(sim, xs) * 8;
    if (s > bestScore) { bestScore = s; bestDx = dx; }
  }
  const p = sim.player;
  // A round is only free when the magazine is full: `sub_3641` hands one back
  // when a shot dies, so a round spent on empty sky is a round that is not
  // there for the next thing that matters.
  const spare = p.ammo >= gun.mag - gun.barrels.length;
  const fire = spare || volleyValue(sim, p.x / FP, gun, tgts) > 0;
  return { dx: bestDx, fire };
}

export { decide, traj, threat, want, targets, volleyValue, HORIZON };
