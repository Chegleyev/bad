/**
 * The simulation. Deliberately a transcription, not an interpretation.
 *
 * Positions and velocities are 16.16 fixed point held in integers, and motion
 * is `sub_2b34` from the original, which is four instructions: decrement the
 * ticks left in the current flight-path segment and, while it lasts, add the
 * segment's vx and vy. One detail worth keeping: on the tick a segment expires
 * the entity advances to the next segment and does *not* move. That stall is in
 * the original, so it is here.
 */
import { hit, pairs, exact, overlap } from './collide.js';

const FP = 65536;
// How far " SIDE SPEED UP " may take the ship, as a multiple of its starting
// speed. `sub_1e8b` has no ceiling at all -- every one adds half a pixel a tick
// for ever -- and a long enough run ends with a ship that crosses the field
// faster than it can be aimed. Four is where it stops being a ship and starts
// being a cursor. A departure from the original, and a deliberate one.
const SPEED_CAP = 4;
/**
 * How much a homing missile sinks each tick, on top of its heading.
 *
 * Not the original's -- `sub_37f9` is thirteen instructions of move-and-steer
 * and has no such term, and nothing else in the object does either. It is here
 * because of what the numbers say about the level 5 boss, which has two guns.
 *
 * Searched over 3 351 dodge plans, counting the share that survive. Without it,
 * one missile at base speed: 18%. Two, the second sixty ticks later: 11% -- and
 * at twice the speed, still 12%. That is the problem. A missile that levels out
 * at the ship's altitude flies along the rail at three pixels a tick, and a ship
 * that manages one or two cannot leave the rail at all, so going faster buys
 * nothing.
 *
 * With the sink the boss stays hard where the ship is slow and speed starts to
 * pay, which is what the half unit `sub_327a` takes off you for dying is
 * supposed to mean. Averaged over twelve launch geometries, the share of plans
 * that survive:
 *
 *     sink    speed 1   speed 2   speed 3.5
 *     0.200     21.3%     30.2%       32.4%
 *     0.225     24.1%     34.8%       36.9%
 *     0.250     25.7%     35.5%       37.4%
 *
 * The response is a step rather than a ramp -- 0.200 through 0.220 are within a
 * point of each other and 0.225 jumps -- so this is not a dial to turn finely.
 * What it does *not* change is how long a missile lasts: one chasing a fleeing
 * ship leaves through the side of the screen rather than the bottom, at 158
 * ticks for 0.15, 0.2 and 0.25 alike. The sink buys room, not time.
 */
const MISSILE_SINK = 0.225;

export class Entity {
  constructor(tpl, gid, x, y) {
    this.tpl = tpl; this.gid = gid;
    this.x = Math.round(x * FP); this.y = Math.round(y * FP);
    this.px = this.x; this.py = this.y;      // previous tick, for interpolation
    this.hp = tpl.hp || 0;
    this.decay = 0;
    this.frame = 0;
    this.seg = 0; this.segTicks = -1;        // forces the first advance
    this.vx = 0; this.vy = 0;
    this.pathDone = false;
    this.exploding = false;
    this.animTimer = 3;
    this.inSlot = false;
    this.diving = false;
    this.idleTimer = 3;
    this.diveTimer = 1;
    this.fireTimer = 0;
    this.dead = false;
    // The boss. A type 34 or 35 is pinned to the type 33 that registered in the
    // anchor slot its template names; the core itself carries the little VM.
    this.parent = null; this.ox = 0; this.oy = 0;
    this.animTo = 0;
  }
}

/**
 * The player ship.
 *
 * The original's handler is mostly input plumbing (it reads a device through a
 * vtable and dispatches on direction bits), and that part is replaced. What is
 * transcribed is the feel: a velocity accumulator changed by `accel` each tick
 * and clamped to `maxSpeed`, x clamped to [-9, 305] -- the two literals at
 * 0x2f92 and 0x2fa1 -- and the banking animation stepping one frame every third
 * tick between the ends of the tilt strip.
 */
export class Player {
  constructor(cfg) {
    this.cfg = cfg;
    this.x = Math.round(cfg.x * FP); this.y = Math.round(cfg.y * FP);
    this.px = this.x; this.py = this.y;
    this.vx = 0; this.vy = 0;
    this.frame = cfg.tiltMid;
    this.tiltTimer = cfg.tiltEvery;
    this.cool = 0;
    this.deaths = 0;
    // **A deliberate divergence.** The original has no mercy period at all:
    // `sub_327a` restores hit points, drops the gun a rung, resets the reload
    // to 7 and takes half a unit off the side speed, and that is the whole of
    // it. Dying in front of a boss therefore puts you straight back into the
    // same wall of fire. Ticks, counted down in `step`.
    this.invuln = 0;
    this.ammo = 0;
    // The ship's condition. `+0x5c` is hit points and `+0x5e` the damage taken
    // this tick, applied and cleared together each update (`sub_2d75`).
    this.hp = cfg.hp;
    this.maxHp = cfg.maxHp;
    this.decay = 0;
    this.lives = cfg.lives;
    // Completing the six DIGNITY MARKERs promotes you. The set is primed at
    // creation -- `sub_2b88` stages marker 1 against a mask of 0x3e, which the
    // HUD pass immediately completes -- so a fresh ship is rank 1 with an empty
    // mask and owes six markers for the next one.
    this.state = 'fly';          // fly / boostUp / boostDown / dying / wreck / over
    this.animTimer = 3;
    this.rank = 1;
    this.markers = 0;
    this.credits = 0;
    this.maxSpeed = cfg.maxSpeed;      // raised by SIDE SPEED UP, floored at 1.0
    this.fireEvery = cfg.fireEvery;    // lowered by RAPID FIRE, floored at 4
    this.equip(cfg.startWeapon);
  }

  /**
   * Equip a gun (`sub_2121`). The weapon *is* its projectile template: its
   * +0xab/+0xac/+0xad become the player's shot cost, magazine and damage, and
   * the magazine is refilled to two volleys minus whatever is still in flight.
   * Picking up the gun you already hold instead sharpens it -- `sub_21a6` scales
   * its damage by 1.25 a time, capped at twice the template's own.
   */
  equip(id, sim) {
    const w = this.cfg.weapons[id];
    if (!w) return;
    if (this.weapon === id) {
      const cap = w.damage * this.cfg.weaponUpCap;
      if (this.damage < cap)
        this.damage = Math.min(cap, Math.floor(this.damage * this.cfg.weaponUpStep));
      return;
    }
    this.weapon = id;
    this.gun = w;
    this.damage = w.damage;
    this.ammo = Math.max(0, w.cost * 2 - (sim ? sim.inFlight : 0));
  }

  /** The banking strip, one frame every third tick towards where you are going. */
  frameStep(input) {
    const c = this.cfg;
    if (--this.tiltTimer > 0) return;
    this.tiltTimer = c.tiltEvery;
    const want = input.dx < 0 ? c.tiltLeft : input.dx > 0 ? c.tiltRight : c.tiltMid;
    if (this.frame < want) this.frame++;
    else if (this.frame > want) this.frame--;
  }

  /** hp 0..31 -> one of three condition levels, the table at data:0x24a5. */
  get dignity() { return this.cfg.dignity[this.hp & 31]; }

  /** The thruster strip [+0xe4, +0xe8), shared by the boost and both flights. */
  thruster(wrapTo) {
    const c = this.cfg;
    if (--this.animTimer > 0) return;
    this.animTimer = 3;
    if (this.frame < c.boostAnim[0] || ++this.frame >= c.boostAnim[1])
      this.frame = wrapTo;
  }

  /** `sub_268b`: the section is over, fly off the top. */
  leave() {
    if (this.state !== 'fly' && this.state !== 'boostUp' && this.state !== 'boostDown') return;
    this.state = 'leaving';
    this.vy = 0;
    this.frame = this.cfg.leaveFrom;
    this.animTimer = 3;
  }

  /**
   * `sub_258b`: put the ship back below the screen so it can fly in again.
   *
   * **Also from `leaving`,** and that is the whole of a bug that lost the ship
   * for a quarter of the level. The script's `ship_out` and `ship_in` are 215
   * ticks apart at the end of the asteroid belt, and the fly-out takes longer
   * than that -- so `ship_in` arrived while the ship was still climbing, found
   * a state it did not accept, did nothing, and the program walked straight
   * past it. The ship reached `gone` eight ticks later and stayed off the top
   * of the screen through the belt and into the boss fight, alive and
   * unreachable. The original does not check at all: `sub_258b` writes state 23
   * and y = 350 whatever the ship was doing.
   */
  enter() {
    if (this.state !== 'gone' && this.state !== 'leaving') return;
    this.state = 'entering';
    this.x = Math.round(this.cfg.x * FP);
    this.y = Math.round(this.cfg.enter.fromY * FP);
    this.px = this.x; this.py = this.y;
    this.vx = this.vy = 0;
    this.frame = this.cfg.boostAnim[0];
    this.animTimer = 3;
  }

  step(input, sim) {
    if (this.state === 'over' || this.state === 'gone') return;
    if (this.state === 'dying' || this.state === 'wreck') { this.stepDeath(sim); return; }
    this.px = this.x; this.py = this.y;
    if (this.invuln > 0) this.invuln--;
    // `sub_2d75`, and it comes first: the damage banked since the last update
    // is applied in one go and the accumulator cleared. Dying is the borrow.
    if (this.decay) {
      this.hp -= this.decay;
      this.decay = 0;
      if (this.hp < 0) { this.kill(sim); return; }
    }
    const c = this.cfg, A = Math.round(c.accel * FP), M = Math.round(this.maxSpeed * FP);

    // Flying out at the end of a section (state 24, `sub_2c7f`): the ship
    // accelerates upward on its thruster strip and is gone past y = -80.
    if (this.state === 'leaving') {
      this.px = this.x; this.py = this.y;
      this.vy += Math.round(c.leave.accel * FP);
      this.y += this.vy;
      this.thruster(c.boostAnim[0] + 3);
      if (this.y <= c.leave.endY * FP) this.state = 'gone';
      return;
    }
    // And flying back in (state 23, `sub_2c16`): up from y = 350 at a steady
    // 0.25 px a tick until it reaches the home row.
    if (this.state === 'entering') {
      this.px = this.x; this.py = this.y;
      this.y -= Math.round(c.enter.vy * -FP);
      this.thruster(c.boostAnim[0]);
      if (this.y <= c.y * FP) {
        this.y = Math.round(c.y * FP);
        this.state = 'fly';
        this.frame = c.tiltMid;
      }
      return;
    }

    // " ENGINES BOOST " is a hop with two states of its own. Climbing
    // (`sub_2ce1`) the ship does not steer at all -- the handler returns before
    // reaching the normal update -- and falling (`sub_2d33`) it does.
    if (this.state !== 'fly') {
      const B = c.boost;
      if (this.state === 'boostUp') {
        this.vy += Math.round(B.upAccel * FP);
        this.y += this.vy;
        if (this.y <= B.topY * FP) this.state = 'boostDown';
        // Climbing has its own strip, [+0xe4, +0xe8) (`sub_2ce1`).
        if (--this.animTimer <= 0) {
          this.animTimer = 3;
          if (this.frame < c.boostAnim[0] || ++this.frame >= c.boostAnim[1])
            this.frame = c.boostAnim[0];
        }
        return;
      }
      if (this.frame >= c.boostAnim[0] && this.frame < c.boostAnim[1])
        this.frame = c.tiltMid;
      this.vy += Math.round(B.downAccel * FP);
      this.y += this.vy;
      if (this.y >= B.fromY * FP) {
        this.y = Math.round(B.fromY * FP);
        this.vy = 0;
        this.state = 'fly';
      }
    }

    const axes = c.canMoveY ? [['vx', input.dx], ['vy', input.dy]]
                            : [['vx', input.dx]];
    for (const [axis, dir] of axes) {
      let v = this[axis];
      if (dir) v += dir * A;
      else v -= Math.sign(v) * Math.min(Math.abs(v), A);   // coast back to rest
      this[axis] = Math.max(-M, Math.min(M, v));
    }
    this.x = Math.max(c.minX * FP, Math.min(c.maxX * FP, this.x + this.vx));
    this.y = Math.max(c.boost.topY * FP, Math.min(c.boost.fromY * FP, this.y + this.vy));

    this.frameStep(input);

    if (this.cool > 0) this.cool--;
    if (input.fire && this.cool === 0) {
      // Fed with ammo the gun runs at the template's +0x100 = 7 ticks; empty it
      // is sparse. The ammo machinery is the original's (+0xfa rounds, +0xfb
      // cost, +0x108 capacity), the *empty* cadence is a stand-in.
      // A round has to be available *and* the shot takes it out of circulation
      // until it dies. Two rounds at the start, so two shots then a wait.
      // A round in the magazine is one *projectile*, not one trigger pull: the
      // volley costs one per barrel and `sub_3641` hands one back per shot that
      // dies, which is why the shot cost and the barrel count are always equal.
      const g = this.gun;
      if (this.ammo < g.barrels.length) { this.cool = 1; return; }
      this.ammo -= g.barrels.length;
      sim.inFlight += g.barrels.length;
      this.cool = this.fireEvery;
      const [mx, my] = c.muzzle;                     // (+14, -10) from sub_308f
      for (const r of g.barrels) {
        // `sub_35ca` jitters a shot's vx by a random value masked with +0x98,
        // negated when it comes up odd.
        let vx = r.vx;
        if (g.spread) {
          const j = sim.rnd() & g.spread;
          vx += (j & 1 ? -j : j) / FP;
        }
        const shot = new Bullet(this.x + (mx + r.dx) * FP, this.y + (my + r.dy) * FP,
                                r.frm, r.to, vx, r.vy);
        shot.layer = c.bulletLayer; shot.hits = c.bulletHits;
        sim.bullets.push(shot);
      }
      sim.sfx('shot', this.x / FP);          // `sub_2274`: n = 7, period 0x300
    }
  }

