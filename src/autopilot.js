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
function traj(sim, dx, n, hold = n) {
  const p = sim.player, P = sim.data.player;
  let x = p.x / FP, vx = p.vx / FP;
  const a = P.accel, m = p.maxSpeed;
  const out = new Float64Array(n + 1);
  out[0] = x;
  for (let i = 1; i <= n; i++) {
    const d = i <= hold ? dx : 0;
    if (d) vx = Math.max(-m, Math.min(m, vx + a * d));
    else vx += vx > 0 ? -Math.min(a, vx) : Math.min(a, -vx);
    x = Math.max(P.minX, Math.min(P.maxX, x + vx));
    out[i] = x;
  }
  return out;
}

/**
 * The moves the bot chooses between.
 *
 * Not three -- hold left, hold right, let go -- but nine: each direction held
 * for a while and then released. On the ship this was written for, one pixel a
 * tick and half a pixel of acceleration, the difference hardly exists: it stops
 * in two ticks, so "hold" and "hold then coast" arrive in much the same place
 * and re-deciding every tick is a good enough brake.
 *
 * At three pixels a tick it is the whole game. Acceleration does not scale with
 * the top speed, so a fast ship still takes six ticks to stop and covers nine
 * pixels doing it; a controller whose only plan is "keep going" sails past the
 * column it is trying to reach, turns round, and sails past it again. From the
 * outside that reads as caution -- fewer deaths, fewer kills, less of the level
 * -- and it is really a ship that cannot park. Letting a plan say *when to stop
 * pushing* is what makes speed worth having, and it is what a player's thumb
 * does without being told.
 */
const PLANS = [[0, 0], [-1, 5], [-1, 12], [-1, 26], [-1, 90],
                       [1, 5], [1, 12], [1, 26], [1, 90]];

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
  let t = 0, graze = 0;
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
    if (near <= 0) t += weight * urgency;
    else graze += weight * urgency * (1 - near / 14);
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
  // Near misses are a tie-breaker and are capped like one. Uncapped they add
  // up: ten things passing within fourteen pixels outscored a firing solution,
  // and the faster the ship the more often the three candidates differ on them,
  // so a ship that could dodge more simply dodged more -- fewer deaths, fewer
  // kills, less of the level. Flinching is not free.
  return t + Math.min(0.25, graze);
}

/**
 * What is falling, and what it is worth catching -- gathered once a tick.
 *
 * Not everything on the way down is a prize. " SIDE SPEED DOWN " and the
 * confiscator are worth *dodging*, and a pickup with nothing left to give is
 * worth the fifty credits the shop pays for it and no detour. `Sim.spare` is
 * the same test the shop greys an item out with, so the bot wants exactly what
 * a player would want at that moment: ammo when the magazine has room, a gun
 * when it is not already at its cap.
 */
const WORTH = {
  weapon: 1, extraLife: 1, repair: 0.9, ammo: 0.85, sideUp: 0.8,
  megablast: 0.5, paralyser: 0.5, boost: 0.5, marker: 0.55,
  creditDouble: 0.4, credits: 0.3, randomizer: 0.1,
  sideDown: -1, weaponReset: -1,
};

/**
 * Where each gun sits on the ladder, counted along the `prev` links the data
 * already carries: cannon 0, phaser 1, blaster 2, annihilator 3, trident 4.
 */
function rungs(P) {
  if (P.rung) return P.rung;
  const rung = {};
  for (const key of Object.keys(P.weapons)) {
    let id = Number(key), n = 0;
    while (n < 8) {
      const prev = P.weapons[id] && P.weapons[id].prev;
      if (!prev || prev === id || !P.weapons[prev]) break;
      id = prev; n++;
    }
    rung[key] = n;
  }
  return (P.rung = rung);
}

