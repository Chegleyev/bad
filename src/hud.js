/**
 * The HUD: DOM panels around the field, not pixels on it.
 *
 * Grouped by what things mean rather than by where there is room. Everything
 * about the gun is in one panel, everything about the ship in the other, how
 * far through the level you are runs under the field itself, and the money sits
 * next to the shop it is for. Every number here is a real field of the
 * simulation.
 */
import { iconFit } from './icon.js';
import { pixIcon } from './pixicon.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** A labelled row with a value on the right and a strip of cells under it. */
function meter(label, cells, cls = '', ico = null) {
  const wrap = el('div', 'meter ' + cls);
  const head = el('div', 'meter-h');
  head.append(key(label, ico), el('span', 'v'));
  const bar = el('div', 'cells');
  for (let i = 0; i < cells; i++) bar.append(el('i'));
  wrap.append(head, bar);
  wrap.val = head.lastChild;
  wrap.cells = [...bar.children];
  return wrap;
}

/**
 * A chamfered panel. Two nested boxes with the same clip: the outer one is the
 * border colour, the inner one -- inset a pixel -- is the fill. Clipping a real
 * CSS border instead cuts its corners off, which is what the first pass did.
 */
function panel(name, tag, side, lamps = []) {
  const outer = el('aside', 'panel cut-' + side);
  const inner = el('div', 'panel-in');
  const h = el('div', 'panel-head');
  h.append(el('span', '', name), el('span', 'tag', tag));
  // Status lamps notched into the header's edges, the way an instrument panel
  // wears its indicators. They say nothing -- they are furniture.
  for (const [text, kind, edge] of lamps) h.append(led(text, kind, edge));
  for (const at of ['tl', 'tr', 'bl', 'br']) h.append(el('i', 'rivet ' + at));
  inner.append(h);
  outer.append(inner);
  outer.body = inner;
  return outer;
}

/** A label with its pixel icon beside it. */
function key(label, ico) {
  const k = el('span', 'k', label);
  const g = ico && pixIcon(ico, 1);   // one CSS pixel a cell: the height of the text
  if (g) k.append(g);
  return k;
}

/** A small indicator lamp with a caption, notched into an edge. */
function led(text, kind, edge) {
  const t = el('div', `led ${kind} ${edge}`);
  t.append(el('i'), el('span', '', text));
  return t;
}

function row(label, node, ico) {
  const wrap = el('div', 'meter');
  const h = el('div', 'meter-h');
  h.append(key(label, ico), el('span', 'v'));
  wrap.append(h, node);
  wrap.val = h.lastChild;
  return wrap;
}

function stack(label, node) {
  const s = el('div', 'stack');
  s.append(el('div', 'k', label), node);
  return s;
}

function readout(label, cls) {
  const r = el('div', 'readout ' + cls);
  const v = el('div', 'rv pix');
  r.append(el('div', 'k', label), v);
  r.v = v;
  return r;
}

const text = (node, s) => { if (node.textContent !== s) node.textContent = s; };

/** Attribute writes are cheap but not free, and most ticks change nothing. */
const flag = (node, on) => {
  const v = on ? '1' : '';
  if (node.dataset.on !== v) node.dataset.on = v;
};

/** The same, for any other data- attribute. */
const mark = (node, name, on) => {
  const v = on ? '1' : '';
  if (node.dataset[name] !== v) node.dataset[name] = v;
};

/** A bar, scaled rather than resized -- see the note on `.track` in the CSS. */
function scale(node, frac) {
  const v = Math.max(0, Math.min(1, frac));
  if (node._f === v) return;
  node._f = v;
  node.style.transform = `scaleX(${v})`;
}

function fill(m, on, of_, label) {
  for (let i = 0; i < m.cells.length; i++) {
    flag(m.cells[i], i < on);
    if (m.cells[i].hidden !== (i >= of_)) m.cells[i].hidden = i >= of_;
  }
  text(m.val, String(label === undefined ? on : label));
}

/** How many of the four damage upgrades this gun has taken. */
function powerSteps(base, now) {
  let n = 0, d = base;
  while (d < now && n < 4) { d = Math.min(base * 2, Math.floor(d * 1.25)); n++; }
  return n;
}