  /**
   * Dying, `sub_2d91`: state 21 and the explosion at [+0xd0, +0xd4). The life
   * is not spent here -- it goes when the explosion ends and the wreck starts
   * falling, which is where the original counts it (`sub_319f`).
   */
  kill(sim) {
    if (this.state === 'dying' || this.state === 'wreck' || this.state === 'over') return;
    this.deaths++;
    this.decay = 0;
    this.state = 'dying';
    this.frame = this.cfg.explode[0];
    this.animTimer = 3;
    this.vx = this.vy = 0;
    sim.enemyShots.length = 0;
  }

  /** The death animation and what follows it. -> true while the ship is gone. */
  stepDeath(sim) {
    const c = this.cfg;
    if (--this.animTimer > 0) {
      if (this.state === 'wreck') this.fall();
      return true;
    }
    this.animTimer = 3;
    if (this.state === 'dying') {
      if (++this.frame < c.explode[1]) return true;
      // `sub_319f`: the life goes now, and the wreck takes over.
      this.lives--;
      this.state = 'wreck';
      this.frame = c.wreck[0];
      return true;
    }
    this.fall();
    if (++this.frame >= c.wreck[1]) this.frame = c.wreck[0];
    if (this.y < c.wreckFall.endY * FP) return true;
    this.respawn(sim);
    return this.state === 'over';
  }

  /** `sub_3221`: the wreck tumbles down and drifts right as it goes. */
  fall() {
    this.px = this.x; this.py = this.y;
    this.y += Math.round(this.cfg.wreckFall.vy * FP);
    this.x += Math.round(this.cfg.wreckFall.vx * FP);
  }

  /**
   * `sub_327a`. Hit points back to the cap, and three things taken away: the
   * gun drops one rung down the ladder its +0x94 describes, the reload goes
   * back to 7, and half a unit comes off the side speed -- never below its
   * floor. The original retires the object and the next life arrives as a new
   * one; here the same ship is put back at its start.
   */
  respawn(sim) {
    const c = this.cfg;
    this.hp = this.maxHp;
    this.decay = 0;
    this.invuln = c.invulnTicks || 0;
    const prev = this.gun.prev;
    if (prev) { this.weapon = null; this.equip(prev, sim); }
    else this.ammo = Math.min(this.gun.mag, this.gun.cost * 2);
    this.fireEvery = c.fireEvery;
    if (this.maxSpeed - c.sideStep >= c.sideMin) this.maxSpeed -= c.sideStep;
    if (this.lives <= 0) { this.state = 'over'; return; }
    this.state = 'fly';
    this.frame = c.tiltMid;
    this.x = Math.round(c.x * FP);
    this.y = Math.round(c.y * FP);
    this.px = this.x; this.py = this.y;
    this.vx = this.vy = 0;
    sim.drops.length = 0;
    sim.pod = null;
  }
}

/**
 * The " PARALYSER " companion, `sub_2aa2`: pinned at a fixed offset from the
 * ship, animating on its own, and retired when its +0x68 lifetime runs out. It
 * carries no health of its own -- nothing applies damage to a type 6 -- so it
 * cannot be shot away, it can only expire.
 */
export class Pod {
  constructor(cfg, owner) {
    this.cfg = cfg;
    this.life = cfg.life;
    this.sprite = cfg.anim[0];
    this.animTimer = 3;
    this.layer = cfg.layer; this.hits = cfg.hits;
    this.dead = false;
    this.follow(owner);
    this.px = this.x; this.py = this.y;
  }

  follow(owner) {
    this.px = this.x; this.py = this.y;
    this.x = owner.x + Math.round(this.cfg.off[0] * FP);
    this.y = owner.y + Math.round(this.cfg.off[1] * FP);
  }

  step(owner) {
    if (--this.life <= 0) { this.dead = true; return; }
    this.follow(owner);
    if (--this.animTimer <= 0) {
      this.animTimer = 3;
      if (++this.sprite >= this.cfg.anim[1]) this.sprite = this.cfg.anim[0];
    }
  }
}

/** Drop the dead from a list without replacing the list itself. */
function compact(list) {
  let w = 0;
  for (let r = 0; r < list.length; r++) if (!list[r].dead) list[w++] = list[r];
  list.length = w;
}

/** A shot. `from`..`to` is the animation range, stepped every third tick. */
export class Bullet {
  constructor(x, y, from, to, vx, vy, gravity = 0, animEvery = 3) {
    this.x = x; this.y = y; this.px = x; this.py = y;
    this.from = from; this.to = to; this.sprite = from;
    this.vx = Math.round(vx * FP); this.vy = Math.round(vy * FP);
    this.gravity = Math.round(gravity * FP);
    this.animEvery = animEvery;
    this.animTimer = animEvery; this.dead = false;
    // Its collision layers (+0x48) and interests (+0x4c), filled in by whoever
    // spawns it: a pickup is 0x100/0x0f, an enemy's shot 0x80/0x03.
    this.layer = 0; this.hits = 0;
    this.hp = 0; this.decay = 0; this.exploding = false;
    // Type 17 -- the boss's spit -- flies a path rather than a velocity.
    this.path = null; this.seg = 0; this.segTicks = -1;
    this.pathDone = false;
    this.homing = null; this.launch = null;
  }

  step() {
    this.px = this.x; this.py = this.y;
    if (this.path) {
      // `sub_37c7` hands a type-17 shot to the same four instructions every
      // entity uses, and `sub_37d6` retires it when the path runs out.
      if (--this.segTicks < 0) {
        const next = this.path[this.seg];
        if (!next || next[0] === 0) {
          // `sub_37d6` and `sub_3a05`: a shot whose launch path runs out does
          // not die, it becomes a type 15 and keeps flying. Killing it there is
          // what made level 7's missiles vanish half a second after launch.
          this.path = null;
          this.pathDone = true;
          if (!this.vx && !this.vy) this.dead = true;
          return;
        }
        this.seg++; this.segTicks = next[0];
      } else {
        const rec = this.path[this.seg - 1];
        this.x += Math.round(rec[2] * FP); this.y += Math.round(rec[3] * FP);
      }
      if (--this.animTimer <= 0) {
        this.animTimer = this.animEvery;
        if (++this.sprite >= this.to) this.sprite = this.from;
      }
      const px = this.x / FP, py = this.y / FP;
      if (py < -20 || py > 380 || px < -30 || px > 350) this.dead = true;
      return;
    }
    this.vy += this.gravity;              // pickups accelerate; shots do not
    this.x += this.vx; this.y += this.vy;
    if (--this.animTimer <= 0) {
      this.animTimer = this.animEvery;
      if (++this.sprite >= this.to) this.sprite = this.from;
    }
    const x = this.x / FP, y = this.y / FP;
    if (y < -20 || y > 380 || x < -30 || x > 350) this.dead = true;
  }
}

export class Sim {
  constructor(data) {
    this.data = data;
    this.entities = [];
    this.bullets = [];
    this.tick = 0;
    this.pc = 0;                 // the level program's counter
    // The eight slots types 30/32/35 draw their drop from. Slots 0 and 1 are
    // rewritten every time a marker is taken so they name two you still need.
    this.score = 0;              // [0x3b8 + p*4]; a life every 10 000
    this.progress = 99;          // the HUD percentage the script counts down
    this.markerSlots = data.player.markerDrop.slots.slice();
    this.pod = null;             // the PARALYSER companion, while one is out
    this.msg = null;             // the banner currently scrolling, if any
    this.queued = null;          // the one waiting slot behind it
    this.waitTicks = 0;
    // How long the script is allowed to hold an empty screen: one second. See
    // `runProgram`. `?idle=1000000` puts the original's pacing back.
    this.idleCap = 70;
    this.idle = 0;
    this.nextProp = 0;
    this.prog = data.level.prog;
    this.backdrop = data.level.backdrop;
    this.player = new Player(data.player);
    this.player.equip(data.player.startWeapon, this);
    this.inFlight = 0;           // rounds currently on screen (+0x109)
    this.anchors = {};           // group index -> the type-11 entity
    // [0x22dc]: the anchor registry the script's gates really read. Only the
    // boss cores go in it here -- see `runProgram`.
    this.slots = {};
    this.won = false;            // the program ran off the end: the level is done
    this.cheated = false;        // the run has taken help and stops counting
    this.drops = [];
    this.enemyShots = [];
    this.kills = 0;
    this.picked = 0;
    this.dropped = 0;           // how many were there to pick up
    this.rngState = 12345;
    // Whoever owns the simulation says what the script's music opcodes mean,
    // and what a sound is. Nothing here knows about audio; it only says when
    // something happened and where on the field it happened.
    this.onAudio = null;
    this.onSfx = null;
    this.onPickupSfx = null;
  }

  /**
   * The original's RNG, same shape: an LCG with 1103515245/12345 masked to 31
   * bits (`sub_64ec`), read back as bits 8..15 (`sub_6508`). Taking the *low*
   * bits of an LCG is the classic trap -- they cycle with a tiny period, and a
   * `% 8` on them here produced zero drops from 46 kills.
   */
  rnd() {
    this.rngState = (Math.imul(this.rngState, 1103515245) + 12345) & 0x7fffffff;
    return (this.rngState >> 8) & 0xff;
  }