function prizes(sim) {
  const P = sim.data.player;
  const out = [];
  for (const d of sim.drops) {
    if (d.dead) continue;
    const f = sim.frameOf(d.sprite);
    if (!f) continue;
    const effect = P.effects[d.item];
    let worth = WORTH[effect] ?? 0.3;
    // A gun is only a prize if it is not a demotion. `Player.equip` replaces
    // the gun outright when the id differs -- damage back to the template's,
    // magazine back to two volleys -- so a cannon picked up while holding a
    // maxed annihilator throws the whole run away. It happened on screen, and
    // it is worth avoiding as hard as the confiscator, which is the same event
    // by another name.
    if (effect === 'weapon') {
      const id = P.weaponOf[d.item], p = sim.player;
      const rung = rungs(P);
      if (p.weapon === id) worth = 0.9;               // another boost for this one
      else if ((rung[id] ?? 0) > (rung[p.weapon] ?? 0)) worth = 1;
      else worth = -1;
    }
    // Nothing left to give: the port pays 50 credits for it, which is worth
    // having and not worth crossing the screen for.
    if (worth > 0 && sim.spare(d.item)) worth = 0.25;
    // An empty gun wants ammo more than it wants anything else on the field.
    if (effect === 'ammo' && sim.player.gun &&
        sim.player.ammo < sim.player.gun.barrels.length * 2) worth = 1.2;
    out.push({
      x: d.x / FP, y: d.y / FP, w: f.w, h: f.h, hp: Math.max(1, d.hp ?? 80),
      vx: (d.vx ?? 0) / FP, vy: Math.max(0.2, (d.vy ?? 0) / FP), worth,
    });
  }
  return out;
}

/**
 * How much the ship wants to be at `x`: under something worth catching, and
 * out from under something that is not.
 *
 * Going for the prizes is most of what a real run does -- WEAPON BOOST is where
 * the magazine comes from -- and it is most of what a demo is *for*: a bot that
 * flies past the thing the level just dropped does not look like someone
 * playing. Weighted by how soon it lands, so a prize about to leave the screen
 * pulls harder than one that just dropped.
 */