export class Hud {
  constructor(root, data, atlas) {
    this.data = data;
    this.atlas = atlas;
    this.P = data.player;
    const P = data.player;
    this.cache = {};

    // ---- left: the gun -------------------------------------------------
    const W = panel('WEAPON', '01', 'b', [['ARMED', 'ok', 'top']]);
    // Icon and name side by side: the name is what identifies the gun, the
    // icon only confirms it.
    this.gunIcon = el('div', 'gun-icon');
    this.gunName = el('div', 'gun-name');
    const gunRow = el('div', 'gun-row');
    gunRow.append(this.gunIcon, this.gunName);
    // Four segments each, because each of these really does have four steps:
    // the reload runs 7 down to 4 and the damage takes four upgrades to double.
    // The barrel count is not shown -- it is the gun, and the gun is named.
    this.rate = meter('RATE', 4, '', 'stopwatch');
    this.power = meter('POWER', 4, '', 'burst');
    // Ammo is the exception -- a round is one *projectile*, and a magazine
    // holds up to twelve, so it gets a pip apiece.
    this.ammo = meter('AMMO', 12, 'pips', 'round');
    const lbody = el('div', 'panel-body');
    lbody.append(gunRow, this.rate, this.power, this.ammo);
    W.body.append(lbody);

    this.score = readout('SCORE', 'big');

    // ---- right: the ship -----------------------------------------------
    const S = panel('SHIP', 'P1', 'a', [['SYS', 'ok', 'top']]);
    this.lives = el('div', 'lives');
    this.livesRow = row('LIVES', this.lives, 'heart');
    // One cell per hit point. The cap runs 11 to 43 -- eleven plus two a rank,
    // sixteen ranks -- so the strip is built for the most it can ever be and
    // the unused tail is hidden.
    this.hull = meter('HULL', P.hp + P.promoteHp * P.rankCap, 'hull', 'shield');
    // Rank is a numeral over a ladder of sixteen ticks -- the cap `sub_10ba`
    // clamps to -- rather than a numeral in a box.
    this.rank = meter('RANK', P.rankCap, 'ladder', 'chevrons');
    this.rankNum = el('span', 'rank-n pix');
    this.rank.val.replaceWith(this.rankNum);
    this.cond = meter('COND', 3, 'wide', 'bars');
    // Side speed has no ceiling in the game -- only a floor of 1.0 -- so the
    // scale is a chosen 1.0..4.0 and anything past it lights the last notch.
    this.speed = meter('SPEED', 7, 'notch', 'gauge');
    // Each slot is two boxes, like the panels: the outer one is the metal, the
    // inner one the face. A box-shadow ring can only be a flat colour, and flat
    // is what made these read as lilac rather than as metal.
    this.medals = el('div', 'medals');
    this.medalFaces = [];
    for (let i = 0; i < 6; i++) {
      const slot = el('i');
      const face = el('b');
      slot.append(face);
      this.medals.append(slot);
      this.medalFaces.push(slot);
    }
    this.medalRow = row('MEDALS', this.medals);
    const rbody = el('div', 'panel-body');
    rbody.append(this.livesRow, this.hull, this.rank, this.cond,
                 this.speed, this.medalRow);
    S.body.append(rbody);

    // ---- under the ship: the boss ---------------------------------------
    // Not in the original, which tells you nothing about what you are shooting.
    // A boss is several objects with separate hit points and only some of them
    // can be destroyed at all, and none of that is readable from the sprites.
    // `ok`, like the other two panels: there is no `warn` lamp in the sheet, so
    // LOCK wore the tag without the light in it.
    this.boss = panel('TARGET', '', 'a', [['LOCK', 'ok', 'top']]);
    this.boss.classList.add('boss');
    this.bossTag = this.boss.querySelector('.tag');
    this.boss.hidden = true;
    this.bossBody = el('div', 'panel-body boss-body');
    this.boss.body.append(this.bossBody);
    this.bossRows = [];
    this.bossKey = '';

    this.credits = readout('CREDITS', 'cr');
    this.shop = el('button', 'shop-btn');
    this.shop.title = 'Shop (B)';
    this.shop.append(el('span', 'shop-ico'), el('span', 'shop-label', 'Shop (B)'));
    // The button sits above the purse, and the purse keeps the bottom of the
    // column -- so it lines up with the score across the field.
    const money = el('div', 'money');
    money.append(this.shop, this.credits);

    // The ship reads on the left, the gun and the money it buys on the right.
    const left = el('div', 'col');
    left.append(S, this.boss, this.score);
    const right = el('div', 'col');
    right.append(W, money);

    const wrap = root.querySelector('.field-wrap');
    root.insertBefore(left, wrap);
    root.append(right);

    // ---- under the field: how far through the level --------------------
    this.progress = el('div', 'progress');
    this.progLabel = el('span', 'k', '');
    this.progTrack = el('div', 'track');
    this.progFill = el('i');
    this.progTrack.append(this.progFill);
    this.progPct = el('span', 'v');
    this.progress.append(this.progLabel, this.progTrack, this.progPct);
    wrap.append(this.progress);

    this.shopIcon();
  }

  /** Whoever owns the HUD says what the shop button does. */
  onShop(fn) { this.shop.addEventListener('click', fn); }

  /**
   * Point the HUD at another level. Every icon it shows is a crop out of that
   * level's atlas, so emptying the cache is what makes them redraw.
   */
  setLevel(data, atlas) {
    this.data = data;
    this.atlas = atlas;
    this.P = data.player;
    this.cache = {};
  }

  /**
   * The shop button's icon. The game has no such thing to borrow -- the credit
   * token is four pixels wide and reads as a smudge at this size -- so this is
   * a drawn one: a crate with a banded lid, in the same pixel grid as the rest.
   */
  shopIcon() {
    const g = pixIcon('dollar', 2);
    if (g) this.shop.firstChild.append(g);
  }