  /**
   * Roll a pickup where an enemy died.
   *
   * `sub_4191` rolls on one tick in eight and indexes a 256-entry weighted
   * table at data:0x201c. The block it sits in is gated by flags in +0x58, so
   * it does not fire every tick -- a per-tick roll floods the screen. Rolling it
   * on death is the reading that matches both the gate and the item list.
   */
  dropAt(e) {
    const P = this.data.player, M = P.markerDrop;
    let gid;
    if (e.tpl && M.types.includes(e.tpl.type)) {
      // Types 30, 32 and 35 do not roll for a drop -- they always leave one,
      // and it comes from the marker table rather than the weighted one. Bit 1
      // of +0xe would make it a " RANDOMIZER " instead, but nothing sets it.
      gid = (e.tpl.dropRandom ? M.fallback : this.pickMarker()) + P.dropBase;
    } else {
      // `sub_4f5b` rolls `al & 3` for a rock: one in four, not the usual one in
      // eight that `sub_4191` uses for an enemy.
      if (this.rnd() % (e.tpl && e.tpl.type === 14 ? 4 : P.dropChance)) return;
      gid = P.dropTable[this.rnd() % P.dropTable.length];
    }
    const kind = P.dropItems[gid];
    const ef = this.frameOf((e.tpl.animBase || e.tpl.sprite) + e.frame) ||
                 this.frameOf(e.tpl.sprite);
    const sf = kind && this.frameOf(kind.sprite);
    if (!sf || !ef) return;
    const drop = new Bullet(e.x + ((ef.w - sf.w) >> 1) * FP,
                            e.y + ((ef.h - sf.h) >> 1) * FP,
                            kind.anim[0], kind.anim[1], 0, 0,
                            P.dropGravity, P.dropAnimEvery);
    drop.item = kind.item;
    drop.arg = kind.arg;                 // the handler's +0x9c operand
    drop.hp = kind.hp;                   // what it absorbs, and deals back
    drop.explode = kind.explode;
    drop.layer = kind.layer; drop.hits = kind.hits;
    this.drops.push(drop);
    this.dropped++;
  }

  /**
   * Run the level program until it blocks.
   *
   * `wait` counts down ticks; `wait_group` blocks until the wave is gone, which
   * is why a new formation only arrives once you have cleared the last one.
   * All 14 of level 1's gates are "at most 0 left".
   */
  /**
   * Is there anything on the field worth waiting for?
   *
   * Only objects that carry a collision layer count: the parallax backdrop and
   * the formation anchors are always there and are not the level happening.
   */
  quiet() {
    if (this.msg || this.drops.length) return false;
    for (const e of this.entities)
      if (!e.dead && !e.exploding && e.tpl.layer) return false;
    return true;
  }

  runProgram() {
    if (this.waitTicks > 0) {
      this.waitTicks--;
      // **A deliberate divergence.** The original's timeline is full of long
      // dead stretches -- five seconds after every wave, eight at a section
      // change, twenty after the boss dies -- which in 1997 were covered by
      // music fading and the next level loading off a hard disk. Here they are
      // just an empty screen. So a `wait` that is holding *nothing* is cut
      // short after `idleCap` ticks; a wait with enemies on screen, a banner
      // scrolling or a prize still falling is left exactly as written, which is
      // what keeps the asteroid belt's ramp and every formation's shape intact.
      if (!this.quiet()) this.idle = 0;
      else if (++this.idle > this.idleCap) { this.waitTicks = 0; this.idle = 0; }
      return;
    }
    while (this.pc < this.prog.length) {
      const op = this.prog[this.pc];
      if (op[0] === 'w') { this.pc++; this.waitTicks = op[1]; return; }
      if (op[0] === 'g') {
        // `sub_2738` counts nothing at all. It reads [0x22dc + a*4] -- the
        // anchor table -- and blocks while *that object's* +0xaa is above b.
        // For a wave the anchor is the type-11 formation head and its +0xaa is
        // how many members are still flying; for the boss it is the type-33
        // core, whose +0xaa is 1 until its head is shot. The port keeps
        // counting members for the waves, because its formations never lose
        // their anchor and the count is the same answer either way, and reads
        // the registry for everything else -- which is what the level's last
        // two gates, `wait_group 0` and `wait_group 1`, are waiting on.
        const anchor = this.slots[op[1]];
        const alive = anchor ? anchor.alive : this.entities.reduce(
          (n, e) => n + (!e.dead && !e.exploding &&
                         (e.tpl.type === 31 || e.tpl.type === 30) &&
                         e.tpl.group === op[1] ? 1 : 0), 0);
        if (alive > op[2]) {
          if (!this.skipGates) return;                 // hold until the wave is gone
          // A gate an anchor is holding is never skipped. Fast-forwarding is
          // for *reaching* a place in the level, and the two gates at the end
          // of the level are the boss fight: running through them declared the
          // level won with the boss still circling.
          if (anchor) return;
          // Otherwise settle the gate by retiring the wave it waits on, rather
          // than letting every wave in the level pile up at once.
          for (const e of this.entities)
            if (!e.dead && (e.tpl.type === 31 || e.tpl.type === 30) &&
                e.tpl.group === op[1]) e.dead = true;
        }
        this.pc++;
        continue;
      }
      // `sub_268b` / `sub_258b`: the ship leaves at the end of a section and is
      // put back below the screen for the next one. `ship_in` *blocks* -- it
      // branches back to itself until the ship is in play again -- which is
      // what holds the belt off until the fly-in has finished.
      if (op[0] === 'f') { this.player.leave(); this.pc++; continue; }
      if (op[0] === 'i') {
        this.player.enter();
        if (this.player.state === 'entering') return;    // still coming in
        this.pc++;
        continue;
      }
      // The emitter's controls all address the one type-13 object (`[0x2491]`).
      if (op[0] === 'er' || op[0] === 'es' || op[0] === 'ex') {
        const em = this.entities.find(e => !e.dead && e.tpl.emitter);
        if (em) {
          if (op[0] === 'er') { em.density = op[1]; em.period = op[2]; em.emitTimer = op[2]; }
          else if (op[0] === 'es') em.speed = op[1];
          else em.dead = true;                           // `emit_stop` retires it
        }
        this.pc++;
        continue;
      }
      if (op[0] === 's') this.spawn(op[1]);
      // `sub_2924`: the announce opcode hands the string index to the same
      // queue the pickups use, with `ebx = 2` -- the level's own grey ramp.
      if (op[0] === 'm' && op[1] === 'announce')
        this.announce(op[2], this.data.text.scriptColour);
      // `load_soundbank`, `sound_bank`, `play_music`, `music_fade`,
      // `music_stop` and `play_sfx` all come through here.
      if (op[0] === 'm' && this.onAudio && op[1] !== 'announce' && op[1] !== 'progress')
        this.onAudio(op[1], op[2]);
      // `sub_2901`: how far through the section, counted 99 down to 0.
      if (op[0] === 'm' && op[1] === 'progress') this.progress = op[2];
      this.pc++;
    }
    // Off the end of the program: the section is over and the level is won.
    this.won = true;
  }

  /**
   * An enemy that flies off an edge comes back on the other one (`sub_4429`).
   *
   *     cmp ecx, 0xffd00000   ; x <= -48  ->  x = 336
   *     cmp ecx, 0x01580000   ; x >= 344  ->  x = -40
   *     cmp edx, 0xffcc0000   ; y <= -52  ->  y = 360
   *     cmp edx, 0x01720000   ; y >= 370  ->  y = -42
   *
   * The margins are wide on purpose: an enemy enters at x = -19 or y = -40 and
   * must not be teleported on its first tick. This is what makes a path that
   * walks off the screen a *patrol* rather than an exit, and it is the only
   * reason a heavy on a forty-five segment path is ever seen twice.
   */
  wrap(e, w = this.data.wrap) {
    if (!w) return;
    const x = e.x / FP, y = e.y / FP;
    if (x <= w.xMin) e.x = Math.round(w.xTo * FP);
    else if (x >= w.xMax) e.x = Math.round(w.xFrom * FP);
    if (y <= w.yMin) e.y = Math.round(w.yTo * FP);
    else if (y >= w.yMax) e.y = Math.round(w.yFrom * FP);
    // A wrap must not be interpolated, or the sprite streaks across the screen
    // on its way to the far edge -- which is a fly appearing in the middle of
    // the field for one frame and then being fine again.
    if (Math.abs(e.x - e.px) > 100 * FP) e.px = e.x;
    if (Math.abs(e.y - e.py) > 100 * FP) e.py = e.y;
  }

  /**
   * The heavy, type 30 -- and it is `sub_3ba8`, its own entry in the per-type
   * table at data:0x2238, not the generic enemy tick at `sub_4113`.
   *
   * That distinction is the whole of it. Reading the generic tick onto type 30
   * says a heavy joins a formation when its path ends; reading the *anchor's*
   * tick onto it says it repaths out of a bank of four. Both are wrong, and
   * both were tried. What `sub_3ba8` actually does:
   *
   *   * flies its path, and when it runs out takes another out of the bank of
   *     **64 at aux[13] + 0x40** and re-enters the stepper on the spot
   *     (`jmp 0x3da9`), so it never stops and never parks;
   *   * wraps at the edges on its own margins (`sub_3ddc`), which are wider
   *     than the ordinary enemy's -- -80 and 344 across, -80 and 366 down;
   *   * winds up and shoots. The reload, the position gate (it only attacks
   *     from the top 250 rows of the screen) and the roll all decide one
   *     thing: whether to raise the animation's top from the idle end to
   *     +0xa8. The shot is fired by the *animation* reaching that top, not by
   *     the timer -- `sub_3ee7` drops the top back and spawns the shot in the
   *     same breath.
   *
   * Not modelled: the grab. A heavy that rolls to attack while the ship is
   * between y 200 and 220 latches onto it instead and drags it sideways half a
   * pixel a tick (`sub_3d46`), which needs the companion object at +0xe0 and
   * the ship's own struggle animation. Outside that twenty-pixel band the
   * original takes this same branch, so what is here is what happens most of
   * the time.
   */
  stepHeavy(e) {
    const t = e.tpl, f = t.fire;
    if (e.anim === undefined) { e.anim = t.idle[0]; e.animTop = t.idle[1]; }

    // 1. the path, which never runs out
    for (let guard = 0; e.path && guard < 8; guard++) {
      if (--e.segTicks >= 0) {
        const rec = e.path[e.seg - 1];
        if (rec) { e.x += Math.round(rec[2] * FP); e.y += Math.round(rec[3] * FP); }
        break;
      }
      const next = e.path[e.seg];
      if (next && next[0] !== 0) { e.seg++; e.segTicks = next[0]; break; }
      const p = this.data.paths[this.data.roamPaths[this.rnd() & 0x3f]];
      if (!p) { e.segTicks = 0; break; }
      e.path = p; e.seg = 0; e.segTicks = -1;
    }
    this.wrap(e, this.data.heavyWrap);

    // 2. the decision to attack, which only raises the animation's ceiling
    if (f && t.windUp && --e.fireTimer < 0) {
      e.fireTimer = f.every;
      const x = e.x / FP, y = e.y / FP;
      // `ja` on the raw fixed point, so a negative coordinate is above the
      // bound rather than below it: the heavy attacks from on screen only.
      if (y >= 0 && y <= 250 && x >= 0 && x <= 320 && this.rnd() < f.chance)
        e.animTop = t.windUp;
    }

    // 3. the animation, and the shot at the end of the wind-up
    if (--e.idleTimer <= 0) {
      e.idleTimer = 3;
      const s = e.anim + 1;
      if (s < e.animTop) e.anim = s;
      else {
        if (t.idle[1] !== s) { e.animTop = t.idle[1]; this.heavySpit(e); }
        e.anim = t.idle[0];
      }
    }
  }