function want(sim, x, przs) {
  const py = sim.player.y / FP;
  let best = 0;
  for (const d of przs) {
    const dy = py - d.y;
    if (dy < -20) continue;                           // already past us
    const ticks = dy / d.vy;
    const cross = d.x + d.w / 2 + d.vx * ticks;
    const gap = Math.abs(cross - (x + SHIP_W / 2));
    const reach = 1 - Math.min(1, gap / 70);
    const pull = d.worth * reach * (ticks < 200 ? 1 : 0.4);
    // A bad pickup is a thing to be elsewhere for, and the nearer the ship is
    // to catching it the worse the place is.
    best = d.worth < 0 ? Math.min(best, pull) : Math.max(best, pull);
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
 * Is a volley from `x` about to break a prize the ship is on its way to catch?
 *
 * The player's own bullets damage a pickup like anything else -- `Sim.step`
 * runs them through the same collision -- so the gun that clears the wave is
 * also the gun that shoots away what the wave dropped, and the ship has to be
 * directly under a drop to catch it, which is exactly where its own shots go.
 * Someone playing stops firing for a moment and takes the prize.
 *
 * A moment, and no more. Pricing every crossing on the field as a lost prize
 * was tried both ways -- as a cost set against the kill, and as a term in the
 * steering -- and both were expensive for nothing. Drops fall from where the
 * next target is, so nearly every shot on the field crosses one and the gun
 * goes quiet; and in the steering it fought `want` directly, since the place to
 * catch a prize is the place its shots cross it, so the ship did neither.
 *
 * This asks a much narrower question: low on the screen, in this ship's own
 * column, arriving within half a second. That is the prize an onlooker watches
 * get shot away, and pausing for it costs a few ticks of fire.
 */
function wouldBreakPrize(sim, x, gun, przs) {
  if (!przs.length) return false;
  const [mx, my] = sim.data.player.muzzle;
  const py = sim.player.y / FP;
  for (const b of gun.barrels) {
    const sx = x + mx + b.dx, sy = py + my + b.dy;
    const f = sim.frameOf(b.frm);
    const sw = f ? f.w : 4;
    for (const d of przs) {
      if (d.worth < 0.5) continue;                    // not worth a pause
      if (py - d.y > 110) continue;                   // nobody's prize yet
      const rel = b.vy - d.vy;
      if (rel >= -0.01) continue;
      const tt = (d.y + d.h / 2 - sy) / rel;
      if (tt < 0 || tt > 26) continue;
      const shotX = sx + b.vx * tt + sw / 2;
      const dx = d.x + d.vx * tt + d.w / 2;
      if (Math.abs(shotX - dx) <= (d.w + sw) / 2) return true;
    }
  }
  return false;
}


/**
 * How much closer to a shot the ship would be at `x` -- measured per barrel.
 *
 * The exact hit test answers only inside the ship's reach: the trajectory runs
 * ninety ticks, which at a top speed of one pixel a tick is seventy pixels, so
 * a fly three hundred pixels away scores zero from every direction and the ship
 * stands there. This is the long-range half, and it is weapon-aware on purpose.
 *
 * Not the distance to the target -- the distance to the place from which *this
 * gun* would hit it. An annihilator throws four barrels nine pixels either side
 * of the hull and lands something from almost anywhere it stands; a phaser has
 * two and a cannon one, straight ahead, and has to be under the thing. Pulling
 * both toward the target's centre told the cannon that being roughly nearby was
 * as good as being lined up, so it drifted around the middle of the field
 * firing at nothing: it starved at 16% where the annihilator starved at 61%,
 * which is not a gun that cannot keep up -- it is a gun that never shoots.
 *
 * So each barrel is solved for the ship position that would put its shot on the
 * target when it arrives, and the pull is toward the nearest of those. A wide
 * gun gets four answers and is near one of them already; a narrow gun gets one,
 * and is told at any distance exactly where to be.
 */
function approach(sim, x, gun, tgts) {
  const [mx, my] = sim.data.player.muzzle;
  const py = sim.player.y / FP;
  let best = 0;
  for (const t of tgts) {
    for (const b of gun.barrels) {
      const rel = b.vy - t.vy;
      if (rel >= -0.01) continue;
      const f = sim.frameOf(b.frm);
      const sw = f ? f.w : 4;
      const tt = (t.y + t.h / 2 - (py + my + b.dy)) / rel;
      if (tt < 0 || tt > 200) continue;
      // where the ship has to be for this barrel's shot to arrive on the target
      const spot = t.x + t.vx * tt + t.w / 2 - (mx + b.dx + b.vx * tt + sw / 2);
      best = Math.max(best, t.urgent * (1 - Math.min(1, Math.abs(x - spot) / 300)));
    }
  }
  return best;
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
  const przs = prizes(sim);
  // Everything the ship *wants* is a question about distance, and every horizon
  // below was written in ticks with a ship that moves one pixel in one of them.
  // At three pixels a tick the same numbers ask about the far side of the
  // screen: ninety ticks is two hundred and seventy pixels, so all three
  // candidates ended up pinned against a wall and scored the same. That, and
  // not the game, is why a faster ship measured *worse* at everything --
  // fewer kills, less of the level, and fewer deaths, which is the signature of
  // a bot that has stopped engaging rather than one that is struggling.
  //
  // So the wanting is paced: the samples stay at the same *distances* whatever
  // the ship's top speed. Dodging is left in ticks, because a bullet arrives
  // when it arrives.
  const pace = Math.max(1, sim.player.maxSpeed);
  const scores = [];
  for (const [dx, hold] of PLANS) {
    const xs = traj(sim, dx, HORIZON, hold);
    const at = (k) => xs[Math.max(1, Math.round(k / pace))];
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
      value = Math.max(value, volleyValue(sim, at(k), gun, tgts) * (1 - k / 150));
    // A hit taken is worth far more than a volley landed, and not by a little:
    // it costs a life, a rung of the weapon ladder and half a unit of speed,
    // and the speed never comes back. Eight volleys is the exchange rate, and
    // a bot that will not take that trade is a bot that lives.
    scores.push(value
              + approach(sim, at(HORIZON), gun, tgts) * 0.45
              + want(sim, at(14), przs) * 1.8
              - threat(sim, xs) * 8);
  }

  // Commitment, because the scores are recomputed from scratch seventy times a
  // second and two of them are usually within a hair of each other. Taking the
  // best one every tick reads as a twitch -- the ship shivers between left and
  // right while standing still, which no human hand does and which was the
  // first thing anyone said about watching it play. So a new direction has to
  // be *better* than the one being held, by a margin that is wide while the
  // current one is fresh and narrows as it goes stale. Precision costs a
  // little; it is a trade worth making for a ship that looks steered.
  const st = sim.bot || (sim.bot = { dx: 0, at: -99 });
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  const bestDx = PLANS[best][0];
  // What the plan in hand is worth now: the best of the plans that start by
  // pushing the way the ship is already pushing.
  let held = -Infinity;
  for (let i = 0; i < scores.length; i++)
    if (PLANS[i][0] === st.dx) held = Math.max(held, scores[i]);
  // Paced as well: six ticks of the wrong direction is six pixels on the ship
  // this was tuned on and eighteen on a fast one, and eighteen plus the room it
  // then needs to stop is most of a fly. Commitment should be a distance held,
  // not a time held.
  const fresh = sim.tick - st.at < Math.max(2, Math.round(6 / pace));
  if (bestDx !== st.dx && scores[best] - held > (fresh ? 0.3 : 0.07)) {
    st.dx = bestDx;
    st.at = sim.tick;
  }

  const p = sim.player;
  // A round is only free when the magazine is full: `sub_3641` hands one back
  // when a shot dies, so a round spent on empty sky is a round that is not
  // there for the next thing that matters.
  // What the volley would break is a question for the trigger, never for the
  // steering: the place the ship wants to be to *catch* a prize is exactly the
  // place its own shots cross it, so subtracting the one from the other left
  // `want` pulling the ship under a drop and the risk pushing it back out, and
  // the two cancelled into a ship that did neither.
  const spare = p.ammo >= gun.mag - gun.barrels.length;
  const here = volleyValue(sim, p.x / FP, gun, tgts);
  // A full magazine is a reason to fire at what the prediction is not sure of,
  // not a reason to fire at the sky. Something has to be overhead: firing
  // across an empty screen at a fly three hundred pixels away is not a shot a
  // player would take, and it is the first thing that looks wrong watching it.
  const overhead = tgts.some(
    t => Math.abs(t.x + t.w / 2 - (p.x / FP + SHIP_W / 2)) < 80);
  // And a barrel that is lined up *now* fires, whatever the prediction thinks.
  // The prediction flies the target in a straight line, and these things are on
  // curved paths: over the eighty ticks a shot takes to cross the screen the
  // extrapolation is a guess, and demanding it agree is how a one-barrel gun
  // ends up holding its fire with a fly directly overhead. A player shoots when
  // it looks lined up and accepts missing some.
  const [mx] = sim.data.player.muzzle;
  // Kept honest by the magazine: a speculative shot is only worth it with two
  // volleys still in hand. Without that the blaster's three barrels fired at
  // everything that looked close and it starved at 82%, up from 42%.
  const loaded = p.ammo >= gun.barrels.length * 2;
  const lined = loaded && tgts.some(t => gun.barrels.some(b => {
    const f = sim.frameOf(b.frm);
    return Math.abs(t.x + t.w / 2 - (p.x / FP + mx + b.dx + (f ? f.w : 4) / 2))
           <= t.w / 2 + 10;
  }));
  const fire = (here > 0 || lined || (spare && overhead)) &&
               !wouldBreakPrize(sim, p.x / FP, gun, przs);
  return { dx: st.dx, fire };
}

export { decide, traj, threat, want, targets, volleyValue, HORIZON };