  /**
   * The boss readout. Rebuilt only when the cast changes -- which parts exist
   * and which core each belongs to -- and scaled every tick after that.
   */
  bossPanel(sim) {
    const parts = sim.entities.filter(e => e.tpl.type === 35 && !e.dead);
    if (!parts.length) {
      if (!this.boss.hidden) { this.boss.hidden = true; this.bossKey = ''; }
      return;
    }
    this.boss.hidden = false;
    // Cores in the order they arrived, then parts in bit order within each --
    // so the rows read left-to-right across the boss rather than by spawn time.
    const cores = [];
    for (const p of parts) if (p.parent && !cores.includes(p.parent)) cores.push(p.parent);
    parts.sort((a, b) => cores.indexOf(a.parent) - cores.indexOf(b.parent) ||
                         (a.tpl.bit || 0) - (b.tpl.bit || 0));
    const key = cores.length + ':' + parts.map(p => p.gid).join(',');
    if (key !== this.bossKey) {
      this.bossKey = key;
      this.bossBody.replaceChildren();
      this.bossRows = [];
      let at = -1;
      parts.forEach((p) => {
        const c = cores.indexOf(p.parent);
        // Only worth saying which half a part is when there are two of them.
        if (cores.length > 1 && c !== at) {
          at = c;
          this.bossBody.append(el('div', 'boss-grp', String.fromCharCode(65 + c)));
        }
        const r = el('div', 'boss-row');
        const ico = el('span', 'boss-ico');
        const cv = iconFit(this.data, this.atlas, p.tpl.sprite, 16, 14);
        if (cv) ico.append(cv);
        const track = el('div', 'track');
        const bar = el('i');
        track.append(bar);
        const n = el('span', 'boss-n');
        r.append(ico, track, n);
        this.bossBody.append(r);
        this.bossRows.push({ e: p, row: r, track, bar, n, max: p.tpl.hp || 1 });
      });
    }
    let left = 0;
    for (const r of this.bossRows) {
      // 65535 is not a number of hit points, it is "this one does not die" --
      // see the note on unsigned +0x5c. Saying so beats a bar that never moves.
      const immortal = r.max > 60000;
      const gone = r.e.wreck || r.e.dead;
      if (!gone && !immortal) left++;
      scale(r.bar, immortal ? 1 : gone ? 0 : Math.max(0, r.e.hp) / r.max);
      text(r.n, immortal ? '--' : gone ? '0' : String(Math.max(0, r.e.hp)));
      mark(r.track, 'low', !immortal && !gone && r.e.hp * 4 <= r.max);
      mark(r.row, 'gone', gone);
      mark(r.row, 'imm', immortal);
    }
    text(this.bossTag, String(left));
  }

  /** Swap an icon only when the sprite changed -- this runs every frame. */
  setIcon(host, key, gid, w, h) {
    if (this.cache[key] === gid) return;
    this.cache[key] = gid;
    host.replaceChildren();
    const c = iconFit(this.data, this.atlas, gid, w, h);
    if (c) host.append(c);
  }

  setLives(n) {
    if (this.cache.lives === n) return;
    this.cache.lives = n;
    this.lives.replaceChildren();
    const show = Math.min(n, 4);
    for (let i = 0; i < show; i++) {
      const c = iconFit(this.data, this.atlas, this.P.tiltMid, 22, 15);
      if (c) this.lives.append(c);
    }
    if (n > show) this.lives.append(el('span', 'more', '×' + n));
    text(this.livesRow.val, String(n));
  }

  update(sim) {
    const p = sim.player, P = this.P, g = p.gun;
    this.bossPanel(sim);

    // ---- the gun ----
    this.setIcon(this.gunIcon, 'gun', g.icon || g.barrels[0].frm, 26, 26);
    text(this.gunName, g.name || '');
    fill(this.rate, P.fireEvery - p.fireEvery + 1, 4);
    fill(this.power, powerSteps(g.damage, p.damage), 4, p.damage);
    fill(this.ammo, p.ammo, g.mag, `${p.ammo}/${g.mag}`);
    text(this.score.v, String(sim.score || 0).padStart(6, '0'));

    // ---- the ship ----
    this.setLives(p.lives);
    fill(this.hull, Math.max(0, p.hp), p.maxHp, `${Math.max(0, p.hp)}/${p.maxHp}`);
    const low = p.dignity === 1 ? '1' : '';
    if (this.hull.dataset.low !== low) this.hull.dataset.low = low;
    fill(this.rank, p.rank, P.rankCap, '');
    text(this.rankNum, String(p.rank));
    fill(this.cond, p.dignity, 3, '');
    fill(this.speed, Math.round((p.maxSpeed - P.sideMin) / P.sideStep) + 1, 7,
         p.maxSpeed.toFixed(1));
    let held = 0;
    for (let i = 0; i < 6; i++) {
      const on = (p.markers >> i) & 1;
      flag(this.medals.children[i], on);
      held += on;
    }
    text(this.medalRow.val, `${held}/6`);
    text(this.credits.v, String(p.credits * 10));

    // ---- how far through the level ----
    const done = 100 - (sim.progress ?? 99);
    text(this.progLabel, `LEVEL ${this.data.level.n}/8`);
    scale(this.progFill, done / 100);
    text(this.progPct, done + '%');
  }
}