  /**
   * The heavy's shot (`sub_3ef0`): aimed at the ship, but launched from one of
   * sixteen points on a circle around the heavy rather than from the heavy
   * itself, so a wave of them does not fire down one line.
   */
  heavySpit(e) {
    const f = e.tpl.fire;
    if (!f || !f.sprite) return;
    const ring = this.data.aimRing || [[0, 0]];
    const [ox, oy] = ring[this.rnd() & (ring.length - 1)] || [0, 0];
    const ax = e.x + Math.round(ox * FP), ay = e.y + Math.round(oy * FP);
    const dx = this.player.x - ax, dy = this.player.y - ay;
    const d = Math.hypot(dx, dy) || 1;
    const sp = f.aimSpeed || this.data.aimSpeed || 2.5;
    const sx = e.x + Math.round(f.muzzle[0] * FP);
    const sy = e.y + Math.round(f.muzzle[1] * FP);
    const shot = new Bullet(sx, sy, f.sprite, f.animTo, dx / d * sp, dy / d * sp);
    shot.layer = f.layer; shot.hits = f.hits; shot.damage = f.damage;
    this.armShot(shot, f);
    this.enemyShots.push(shot);
    this.sfxN(f.sfx, sx / FP, 0.5);
  }

  /**
   * A formation member breaking out. `sub_4334` counts +0xdc down from the
   * anchor's +0xa4 and rolls against its +0xa8; `sub_43c9` then hands the enemy
   * a random path from the bank of 64 at aux[13], turns its aggression back up
   * (fire chance x4, interval halved) and puts it back on the flying behaviour.
   */
  maybeDive(e) {
    const A = this.data.anchor;
    if (!A || !A.diveEvery) return;
    if (--e.diveTimer > 0) return;
    e.diveTimer = A.diveEvery;
    if (this.rnd() >= A.diveChance) return;
    const gid = this.data.attackPaths[this.rnd() & 0x3f];
    const p = this.data.paths[gid];
    if (!p) return;
    e.path = p; e.seg = 0; e.segTicks = -1;
    e.pathDone = false; e.inSlot = false;
    e.diving = true;
    e.fireTimer = 20;                        // [esi+0xc8] = 0x14
  }

  /**
   * Has this pickup anything left to give?
   *
   * A full magazine, a gun already at twice its template's damage, a reload
   * already at its floor, full hit points, top speed. In the original every one
   * of those is silently dropped -- you fly through it, the banner says what it
   * was, and nothing happens.
   *
   * Not `weaponReset`: " CONFISCATOR " still resets the speed and the reload
   * even when the gun it hands back is one you are already holding at its cap.
   */
  spare(item) {
    const P = this.data.player, p = this.player;
    switch (P.effects[item]) {
      case 'ammo':      return !p.gun || p.gun.mag <= p.ammo + this.inFlight;
      case 'sideUp':    return p.maxSpeed >= P.maxSpeed * SPEED_CAP;
      case 'rapidFire': return p.fireEvery - 1 < P.fireEveryMin;
      case 'repair':    return p.hp >= p.maxHp && !p.decay;
      case 'weapon': {
        const id = P.weaponOf[item], w = P.weapons[id];
        return !!w && p.weapon === id && p.damage >= w.damage * P.weaponUpCap;
      }
      default: return false;
    }
  }

  /**
   * The item index of " 50 CREDITS ", found rather than written down.
   *
   * The compensation below is the game's own pickup, not a number invented for
   * it -- which is the pattern `sub_204d` already set for a marker you hold:
   * take one twice and it announces item 18, " 10 CREDITS ", and pays that.
   */
  get sparePay() {
    if (this._sparePay === undefined) {
      const P = this.data.player;
      const k = Object.keys(P.effects).find(
        (i) => P.effects[i] === 'credits' && P.itemArg[i] === 5);
      this._sparePay = k === undefined ? null : Number(k);
    }
    return this._sparePay;
  }

  /**
   * Apply a pickup, by the item index the effect table at 0x1fb4 dispatches on.
   *
   * `paid` is the shop: a purchase that turns out to be useless must not hand
   * fifty credits back, or a ten-credit item nobody needs is a mint.
   */
  collect(item, arg, depth = 0, paid = false) {
    const P = this.data.player, p = this.player;
    if (arg === undefined) arg = P.itemArg[item];
    // A pickup with nothing to give is worth fifty credits instead. A departure
    // from the original, where it is worth nothing at all -- and the one place
    // the port makes the game kinder rather than more faithful, because a run
    // with a full magazine flying through its tenth " WEAPON BOOST " is being
    // punished for doing well.
    if (!paid && this.sparePay !== null && this.spare(item)) {
      this.announce(this.sparePay, this.data.text.playerColour);
      p.credits = Math.min(P.creditCap, p.credits + P.itemArg[this.sparePay]);
      return;
    }
    // Every handler in 0x1d00..0x2300 calls `sub_5808` first, so picking
    // anything up says what it was -- except " RANDOMIZER ", which never gets
    // that far: `sub_20ad` replaces both the pickup and the item index and
    // *tail-jumps* into the rolled item's handler, so what the banner says is
    // the effect you actually got.
    if (P.effects[item] !== 'randomizer')
      this.announce(item, this.data.text.playerColour);
    switch (P.effects[item]) {
      case 'ammo':                                   // `sub_1e19`
        // Capacity is checked against rounds held *plus* rounds in flight.
        if (p.gun.mag > p.ammo + this.inFlight) p.ammo++;
        break;
      case 'weapon':                                 // `sub_2121`
        p.equip(P.weaponOf[item], this);
        break;
      case 'weaponReset':                            // `sub_20d4`
        p.maxSpeed = P.maxSpeed;
        p.fireEvery = P.fireEvery;
        p.weapon = null;
        p.equip(P.weaponOf[item], this);
        break;
      case 'sideUp':                                 // `sub_1e8b`, capped
        p.maxSpeed = Math.min(P.maxSpeed * SPEED_CAP, p.maxSpeed + P.sideStep);
        break;
      case 'sideDown':                               // `sub_1eb9`
        if (p.maxSpeed - P.sideStep >= P.sideMin) p.maxSpeed -= P.sideStep;
        break;
      case 'rapidFire':                              // `sub_1f39`
        if (p.fireEvery - 1 >= P.fireEveryMin) p.fireEvery--;
        break;
      case 'repair':                                 // `sub_1ef3`, SHIP SOLIDIFIER
        p.hp = p.maxHp;
        p.decay = 0;
        break;
      case 'extraLife':                              // `sub_1f8b`
        p.lives++;
        break;
      case 'credits':                                // `sub_1d64`, saturating
        p.credits = Math.min(P.creditCap, p.credits + (arg || 1));
        break;
      case 'boost':                                  // `sub_21ff`, ENGINES BOOST
        // Refused unless the ship is already at home -- you cannot stack hops.
        if (p.y < P.boost.fromY * FP) break;
        p.vy = Math.round(P.boost.vy0 * FP);
        p.state = 'boostUp';
        break;
      case 'megablast':                              // `sub_205c`
        // 0x30 into the damage accumulator of everything wearing the enemy
        // layer -- one bomb, the whole screen.
        for (const e of this.entities)
          if (!e.dead && !e.exploding && (e.tpl.layer & 0x40)) e.decay += P.megablast;
        break;
      case 'paralyser':                              // `sub_2241`
        // One at a time: the ship's +0xe bit 0 says it already has one.
        if (!this.pod) this.pod = new Pod(P.pod, p);
        break;
      case 'creditDouble':                           // `sub_1dc6`, all or nothing
        if (p.credits * 2 <= P.creditCap) p.credits *= 2;
        break;
      case 'randomizer': {                           // `sub_20ad`
        // Rolls the drop table and runs whatever handler that pickup would
        // have. The original does not guard against rolling another randomizer;
        // the depth limit here only stops a runaway.
        if (depth > 8) break;
        const g = P.dropTable[this.rnd()];               // `rnd` already returns 0..255
        const kind = P.dropItems[g];
        if (kind) this.collect(kind.item, kind.arg, depth + 1, paid);
        break;
      }
      case 'marker': {                               // `sub_1fc7`
        // The operand is (which marker, its bit). Taking one you already have
        // is worth ten credits instead (`0x204d` announces item 18 with 1).
        const bit = (arg >> 8) & 0xff;
        if (p.markers & bit) { p.credits = Math.min(P.creditCap, p.credits + 1); break; }
        p.markers |= bit;
        // `sub_1ff1`: point the two loose slots at what you still owe.
        const nxt = P.markerDrop.next[p.markers & 0x3f];
        this.markerSlots[0] = nxt[0]; this.markerSlots[1] = nxt[1];
        if (p.markers !== 0x3f) break;
        p.markers = 0;
        const zero = P.markerDrop.next[0];
        this.markerSlots[0] = zero[0]; this.markerSlots[1] = zero[1];
        p.maxHp += P.promoteHp;
        p.hp = p.maxHp;
        p.decay = 0;
        p.rank = Math.min(P.rankCap, p.rank + 1);
        this.queued = null;                          // the promotion outranks the name
        this.announce(26, this.data.text.playerColour);
        break;
      }
    }
  }

  /**
   * Queue an announcement (`sub_5808`). There is exactly one slot and it is
   * refused while occupied, so a line said during another one is simply lost.
   *
   * `index` is a line of the game's own text table, or -- for the few things
   * the port has to say that 1997 had no word for -- a string of its own.
   */
  announce(index, colour) {
    if (this.queued) return;
    this.queued = [index, colour];
  }

  /**
   * The " disco " cheat: a full purse, and the run stops counting.
   *
   * A cheat that leaves the score table alone is a toy; one that does not is a
   * lie told to whoever reads the table later. So this sets a flag the end of
   * the run checks, and it is never cleared -- `carryOver` takes it to the next
   * level with everything else the ship keeps.
   *
   * The purse fills to `creditCap` rather than to a number of its own: credits
   * move in tens in the original and the readout multiplies by ten, so the cap
   * of 999 is what 9990 CR on the panel means.
   */
  disco() {
    if (this.player.state === 'over') return false;
    this.player.credits = this.data.player.creditCap;
    this.cheated = true;
    this.announce(' DISCO INFERNO ', this.data.text.playerColour);
    return true;
  }

  /**
   * Run the banner (`sub_0946`). It is a three-segment path over the line: in
   * from x = 324 at 4 px a tick for `text.length + 40` ticks, which lands it
   * centred; still for the line's own `hold`; then the same distance again and
   * off the left edge.
   */
  stepMessage() {
    const T = this.data.text;
    if (!this.msg && this.queued) {
      const [i, colour] = this.queued;
      this.queued = null;
      const st = typeof i === 'string' ? { text: i, hold: 120 } : T.strings[i];
      if (st) {
        const n = st.text.length + 40;
        this.msg = { text: st.text, colour, x: T.x0, y: T.y0, px: T.x0,
                     segs: [[n, T.dx], [st.hold, 0], [n, T.dx]], seg: 0, left: n };
      }
    }
    const m = this.msg;
    if (!m) return;
    m.px = m.x;
    while (m.seg < m.segs.length && m.left <= 0)
      if (++m.seg < m.segs.length) m.left = m.segs[m.seg][0];
    if (m.seg >= m.segs.length) { this.msg = null; return; }
    m.x += m.segs[m.seg][1];
    m.left--;
  }

  /** The sprite an entity is showing: explosion, idle, or the path's frame. */
  spriteOf(e) {
    if (e.exploding) return e.tpl.explode[0] + e.frame;
    // The heavy walks +0x64 itself rather than indexing off a base, because it
    // runs through two ranges -- the idle loop and the wind-up above it.
    if (e.anim !== undefined) return e.anim;
    const base = e.pathDone && e.tpl.idle ? e.tpl.idle[0]
                                          : (e.tpl.animBase || e.tpl.sprite);
    return base + e.frame;
  }

  /**
   * Destroy an enemy: it does not vanish, it becomes the explosion.
   *
   * `sub_41f8` puts the entity into state 5, points its animation at
   * [+0xac, +0xb0] and nudges it by (+0x74, +0x78); `sub_2a69` then walks one
   * frame every third tick, drifting by (+0x7c, +0x80), and retires it at the
   * end. The drop is rolled at the moment of death, not when the fire clears.
   */
  destroy(e) {
    this.kills++;
    this.sfx('boom', e.x / FP);
    this.award(e.tpl.score || 0);
    this.dropAt(e);
    // `sub_3bd2`: a member takes one off its anchor's +0xaa, and the anchor
    // retires when that reaches zero.
    if (e.anchor && !e.anchor.dead) e.anchor.alive--;
    // The boss's head. Clearing its bit in the core's +0xc8 is what brings the
    // rest of the half down, and it leaves a second, bigger explosion on top of
    // its own break-up: +0xe0 names a type 5, spawned centred on it.
    if (e.tpl.type === 35) {
      if (e.parent) e.parent.mask &= ~e.tpl.bit;
      const boom = this.spawn(e.tpl.deathSpawn);
      if (boom) {
        const from = this.frameOf(this.spriteOf({ ...e, exploding: false }));
        const to = this.frameOf(boom.tpl.sprite);
        boom.x = e.x + (from && to ? ((from.w - to.w) >> 1) * FP : 0);
        boom.y = e.y + (from && to ? ((from.h - to.h) >> 1) * FP : 0);
        boom.px = boom.x; boom.py = boom.y;
      }
      // **A head does not explode away, it breaks.** `sub_4adf` never puts it
      // into the explosion state: it points the animation at [+0xac, +0xb0],
      // clears the active flag and returns -- and from the next tick
      // `sub_4aaf` finds its bit gone from the core's +0xc8 and rets
      // immediately, so nothing ever advances that animation again. The head
      // holds its first wreck frame, still riding the core, for the rest of
      // the fight. Walking the range and retiring it instead left a hole in
      // the middle of the boss.
      e.wreck = true;
      e.frame = e.tpl.explode[0] - e.tpl.sprite;
      return;
    }
    if (!e.tpl.explode) { e.dead = true; return; }
    e.exploding = true;
    e.frame = 0;
    e.animTimer = 3;
    if (e.tpl.explodeCentred) {
      // A rock does not become its explosion, it spawns one and steps aside
      // (`sub_4f90`), centred on itself by `sub_2358`. Different object,
      // different size, so line the two up rather than nudging.
      const from = this.frameOf(this.spriteOf({ ...e, exploding: false }))
                || this.frameOf(e.tpl.sprite);
      const to = this.frameOf(e.tpl.explode[0]);
      if (from && to) {
        e.x += ((from.w - to.w) >> 1) * FP;
        e.y += ((from.h - to.h) >> 1) * FP;
      }
    } else {
      e.x += Math.round((e.tpl.deathNudge?.[0] || 0) * FP);
      e.y += Math.round((e.tpl.deathNudge?.[1] || 0) * FP);
    }
    e.px = e.x; e.py = e.y;
  }

  /**
   * `sub_4153`: score goes into [0x3b8 + player*4], and every time the total
   * crosses another 10 000 the player is handed item 14 -- an extra life.
   */
  award(points) {
    if (!points) return;
    const step = this.data.player.extraLifeEvery;
    const before = this.score;
    this.score += points;
    if (Math.floor(this.score / step) > Math.floor(before / step))
      this.collect(14);
  }

  /**
   * Which marker a heavy fly leaves behind.
   *
   * **A deliberate divergence.** The original takes three random bits and reads
   * the eight-slot table straight (`sub_3c49`), so the six fixed slots can hand
   * you the same marker over and over -- three in a row, in play. Here each
   * slot is weighted: one you already hold counts once, one you still owe
   * counts three times. The table and its two rewritten slots are untouched, so
   * the shape of the original's distribution survives; only the odds of a
   * duplicate change.
   */
  pickMarker() {
    const slots = this.markerSlots, held = this.player.markers;
    let total = 0;
    const w = slots.map(off => {
      const weight = (held >> (off - 7)) & 1 ? 1 : 3;
      total += weight;
      return weight;
    });
    // `rnd` is a byte; scaling beats a modulo, which would favour the first
    // few slots whenever `total` does not divide 256.
    let r = (this.rnd() * total) >> 8;
    for (let i = 0; i < slots.length; i++) {
      r -= w[i];
      if (r < 0) return slots[i];
    }
    return slots[slots.length - 1];
  }

  /**
   * A sound. Every one in the game is an instrument counted back from the end
   * of the current bank (`sub_228c`), played at one fixed period -- the
   * 0x300 / 0x400 / 0x500 the call sites pass are voice priorities, not
   * pitches -- and panned by where on the field it happened. Several of the
   * call sites roll a couple of bits and add them, so the same event has two
   * or four voices and does not machine-gun.
   */
  sfx(kind, x = 160) {
    if (!this.onSfx) return;
    const r = this.data.player.sfx && this.data.player.sfx[kind];
    if (!r) return;
    const [n, span] = r;
    this.sfxN(n + (span > 1 ? this.rnd() & (span - 1) : 0), x);
  }

  /**
   * The same, for a sound an object names itself in its `+0xae`.
   *
   * `gain` is the port's, not the original's: everything is quieter than it
   * was, and the enemies' guns quieter still, because there are a great many
   * of them and they are the one sound that is *always* playing.
   */
  sfxN(n, x = 160, gain = 0.7) {
    if (this.onSfx && n) this.onSfx(n, this.data.player.sfxPeriod, x, gain);
  }

  /** Give a new shot whatever steering its template asks for. */
  armShot(b, f) {
    if (f.homing) {
      b.homing = f.homing;
      // `sub_37e6`: the lifetime is shortened by a random amount, so a volley
      // does not all expire on the same tick.
      b.life = f.homing.life - (this.rnd() & 0x7f);
      b.steerIn = f.homing.first;
      b.dir = f.homing.dir;
      b.sprite = b.from = f.homing.base + b.dir;
      b.to = b.sprite + 1;
    }
    if (f.pathEnd === 'aim' && b.path) b.launch = { base: f.dirBase };
  }

  /**
   * Which of sixteen directions points at the ship.
   *
   * `sub_38a4` and `sub_3a05`, and they are the same code: the aim is taken 15
   * pixels *ahead* of the ship, the slope is divided down by four and clamped
   * to +-20, and a 41-entry table turns it into one of the eight directions of
   * the right half; a negative dx flips it to the left half.
   */
  aimDir(x, y) {
    let dx = (this.player.x - x + 15 * FP) >> 2;
    const dy = -(this.player.y - y);
    let want;
    if (dx === 0) want = this.data.homeSlope[40];      // `edx` is left at +20
    else {
      let q = Math.trunc(dy / dx);
      q = Math.max(-20, Math.min(20, q));
      want = this.data.homeSlope[q + 20];
    }
    return dx < 0 ? (want + 8) & 0xf : want & 0xf;
  }

  /**
   * A steering shot, one tick. Type 18 turns a sixteenth at a time for as long
   * as it lives; type 19 flies its launch path and then aims once, exactly, at
   * the speed it already had, and is an ordinary shot from then on.
   */
  stepSteering(b) {
    if (b.launch && b.pathDone) {
      const dir = this.aimDir(b.x, b.y);
      b.sprite = b.from = b.to = b.launch.base + dir;
      b.to = b.sprite + 1;
      const dx = this.player.x - b.x, dy = this.player.y - b.y;
      const d = Math.hypot(dx, dy) || 1;
      const sp = Math.hypot(b.vx, b.vy) || 1;
      b.vx = Math.round(dx / d * sp); b.vy = Math.round(dy / d * sp);
      b.launch = null;
      return;
    }
    const H = b.homing;
    if (!H) return;
    if (--b.life <= 0) { b.dead = true; return; }
    // Every tick, not only on a steer: the heading is reset from the table each
    // time it turns, so this has to be a nudge to the position rather than a
    // term in the velocity.
    b.y += Math.round(MISSILE_SINK * FP);
    if (--b.steerIn > 0) return;
    b.steerIn = H.steer;
    const want = this.aimDir(b.x, b.y);
    let cur = b.dir;
    // One step round the circle, and which way is the short way is bit 3 of
    // the difference -- `test dl, 8`.
    const diff = (want - cur) & 0xff;
    if (diff !== 0) cur = (diff & 8) ? cur - 1 : cur + 1;
    b.dir = cur & 0xf;
    const [vx, vy] = this.data.homeDirs[b.dir];
    b.vx = Math.round(vx * FP); b.vy = Math.round(vy * FP);
    b.sprite = b.from = H.base + b.dir;
    b.to = b.sprite + 1;
  }

  /** `sub_3641`: a shot that dies -- hit, or off the screen -- returns one round. */
  returnRound() {
    this.inFlight--;
    this.player.ammo = Math.min(this.player.gun.mag, this.player.ammo + 1);
  }

  maskOf(gid) { return this.data.masks[gid]; }
  frameOf(gid) { return this.data.atlas.frames[gid]; }

  /**
   * One tick of an emitter, `sub_4e42`.
   *
   * Every `period` ticks it rolls a byte and throws a rock only if the roll
   * comes up under `density`, so the script tunes both cadence and thickness.
   * Which rock comes out of the weighted 16-entry index at data:0x2495; how
   * fast, out of its own base speed plus six random bits, scaled by whatever
   * `emit_speed` last set. It lands anywhere across the screen.
   */
  emit(e) {
    if (e.emitTimer === undefined) {
      e.density = e.tpl.emitter.density;
      e.period = e.tpl.emitter.period;
      e.speed = e.tpl.emitter.speed;
      // +0x4a starts at 0 in the template and the countdown is a *byte*, so the
      // first `dec` wraps to 255: the emitter is quiet for its first 256 ticks.
      e.emitTimer = 256;
    }
    if (--e.emitTimer > 0) return;
    e.emitTimer = e.period;
    const E = e.tpl.emitter, roll = this.rnd();
    if (e.density <= roll) return;
    const [tid, base] = E.rocks[E.pick[roll & 0xf]] || E.rocks[0];
    const rock = this.spawn(tid, this.rnd() * 5 * 16384 / FP);
    if (!rock) return;
    rock.free = true;
    rock.vy = ((this.rnd() & 0x3f) + base) * e.speed;
    // `sar al, 2` on a random byte: a signed -32..31 sideways nudge.
    rock.vx = ((this.rnd() << 24 >> 26)) * E.drift;
    rock.y = -20 * FP;
    rock.px = rock.x; rock.py = rock.y;
    this.sfx('rock', rock.x / FP);
  }

  /**
   * A projectile that is an object rather than a bullet, `sub_35e6`.
   *
   * It sits out `+0xb0` ticks, then loops [`+0x6c`, `+0x70`) one frame every
   * third tick and moves by (`+0x7c`, `+0x80`). Being an object is what makes
   * it different from an ordinary shot: it can be hit, and `destroy` then turns
   * it into the explosion at [`+0x9c`, `+0xa0`) -- a different pair of fields
   * from every other type in the game.
   */
  stepProjectile(e) {
    if (--e.delay >= 0) return;
    const J = e.tpl.projectile;
    if (--e.animTimer <= 0) {
      e.animTimer = 3;
      let n = e.tpl.sprite + e.frame + 1;
      if (n >= J.loop[1]) n = J.loop[0];
      e.frame = n - e.tpl.sprite;
    }
    e.x += e.vx; e.y += e.vy;
    const x = e.x / FP, y = e.y / FP;
    if (y < -40 || y > 390 || x < -50 || x > 370) e.dead = true;
  }

  /**
   * A boss coming apart, `sub_5052`.
   *
   * Type 9 is an explosion emitter and it is what a core leaves behind when it
   * dies. It lives +0x50 ticks and every +0x49 of them rolls against +0x48 and
   * drops one of *eight* sizes of explosion at a random point in a +0x18 by
   * +0x1c box, centred on that point and sinking at 2 px a tick. Level 8's
   * final boss gets two of these, the second covering the whole screen for five
   * seconds.
   */
  stepBurst(e) {
    const B = e.tpl.burst;
    if (--e.burstLife <= 0) { e.dead = true; return; }
    // A *byte* countdown reloaded from +0x49, and the roll only happens when it
    // reaches zero.
    if (--e.burstTimer !== 0) return;
    e.burstTimer = B.period;
    const roll = this.rnd();
    if (B.chance <= roll) return;
    const boom = this.spawn(B.base + (roll & 7));
    if (!boom) return;
    boom.x = e.x + (this.rnd() % B.w) * FP;
    boom.y = e.y + (this.rnd() % B.h) * FP;
    const f = this.frameOf(boom.tpl.sprite);
    if (f) { boom.x -= (f.w >> 1) * FP; boom.y -= (f.h >> 1) * FP; }
    boom.px = boom.x; boom.py = boom.y;
  }

  /**
   * The formation anchor, `sub_3a68`.
   *
   * It is never drawn and it never stops: when its flight path runs out it
   * takes another from the same bank of four the patrolling heavies use and
   * keeps going. That matters more than it sounds -- letting the generic "home
   * to your formation slot" code have it instead dragged it to (0, 0) and
   * parked every survivor of the wave in the top-left corner, which is the fly
   * that sat half off the top of the screen through the level 2 boss fight.
   *
   * It also drips reinforcements in, on an interval that shrinks by 700 ticks
   * each time and floors at 560, and retires -- freeing its slot -- the moment
   * its member count reaches zero.
   */
  stepAnchor(e) {
    if (e.alive <= 0) {                         // `sub_3b34`
      if (this.anchors[e.tpl.anchorSlot] === e) delete this.anchors[e.tpl.anchorSlot];
      e.dead = true;
      return;
    }
    if (--e.reinforce <= 0) {
      e.reinforce = e.interval;
      e.interval = Math.max(560, e.interval - 700);
      e.alive++;
      const extra = this.spawn(e.tpl.member + (this.rnd() & 1));
      if (extra) {
        extra.anchor = e;
        // And the late arrival is angrier than the wave it joins: `sub_3ad2`
        // gives it a quarter of its hit points as ram damage, halves its
        // reload and rotates its firing chance left a bit.
        extra.hardened = true;
      }
    }
    if (!e.path) return;
    if (--e.segTicks < 0) {
      const next = e.path[e.seg];
      if (!next || next[0] === 0) {
        const g = this.data.patrolPaths[this.rnd() & 3];
        const p = this.data.paths[g];
        if (p) { e.path = p; e.seg = 0; e.segTicks = -1; }
        else e.path = null;
      } else {
        e.seg++; e.segTicks = next[0];          // the stall tick
      }
      return;
    }
    const rec = e.path[e.seg - 1];
    e.x += Math.round(rec[2] * FP); e.y += Math.round(rec[3] * FP);
  }

  /**
   * The boss core, `sub_47fd`. Two of them end level 1, and neither is ever
   * drawn: a core is the thing the wings and the head are pinned to.
   *
   * It flies +0x8c and, when that path runs out, picks up +0xb4 and flies that
   * for ever -- the handler jumps back to its own top, so the boss circles
   * rather than leaving. Meanwhile it runs the little bytecode machine in
   * +0xb0 for as long as `+0xbc & +0xc8` holds. That mask is the boss's life:
   * the head clears its bit when it dies, and with the mask empty the core
   * counts +0xc0 down, drops +0xaa to zero and vacates its anchor slot, which
   * both retires the wings and lets the script's gate through.
   */
  stepBossCore(e) {
    if (e.path) {
      if (--e.segTicks < 0) {
        const next = e.path[e.seg];
        if (!next || next[0] === 0) {
          const p = this.data.paths[e.tpl.nextPath];
          if (p) { e.path = p; e.seg = 0; e.segTicks = -1; }
          else e.path = null;
        } else {
          e.seg++; e.segTicks = next[0];               // the stall tick
        }
      } else {
        const rec = e.path[e.seg - 1];
        e.x += Math.round(rec[2] * FP); e.y += Math.round(rec[3] * FP);
      }
    }
    if ((e.need & e.mask) !== 0) { this.bossVM(e); return; }
    // `sub_490e`.
    if (--e.deathDelay > 0) return;
    e.alive = 0;
    e.cmd = -1;                       // every part reads this and stands down
    if (this.slots[e.tpl.anchorSlot] === e) delete this.slots[e.tpl.anchorSlot];
    // `sub_493f`: whatever +0xc4 names, put where the core was. For six of the
    // eight bosses that is the type-9 cascade above; levels 2 and 4 name a
    // projectile instead, and those types are not transcribed yet.
    const leave = this.data.templates[e.tpl.deathSpawn];
    if (leave && (leave.type === 9 || leave.type === 5 ||
                  leave.type === 15 || leave.type === 19)) {
      const o = this.spawn(e.tpl.deathSpawn);
      if (o) {
        o.x += e.x - Math.round(leave.x * FP);
        o.y += e.y - Math.round(leave.y * FP);
        o.px = o.x; o.py = o.y;
      }
    }
    e.dead = true;
  }

  /**
   * The entity sub-VM, `sub_483d`: program counter in +0xb0, continuation in
   * +0xac. Level 1's cores share a four-instruction program -- name the head as
   * the part that has to stay alive, then wait out the clock -- but the machine
   * is transcribed whole because the later levels' bosses run the same one.
   */
  bossVM(e) {
    const prog = e.tpl.vm;
    if (!prog) return;
    if (e.vmMode === 'wait') { if (--e.vmCount >= 0) return; e.vmMode = null; }
    else if (e.vmMode === 'flags') { if ((e.mask & e.vmCount) !== 0) return; e.vmMode = null; }
    if (e.vmPC >= prog.length) return;
    // **One opcode per tick**, and that is not a simplification -- every handler
    // in the table ends in `ret`, so the machine really does advance one step a
    // frame. It matters: the later bosses issue `set_pair 0xffffffff, 0` to
    // silence every part and then a run of targeted `set_pair`s, and if those
    // ran in one tick only the last would survive to be read.
    const [op, a, b] = prog[e.vmPC++];
    if (op === 'wait') { e.vmMode = 'wait'; e.vmCount = a; }
    // Blocks while the bits are set: it waits until those parts are *gone*.
    else if (op === 'wait_flags') { e.vmMode = 'flags'; e.vmCount = a; }
    else if (op === 'set') e.need = a >>> 0;
    else if (op === 'set_pair') { e.cmd = a >>> 0; e.cmdArg = b >>> 0; }
    else if (op === 'xor_flags') e.mask = (e.mask ^ a) >>> 0;
    // `loop` is `sub ebx, [ebx]` -- a jump backwards, resolved to an index by
    // the exporter. **Every one of the eight programs ends in one**, so no boss
    // ever runs off the end of its choreography and no boss ever retires by
    // itself; they repeat until you shoot them apart.
    else if (op === 'loop') e.vmPC = a;
    // `yield` is `call 0x60e3; ret`: one retrace, and then carry on. It is not
    // the end of anything -- reading it as one stopped level 6's boss six
    // instructions into a 281-instruction routine.
    else if (op !== 'yield') e.vmPC = prog.length;
  }

  /** Where a part sits: its own offset, plus wherever its core has got to. */
  pinToParent(e) {
    const p = e.parent;
    if (!p) return false;
    e.x = p.x + e.ox; e.y = p.y + e.oy;
    return true;
  }

  /**
   * A wing, `sub_4976`. It follows the core, flaps through [+0x98, +0x9c) one
   * frame every third tick, and the moment the core's +0xaa reaches zero it
   * stops being drawn and retires. It has no collision layer at all, so shots
   * pass straight through it -- only the head can be hurt.
   */
  stepBossWing(e) {
    if (!this.pinToParent(e) || !e.parent.alive) { e.dead = true; return; }
    if (--e.animTimer > 0) return;
    e.animTimer = 3;
    const span = e.tpl.anim[1] - e.tpl.anim[0];
    e.frame = e.frame + 1 < span ? e.frame + 1 : 0;
  }

  /**
   * The head, `sub_49ea`. Anchored like the wing, but this one has health, a
   * score, a prize and a mouth.
   *
   * The firing is worth reading twice: the roll against +0xd8 does not spit
   * anything, it only extends the animation range to +0xa8. The head then
   * walks the remaining thirty-seven frames of its wind-up at three ticks each
   * -- a second and a half of visibly opening its jaws -- and the spit leaves
   * on the frame that wraps. You get to see it coming, which is the whole
   * design of the fight.
   */
  stepBossGun(e) {
    const p = e.parent;
    if (!p) { e.dead = true; return; }
    // `sub_49f0`: a head can carry a flight path of its own, and it is walked
    // in *local* coordinates -- what moves is the offset from the core, and the
    // offset is reset to (0, 0) each time the path restarts. Level 3's saucers
    // wear three turrets that orbit them on a 91-tick ellipse this way; without
    // this they sit stacked on top of the core, three sprites in one place.
    if (e.path) {
      e.x = e.ox; e.y = e.oy;
      for (let lap = 0; lap < 4; lap++) {
        if (--e.segTicks >= 0) {
          const rec = e.path[e.seg - 1];
          e.x += Math.round(rec[2] * FP); e.y += Math.round(rec[3] * FP);
          break;
        }
        const next = e.path[e.seg];
        if (next && next[0] !== 0) { e.seg++; e.segTicks = next[0]; break; }
        const np = this.data.paths[e.tpl.nextPath];
        if (!np) { e.path = null; break; }
        e.path = np; e.seg = 0; e.segTicks = -1;
        e.x = 0; e.y = 0;                    // `jmp 0x4a0b`, from the top
      }
      e.ox = e.x; e.oy = e.y;
    }
    this.pinToParent(e);
    // `+0xcc` is the core talking to its parts. Death sets every bit of it.
    if ((p.cmd & e.tpl.bit) !== 0) {
      if (!p.alive) { p.mask &= ~e.tpl.bit; e.dead = true; return; }
      p.cmd &= ~e.tpl.bit;
      e.fireChance = p.cmdArg & 0xff;
      e.fireEvery = p.cmdArg >>> 8;
      e.fireTimer = 0;
    }
    if ((p.mask & e.tpl.bit) === 0) return;       // already dead: nothing to do
    const f = e.tpl.fire;
    if (--e.fireTimer < 0) {
      e.fireTimer = e.fireEvery;
      // `cmp [esi+0x10], 0x1400000`: it holds its fire while it is off-screen.
      if (this.rnd() < e.fireChance && e.x <= 320 * FP) e.animTo = e.tpl.fireTo;
    }
    if (--e.animTimer > 0) return;
    e.animTimer = 3;
    const base = e.tpl.sprite;
    let next = base + e.frame + 1;
    const reached = next;
    if (next >= e.animTo) {
      next = e.tpl.wrapTo;
      if (e.fireEvery) { next = e.tpl.loop[0]; e.animTo = e.tpl.loop[1]; }
    }
    e.frame = next - base;
    if (reached === e.tpl.muzzleFrame) this.bossSpit(e, f);
  }

  /**
   * The spit. `sub_38e9` makes a type-17 shot spawn the next link of its own
   * chain at the same muzzle, so one mouthful is four droplets: each carries
   * its own sideways offset and its own flight path, and the four fan out and
   * then fall together.
   */
  bossSpit(e, f) {
    const x = e.x + Math.round(f.muzzle[0] * FP);
    const y = e.y + Math.round(f.muzzle[1] * FP);
    for (const c of f.spread || [{ off: [0, 0], path: 0, vx: f.vx, vy: f.vy }]) {
      // The link's own velocity, not the chain head's. Level 4's burst is
      // sixteen of these spaced around a circle, each flying outward.
      let vx = c.vx, vy = c.vy;
      if (c.aimSpeed) {
        const dx = this.player.x - x, dy = this.player.y - y;
        const d = Math.hypot(dx, dy) || 1;
        vx = dx / d * c.aimSpeed; vy = dy / d * c.aimSpeed;
      }
      if (!c.off[0] && !c.off[1]) this.sfxN(f.sfx, x / FP, 0.5);  // once a volley
      const b = new Bullet(x + Math.round(c.off[0] * FP), y + Math.round(c.off[1] * FP),
                           f.sprite, f.animTo, vx, vy);
      b.path = this.data.paths[c.path] || null;
      b.layer = f.layer; b.hits = f.hits; b.damage = f.damage;
      this.armShot(b, f);
      this.enemyShots.push(b);
    }
  }

  spawn(gid, xOverride) {
    const tpl = this.data.templates[gid];
    if (!tpl) return null;
    const e = new Entity(tpl, gid, xOverride !== undefined ? xOverride : tpl.x, tpl.y);
    e.path = this.data.paths[tpl.path] || null;
    // A type 5 is an explosion from the moment it is born -- `sub_2a29` points
    // it at [+0x64, +0x70] and `sub_2a69` walks it -- which is what the boss's
    // head leaves behind on top of its own break-up.
    if (tpl.type === 5 && tpl.explode) {
      e.exploding = true; e.frame = 0; e.animTimer = 3;
    }
    if (tpl.projectile) {
      const J = tpl.projectile;
      e.vx = Math.round(J.vx * FP); e.vy = Math.round(J.vy * FP);
      e.delay = J.delay;
      // `sub_3936`: fired not from itself but from one of sixteen points on a
      // circle of radius 20 around it, so an aimed shot leads or lags the ship
      // by a little instead of being perfect.
      if (J.aim) {
        const r = this.data.aimRing[this.rnd() & 0xf];
        const ox = e.x + Math.round(r[0] * FP), oy = e.y + Math.round(r[1] * FP);
        const dx = this.player.x - ox, dy = this.player.y - oy;
        const d = Math.hypot(dx, dy) || 1;
        e.vx = Math.round(dx / d * this.data.aimSpeed * FP);
        e.vy = Math.round(dy / d * this.data.aimSpeed * FP);
      }
    }
    if (tpl.burst) {
      // `sub_5045` nudges it by (+0x28, +0x2c) before anything else.
      e.x += Math.round(tpl.burst.offset[0] * FP);
      e.y += Math.round(tpl.burst.offset[1] * FP);
      e.px = e.x; e.py = e.y;
      e.burstLife = tpl.burst.life;
      e.burstTimer = tpl.burst.period;
    }
    if (tpl.type === 11) {
      // `sub_3a56`: the anchor puts itself in the registry its members and the
      // script's gates look it up in.
      e.alive = tpl.wave;                       // +0xaa, the wave's size
      e.interval = tpl.reinforceEvery;          // +0x98
      e.reinforce = tpl.reinforceEvery;         // +0x9c
      this.anchors[tpl.anchorSlot] = e;
    } else if (tpl.type === 30 || tpl.type === 31) {
      // `sub_3b4d` resolves +0xb8 from a slot number to the anchor itself, once,
      // at construction -- so a member belongs to the wave it was born into and
      // not to whichever wave happens to be current when it dies.
      e.anchor = this.anchors[tpl.group] || null;
      // `sub_40fe` seeds the reload with a random byte rather than zero, so a
      // pair that arrives together does not wind up in lockstep.
      e.fireTimer = this.rnd();
    }
    if (tpl.type === 33) {
      // `sub_3a56`: the core puts itself in the anchor table, where both its
      // own children and the script's gates go looking for it.
      e.alive = tpl.alive; e.mask = tpl.flags >>> 0; e.need = tpl.aliveMask >>> 0;
      e.cmd = 0; e.cmdArg = 0;
      e.vmPC = 0; e.vmMode = null; e.vmCount = 0;
      e.deathDelay = tpl.deathDelay;
      this.slots[tpl.anchorSlot] = e;
    } else if (tpl.type === 34 || tpl.type === 35) {
      // `sub_3b4d`: +0xb8 holds a slot number in the template and the parent's
      // address after the constructor has looked it up.
      e.parent = this.slots[tpl.parentSlot] || null;
      e.ox = Math.round(tpl.offset[0] * FP);
      e.oy = Math.round(tpl.offset[1] * FP);
      e.frame = 0;
      // Pin it before it is ever drawn. A part is created at (0, 0) and level
      // 3's cores fly in from x = -60 and x = 344, so the first tick moved the
      // whole boss the width of the screen -- and the renderer interpolates
      // between ticks, so that one tick smeared eight turrets across the field
      // for three or four frames before everything settled.
      if (e.parent) {
        e.x = e.parent.x + e.ox; e.y = e.parent.y + e.oy;
        e.px = e.x; e.py = e.y;
      }
      if (tpl.type === 35) {
        e.animTo = tpl.idle[1];
        e.fireTimer = this.rnd();      // `[esi+0xc8] = rnd()`: a random phase
        // Copies, not the template's own: `set_pair` can retune them mid-fight.
        e.fireEvery = tpl.fire.every;
        e.fireChance = tpl.fire.chance;
      }
    }
    this.entities.push(e);
    return e;
  }

  step(input = { dx: 0, dy: 0, fire: false }) {
    const t = ++this.tick;
    this.player.step(input, this);
    this.runProgram();
    this.stepMessage();
    while (this.nextProp < this.backdrop.length && this.backdrop[this.nextProp][0] <= t) {
      const [, gid, x] = this.backdrop[this.nextProp++];
      this.spawn(gid, x);
    }

    for (const e of this.entities) {
      e.px = e.x; e.py = e.y;
      // The asteroid belt's emitter (`sub_4e42`). It has no body of its own --
      // it just throws rocks until the script stops it.
      if (e.tpl.emitter) { this.emit(e); continue; }
      if (e.exploding) {
        // One frame every third tick, drifting, then gone. A boss part is not
        // retired when it dies -- it keeps running its handler, so its wreck
        // goes on riding the core while it burns.
        if (e.parent) this.pinToParent(e);
        e.x += Math.round((e.tpl.explodeDrift?.[0] || 0) * FP);
        e.y += Math.round((e.tpl.explodeDrift?.[1] || 0) * FP);
        if (--e.animTimer <= 0) {
          e.animTimer = 3;
          if (e.tpl.explode[0] + ++e.frame >= e.tpl.explode[1]) e.dead = true;
        }
        continue;
      }
      if (e.decay > 0) {
        // Applied once and cleared, exactly as for the ship. Every type does it
        // with the same three instructions -- `sub_4124` for a fly, `sub_3bbb`
        // for a heavy, `sub_4ef0` for a rock:
        //     mov ax,  [esi+0x5c]
        //     sub ax,  [esi+0x5e]
        //     mov [esi+0x5c], eax      ; a *dword* store, so +0x5e goes too
        // +0x5e is a per-tick inbox, not a decay rate. Leaving it standing made
        // everything take its first hit again every tick after: a 300-point
        // asteroid died four ticks after one four-barrel volley.
        e.hp -= e.decay;
        e.decay = 0;
        if (e.hp < 0) { this.destroy(e); continue; }
      }
      if (e.tpl.projectile) { this.stepProjectile(e); continue; }
      if (e.tpl.burst) { this.stepBurst(e); continue; }
      if (e.tpl.type === 11) { this.stepAnchor(e); continue; }
      if (e.tpl.type === 30) { this.stepHeavy(e); continue; }
      if (e.tpl.type === 33) { this.stepBossCore(e); continue; }
      if (e.tpl.type === 34) { this.stepBossWing(e); continue; }
      if (e.tpl.type === 35) { this.stepBossGun(e); continue; }
      if (e.path && !e.pathDone) {
        if (--e.segTicks < 0) {
          const next = e.path[e.seg];                // the segment we move into
          if (!next || next[0] === 0) {
            e.pathDone = true;      // `sub_2b80` raises a flag; it does not kill
            continue;
          }
          e.seg++;
          e.segTicks = next[0];
          if (next[1] >= 0) e.frame = next[1];       // -1 means keep the frame
          continue;                                  // the stall tick
        }
        const rec = e.path[e.seg - 1];               // the segment we are in
        e.vx = Math.round(rec[2] * FP); e.vy = Math.round(rec[3] * FP);
        e.x += e.vx; e.y += e.vy;
      } else if (e.pathDone) {
        // Off the path the enemy animates on its own range (`sub_450a`).
        if (e.tpl.idle && --e.idleTimer <= 0) {
          e.idleTimer = 3;
          e.frame = e.frame + 1 < e.tpl.idle[1] - e.tpl.idle[0] ? e.frame + 1 : 0;
        }
        // Home into the formation slot (`sub_44bd`), then stick to it
        // (`sub_4334`) so the whole formation rides with its anchor. A member
        // whose anchor has retired holds where it is: homing it to (0, 0) is
        // what used to pile a dead wave up in the corner of the screen.
        const a = e.anchor;
        if (!a || a.dead) { if (e.inSlot) this.maybeDive(e); continue; }
        const tx = a.x + Math.round((e.tpl.slot ? e.tpl.slot[0] : 0) * FP);
        const ty = a.y + Math.round((e.tpl.slot ? e.tpl.slot[1] : 0) * FP);
        const dx = tx - e.x, dy = ty - e.y;
        const d = Math.hypot(dx, dy), step = this.data.player.formSpeed * FP;
        if (d <= step) { e.x = tx; e.y = ty; e.inSlot = true; }
        else { e.x += Math.round(dx / d * step); e.y += Math.round(dy / d * step); }
        if (e.inSlot) this.maybeDive(e);
      } else {
        // A rock carries its own velocity; everything else uses its template's.
        e.x += e.free ? e.vx : Math.round((e.tpl.vx || 0) * FP);
        e.y += e.free ? e.vy : Math.round((e.tpl.vy || 0) * FP);
        // `sub_5039`: a rock is retired by the engine's own off-screen flag
        // rather than wrapping like a path-flying enemy does.
        if (e.free && (e.y > 380 * FP || e.x < -60 * FP || e.x > 380 * FP))
          e.dead = true;
      }

      if (e.tpl.type === 10) {                       // backdrop falls away
        if (e.y / FP > 380) e.dead = true;
      } else if (!e.pathDone && !e.free) {
        // Only a *path-flying* enemy wraps at the edges. A parked one holds,
        // and a rock the emitter threw is retired instead -- letting it wrap
        // left two hundred asteroids circling the screen for ever.
        this.wrap(e);
      }
    }
    for (const b of this.bullets) {
      const was = b.dead;
      b.step();
      if (b.dead && !was) this.returnRound();     // the round comes back
    }
    if (this.pod) {
      this.pod.step(this.player);
      if (this.pod.dead) this.pod = null;
    }
    // Pickups (`sub_4d02`). A shot that lands is settled here, on the pickup's
    // own tick, not in the collision pass: it either knocks the thing about or
    // turns it into an explosion.
    const K = this.data.player.dropKnock;
    for (const b of this.drops) {
      if (b.exploding) {
        if (--b.animTimer <= 0) {
          b.animTimer = 3;
          b.px = b.x; b.py = b.y;
          b.x += b.vx; b.y += b.vy;
          if (++b.sprite >= b.explode[1]) b.dead = true;
        }
        continue;
      }
      if (b.decay) {
        const took = b.decay;
        b.decay = 0;
        b.hp -= took;
        if (b.hp < 0) {
          b.exploding = true;
          b.sprite = b.explode[0];
          b.animTimer = 3;
          continue;
        }
        // Knocked up, and shoved back towards the middle of the screen.
        b.vy += Math.round(K.vy * FP);
        b.vx += Math.round((b.x / FP > K.midX ? -K.vx : K.vx) * FP);
      }
      b.step();
    }
    for (const b of this.enemyShots) {
      if (b.homing || b.launch) this.stepSteering(b);
      if (!b.dead) b.step();
    }

    // Enemies shoot: `sub_42d2` counts +0xc8 down from +0xc4 and rolls against
    // the low byte of +0xd8.
    //
    // The aggression is *reduced* on parking, not raised on diving: `sub_44a6`
    // shifts the chance right by 2 and doubles the interval when an enemy takes
    // its slot, and `sub_43c9` shifts it back and halves the interval when it
    // breaks out. Getting that backwards made a resting formation shoot like a
    // diving one, and a stationary player died 23 times in 86 seconds.
    for (const e of this.entities) {
      const f = e.tpl.fire;
      // The boss's head fires off its animation, not off this timer.
      if (e.tpl.type === 35) continue;
      if (e.tpl.type === 30) continue;     // `sub_3ee7` fires it, not the timer
      if (e.dead || e.exploding || !f || !f.sprite) continue;
      if (--e.fireTimer > 0) continue;
      const parked = e.pathDone;
      e.fireTimer = parked ? f.every * 2 : f.every;
      const chance = parked ? f.chance >> 2 : f.chance;
      if (this.rnd() >= chance) continue;
      const sx = e.x + Math.round(f.muzzle[0] * FP);
      const sy = e.y + Math.round(f.muzzle[1] * FP);
      let vx = f.vx, vy = f.vy;
      if (f.aimSpeed) {                    // aimed at the player, `sub_3f11`
        const dx = this.player.x - sx, dy = this.player.y - sy;
        const d = Math.hypot(dx, dy) || 1;
        vx = dx / d * f.aimSpeed; vy = dy / d * f.aimSpeed;
      }
      const shot = new Bullet(sx, sy, f.sprite, f.animTo, vx, vy);
      shot.layer = f.layer; shot.hits = f.hits; shot.damage = f.damage;
      this.armShot(shot, f);
      this.enemyShots.push(shot);
      this.sfxN(f.sfx, sx / FP, 0.5);
    }


    // Collisions. `sub_56a6` runs one pairwise loop over every object and
    // decides two things from the layer words: whether the pair interacts at
    // all (`pairs`), and whether the silhouettes are compared or a bounding box
    // is enough (`exact`). Both are transcribed rather than assumed, which is
    // what settles the question of an enemy flying through the ship.
    const P = this.data.player;
    const touch = (aL, ax, ay, af, am, bL, bx, by, bf, bm) =>
      exact(aL, bL) ? hit(ax, ay, am, af.w, af.h, bx, by, bm, bf.w, bf.h)
                    : overlap(ax, ay, af.w, af.h, bx, by, bf.w, bf.h);

    // The companion is layer 0x210 wanting 0xc0: it pairs with enemy bodies and
    // with enemy fire, and with nothing else. It deals its +0x5c to whatever it
    // touches and takes nothing back.
    if (this.pod) {
      const o = this.pod, of_ = this.frameOf(o.sprite), om = this.maskOf(o.sprite);
      if (of_) {
        for (const e of this.entities) {
          if (e.dead || e.exploding || !pairs(o.layer, o.hits, e.tpl.layer, e.tpl.hits)) continue;
          const gid = this.spriteOf(e), ef = this.frameOf(gid) || this.frameOf(e.tpl.sprite);
          if (ef && touch(o.layer, o.x / FP, o.y / FP, of_, om,
                          e.tpl.layer, e.x / FP, e.y / FP, ef,
                          this.maskOf(gid) || this.maskOf(e.tpl.sprite)))
            e.decay += o.cfg.damage;
        }
        for (const b of this.enemyShots) {
          if (b.dead || !pairs(o.layer, o.hits, b.layer, b.hits)) continue;
          const f = this.frameOf(b.sprite);
          if (f && touch(o.layer, o.x / FP, o.y / FP, of_, om,
                         b.layer, b.x / FP, b.y / FP, f, this.maskOf(b.sprite)))
            b.dead = true;
        }
      }
    }

    // Player shots against enemies: layer 0x04 against interest 0x0c, and
    // neither side carries 0x10, so this pair is decided on boxes.
    for (const b of this.bullets) {
      if (b.dead) continue;
      const bf = this.frameOf(b.sprite), bm = this.maskOf(b.sprite);
      if (!bf) continue;
      // And against pickups, whose interests (0x0f) name the shot layers too:
      // an unwanted prize can be shot out of the air instead of caught.
      for (const d of this.drops) {
        if (d.dead || d.exploding) continue;
        if (!pairs(P.bulletLayer, P.bulletHits, d.layer, d.hits)) continue;
        const df = this.frameOf(d.sprite);
        if (df && touch(d.layer, d.x / FP, d.y / FP, df, this.maskOf(d.sprite),
                        P.bulletLayer, b.x / FP, b.y / FP, bf, bm)) {
          d.decay += this.player.damage;
          b.dead = true;                 // the pickup deals far more than a shot can take
          this.sfx('hit', d.x / FP);
          this.returnRound();
          break;
        }
      }
      if (b.dead) continue;
      for (const e of this.entities) {
        // A broken part is scenery: `+0x0c` bit 1 goes at death, which takes it
        // out of the collision pass. So is the backdrop.
        if (e.dead || e.wreck || e.tpl.type === 10) continue;
        if (!pairs(P.bulletLayer, P.bulletHits, e.tpl.layer, e.tpl.hits)) continue;
        const gid = this.spriteOf(e);
        const ef = this.frameOf(gid) || this.frameOf(e.tpl.sprite);
        if (!ef) continue;
        if (touch(e.tpl.layer, e.x / FP, e.y / FP, ef,
                  this.maskOf(gid) || this.maskOf(e.tpl.sprite),
                  P.bulletLayer, b.x / FP, b.y / FP, bf, bm)) {
          e.decay += this.player.damage;
          b.dead = true;
          this.sfx('hit', e.x / FP);
          this.returnRound();
          break;
        }
      }
    }

    // The player. It is layer 0x11 and interested in 0x80: that pairs it with
    // the enemies' shots (layer 0x80) and with the pickups (interest 0x0f), and
    // with nothing else. An enemy is layer 0x40 wanting 0x0c, so its body never
    // pairs with the ship at all -- flying one straight through you is
    // harmless, and only its shots hurt.
    const pf = this.frameOf(this.player.frame), pm = this.maskOf(this.player.frame);
    // A ship that is exploding or falling is not there to be hit, and nor is
    // one that has just come back -- see the note on `invuln`.
    const solid = this.player.state !== 'dying' && this.player.state !== 'wreck'
                  && this.player.state !== 'over' && this.player.invuln <= 0;
    if (pf && pm && solid) {
      const px = this.player.x / FP, py = this.player.y / FP;
      const touches = (o) => {
        const f = this.frameOf(o.sprite);
        return f && pairs(P.layer, P.hits, o.layer, o.hits) &&
               touch(P.layer, px, py, pf, pm, o.layer,
                     o.x / FP, o.y / FP, f, this.maskOf(o.sprite));
      };
      for (const b of this.drops)                         // pickups: collect, not die
        if (!b.dead && touches(b)) {
          b.dead = true; this.picked++;
          // The pickups are the one family that are standalone resources
          // rather than bank instruments: `base + 6 + (rnd & 3)`.
          if (this.onPickupSfx) this.onPickupSfx(this.rnd() & 3, b.x / FP);
          this.collect(b.item, b.arg);
        }
      // A shot that reaches you does not kill you, it wounds you: the hit is
      // symmetric (`sub_57a8`), so its +0x5c goes into the ship's damage
      // accumulator and the ship's goes into the shot's, which finishes it.
      for (const b of this.enemyShots)
        if (!b.dead && touches(b)) {
          b.dead = true;
          this.sfx('hurt', px);
          this.player.decay += b.damage || 1;
        }
      // And bodies that *do* pair with the ship. A fly does not -- see the
      // layer table -- but an asteroid is layer 0xc0, which the ship's 0x80
      // interest picks up, so the belt is the one place a collision hurts.
      for (const e of this.entities) {
        if (e.dead || e.exploding || !e.tpl.sprite) continue;
        if (!pairs(P.layer, P.hits, e.tpl.layer, e.tpl.hits)) continue;
        const gid = this.spriteOf(e), f = this.frameOf(gid);
        if (!f) continue;
        if (touch(P.layer, px, py, pf, pm, e.tpl.layer,
                  e.x / FP, e.y / FP, f, this.maskOf(gid))) {
          this.player.decay += e.tpl.hp || 1;
          e.decay += this.player.damage;              // symmetric, as always
          break;
        }
      }
    }

    // In place, not `filter`: these lists are held by the draw loop, and
    // replacing them each tick both allocated and left it holding stale arrays.
    compact(this.entities);
    compact(this.bullets);
    compact(this.drops);
    compact(this.enemyShots);
  }

  /**
   * Carry the run into the next level.
   *
   * `load_level` swaps the archive and nothing else: it is the same ship that
   * flies level 2, with the same rank, the same gun and the same purse. Only
   * where it is standing is reset.
   */
  carryOver(prev) {
    const P = this.data.player;
    this.player = prev.player;
    this.player.decay = 0;
    this.player.state = 'fly';
    this.player.frame = P.tiltMid;
    this.player.x = Math.round(P.x * FP);
    this.player.y = Math.round(P.y * FP);
    this.player.px = this.player.x; this.player.py = this.player.y;
    this.player.vx = this.player.vy = 0;
    this.score = prev.score;
    this.kills = prev.kills;
    this.picked = prev.picked;
    this.dropped = prev.dropped;
    this.markerSlots = prev.markerSlots.slice();
    this.rngState = prev.rngState;
    this.inFlight = 0;
    // A cheated run stays cheated for the rest of the game.
    this.cheated = prev.cheated;
  }

  /** Render-time position, blended between the last two ticks. */
  static lerp(e, alpha) {
    return [(e.px + (e.x - e.px) * alpha) / FP, (e.py + (e.y - e.py) * alpha) / FP];
  }

  /** The same, without the pair: a hot draw loop should not allocate. */
  static lerpX(e, alpha) { return (e.px + (e.x - e.px) * alpha) / FP; }
  static lerpY(e, alpha) { return (e.py + (e.y - e.py) * alpha) / FP; }
}
