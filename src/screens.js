/**
 * The screens that are not the game: the menu, the shop, and the end of it.
 *
 * All three live in the DOM, inside the field's frame, so they inherit the
 * scanlines and the border and sit exactly where the playfield does. The title
 * art is the original's own -- `_00LEVEL[2]`, first display-list command --
 * decoded from the player's archive at build time like every other asset here.
 */
import { iconFit } from './icon.js';
import { load as loadScores, dateOf, randomName, lastName, NAME_MAX } from './scores.js';

const text = (node, s) => { if (node.textContent !== s) node.textContent = s; };

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/**
 * The logo's lettering is green; everything else on this page is violet.
 *
 * Rather than repaint the art, the palette is rotated: anything whose hue sits
 * in the greens is swung to the violet the HUD uses, keeping its saturation and
 * lightness so the whole ramp -- highlight, body, shadow -- moves together. The
 * sun stays where it is, being orange.
 */
const VIOLET_HUE = 252;

function turn(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return [r, g, b];                   // grey has no hue to turn
  const d = max - min;
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  if (h < 75 || h > 190) return [r, g, b];             // not a green
  const l = (max + min) / 510;
  const sat = d / 255 / (1 - Math.abs(2 * l - 1) || 1);
  const c = (1 - Math.abs(2 * l - 1)) * sat, x = c * (1 - Math.abs((VIOLET_HUE / 60) % 2 - 1));
  const m = l - c / 2;
  const [rr, gg, bb] = VIOLET_HUE < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((rr + m) * 255), Math.round((gg + m) * 255), Math.round((bb + m) * 255)];
}

function recolour(pal) {
  return pal.map(([r, g, b]) => turn(r, g, b));
}

/**
 * The title, at both sizes, as one element that can be switched between them.
 *
 * The art is the one picture here that never went through the sprite atlas --
 * it is drawn on its own canvas -- so the level bake had to be taught about it
 * separately, and so does this. It follows the H switch like everything else:
 * a title that stayed smooth while the field went chunky was the one place the
 * setting visibly did not apply.
 *
 * The hue rotation is redone pixel by pixel on the baked one rather than
 * through the palette, because the net's output no longer has a palette.
 */
class Art {
  constructor(menu, bytes, base) {
    this.menu = menu;
    this.node = document.createElement('canvas');
    this.node.className = 'title-art';
    this.hard = document.createElement('canvas');
    this.hard.width = menu.w; this.hard.height = menu.h;
    const ctx = this.hard.getContext('2d');
    const img = ctx.createImageData(menu.w, menu.h);
    const pal = recolour(menu.palette);
    for (let i = 0; i < menu.w * menu.h; i++) {
      const idx = bytes[i];
      const o = i * 4;
      if (!idx) continue;                     // index 0 is the black behind it
      const [r, g, b] = pal[idx];
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    this.big = null;
    this.want = false;
    this.show();
    this.fetch(base);
  }

  /** Load the baked one, once. Absent -- nobody ran the baker -- is not an error. */
  fetch(base) {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, w, h);
      for (let o = 0; o < d.data.length; o += 4) {
        if (!d.data[o + 3]) continue;
        const [r, g, b] = turn(d.data[o], d.data[o + 1], d.data[o + 2]);
        d.data[o] = r; d.data[o + 1] = g; d.data[o + 2] = b;
      }
      ctx.putImageData(d, 0, 0);
      this.big = c;
      this.show();
    };
    img.src = `${base}data/menu4x.png`;
  }

  /** `on` is the H setting; without a baked picture it changes nothing. */
  setBig(on) { this.want = on; this.show(); }

  show() {
    const src = this.want && this.big ? this.big : this.hard;
    const c = this.node;
    if (c.width !== src.width || c.height !== src.height) {
      c.width = src.width; c.height = src.height;
    }
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(src, 0, 0);
    c.dataset.big = src === this.big ? '1' : '0';
  }
}

/** The title logo, as a canvas of the right size for the field it sits in. */
function art(menu, bytes, base = '') {
  const a = new Art(menu, bytes, base);
  const c = a.node;
  // Positioned and sized in the field's own coordinates; the CSS scales the
  // whole overlay with the canvas beside it.
  // Both axes explicitly: the field's pixels are not square, so letting the
  // height follow the canvas's own aspect stretches the logo half again.
  c.style.left = `${menu.x / menu.screen[0] * 100}%`;
  c.style.top = `${menu.y / menu.screen[1] * 100}%`;
  c.style.width = `${menu.w / menu.screen[0] * 100}%`;
  c.style.height = `${menu.h / menu.screen[1] * 100}%`;
  return a;
}

/**
 * The main menu. Three items; only the first does anything yet, and the other
 * two say so rather than pretending.
 */
export class Menu {
  constructor(host, menu, bytes, onStart, base = '', onScores = null,
              onCredits = null) {
    this.onStart = onStart;
    this.items = [
      { label: 'NEW GAME', run: onStart },
      { label: 'HIGH SCORES', run: onScores || undefined },
      { label: 'CREDITS', run: onCredits || undefined },
    ];
    this.at = 0;

    this.root = el('div', 'screen menu');
    this.art = art(menu, bytes, base);
    this.root.append(this.art.node);
    const list = el('nav', 'items');
    this.nodes = this.items.map((it, i) => {
      const b = el('button', 'item pix' + (it.run ? '' : ' off'), it.label);
      b.addEventListener('mouseenter', () => this.select(i));
      // Select first: `choose` runs whatever is selected, and a click that
      // arrives without a hover -- a tap, a scripted one -- would otherwise run
      // the item the keyboard happened to be on.
      b.addEventListener('click', () => { this.select(i); this.choose(); });
      list.append(b);
      return b;
    });
    this.root.append(list);
    this.root.append(el('div', 'hint', '↑↓ select · enter start'));
    host.append(this.root);
    this.select(0);
  }

  select(i) {
    this.at = (i + this.items.length) % this.items.length;
    this.nodes.forEach((n, k) => n.dataset.on = k === this.at ? '1' : '');
  }

  choose() {
    const it = this.items[this.at];
    if (it.run) it.run();
  }

  /** -> true if the key was ours. */
  key(code) {
    if (code === 'ArrowUp' || code === 'KeyW') { this.select(this.at - 1); return true; }
    if (code === 'ArrowDown' || code === 'KeyS') { this.select(this.at + 1); return true; }
    if (code === 'Enter' || code === 'Space' || code === 'NumpadEnter') {
      this.choose(); return true;
    }
    return false;
  }

  /** Follow the H switch, so the title is drawn the way the field is. */
  setBig(on) { this.art.setBig(on); }

  show(on) { this.root.hidden = !on; if (on) this.select(this.at); }
}

/**
 * How the catalogue is laid out. The game stores one flat price-ordered run;
 * grouping it is a reading decision, not data, so it lives here. Guns first --
 * they are what a run is really spent on.
 *
 * " SIDE SLOW DOWN " is left out: it is the only thing on the list you would
 * buy by accident and regret.
 */
const SECTIONS = [
  ['WEAPONS', [6, 15, 16, 17]],
  ['FIREPOWER', [0, 5, 2, 3]],
  ['SHIP', [1, 13, 14]],
  ['RANK', [7, 8, 9, 10, 11, 12]],
];
const NOT_FOR_SALE = new Set([4]);

/**
 * The shop, as a modal over a paused game.
 *
 * `sub_1c14` buys whatever the cursor points at: it runs the pickup's own
 * handler -- the same one a dropped prize would run -- and then takes the
 * price out of the purse. So buying and catching are the same act here too,
 * which is why this calls straight into `sim.collect`.
 *
 * The original walks its catalogue in place, during play, with the selection
 * skipping what you cannot afford. This stops the game instead: reading a
 * price list is not something to do while being shot at.
 */
export class Shop {
  constructor(host, data, atlas, onBuy, onClose) {
    this.data = data;
    this.atlas = atlas;
    this.onBuy = onBuy;
    this.onClose = onClose;
    // Sectioned, in the order above; anything the data has that the table does
    // not mention still gets a home rather than vanishing quietly.
    const byItem = new Map(data.player.shop.map(r => [r.item, r]));
    this.groups = [];
    for (const [title, items] of SECTIONS) {
      const rows = items.map(i => byItem.get(i)).filter(Boolean)
                        .sort((a, b) => a.price - b.price || a.item - b.item);
      rows.forEach(r => byItem.delete(r.item));
      if (rows.length) this.groups.push([title, rows]);
    }
    const rest = [...byItem.values()].filter(r => !NOT_FOR_SALE.has(r.item));
    if (rest.length) this.groups.push(['OTHER', rest]);
    this.rows = this.groups.flatMap(([, rows]) => rows);
    this.at = 0;

    this.root = el('div', 'screen shop');
    this.root.hidden = true;
    const head = el('div', 'shop-head');
    head.append(el('span', 'shop-title pix', 'SHOP'));
    this.balance = el('span', 'shop-bal pix', '0');
    head.append(this.balance);
    this.root.append(head);

    const list = el('nav', 'shop-list');
    this.nodes = [];
    for (const [title, rows] of this.groups) {
      list.append(el('div', 'shop-sect', title));
      for (const r of rows) {
        const i = this.nodes.length;
        const b = el('button', 'shop-row');
        const ico = el('span', 'shop-row-ico');
        const c = iconFit(data, atlas, r.icon, 26, 22);
        if (c) ico.append(c);
        // Six of these are the same prize with the same name; saying which is
        // which is the difference between a list and a wall.
        const marker = r.item >= 7 && r.item <= 12 ? ` ${r.item - 6}` : '';
        b.append(ico, el('span', 'shop-row-name', r.name + marker),
                 el('span', 'shop-row-have', ''),
                 el('span', 'shop-row-price pix', String(r.price * 10)));
        b.addEventListener('mouseenter', () => this.select(i));
        b.addEventListener('click', () => { this.select(i); this.buy(); });
        list.append(b);
        this.nodes.push(b);
      }
    }
    this.root.append(list);
    this.root.append(el('div', 'hint', '↑↓ select · enter buy · B or esc close'));
    host.append(this.root);
  }

  /**
   * Point the shop at another level. The catalogue is the same in all eight --
   * the prizes live in the common archive -- but each level's atlas packs them
   * at its own coordinates, so the icons have to be cut again.
   */
  setLevel(data, atlas) {
    this.data = data;
    this.atlas = atlas;
    this.rows.forEach((r, i) => {
      const ico = this.nodes[i].querySelector('.shop-row-ico');
      const c = iconFit(data, atlas, r.icon, 26, 22);
      ico.replaceChildren(...(c ? [c] : []));
    });
  }

  select(i) {
    this.at = (i + this.rows.length) % this.rows.length;
    this.nodes.forEach((n, k) => n.dataset.on = k === this.at ? '1' : '');
  }

  /** Redraw prices and affordability against the player's purse. */
  refresh(sim) {
    const p = sim.player;
    this.sim = sim;
    text(this.balance, `${p.credits * 10} CR`);
    this.rows.forEach((r, i) => {
      const n = this.nodes[i];
      const afford = p.credits >= r.price;
      if (n.dataset.off !== (afford ? '' : '1')) n.dataset.off = afford ? '' : '1';
      const held = r.item >= 7 && r.item <= 12 && ((p.markers >> (r.item - 7)) & 1);
      text(n.children[2], held ? 'HELD' : '');
    });
  }

  buy() {
    const r = this.rows[this.at];
    if (!this.sim || this.sim.player.credits < r.price) return;
    this.onBuy(r);
    this.refresh(this.sim);
  }

  /** -> true if the key was ours. */
  key(code) {
    if (code === 'ArrowUp' || code === 'KeyW') { this.select(this.at - 1); return true; }
    if (code === 'ArrowDown' || code === 'KeyS') { this.select(this.at + 1); return true; }
    if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') { this.buy(); return true; }
    if (code === 'KeyB' || code === 'Escape') { this.onClose(); return true; }
    return false;
  }

  show(on, sim) {
    this.root.hidden = !on;
    if (on) { this.select(this.at); this.refresh(sim); }
  }
}

const ORDINAL = ['1ST', '2ND', '3RD', '4TH', '5TH',
                 '6TH', '7TH', '8TH', '9TH', '10TH'];

/**
 * Asking for a name, which only happens when the run earned one.
 *
 * A form rather than a bare input, because a form gives Enter for nothing and
 * because a submit button is the only way this is reachable on a touchscreen.
 * The field starts on whatever was typed last time -- most runs are by the same
 * person at the same desk -- and if it is left empty a name is chosen in
 * Ubuntu's scheme rather than storing "ANONYMOUS" ten times.
 *
 * The suggestion in the placeholder is the name that will actually be used, not
 * an example of one: rolling a second name on submit would make the placeholder
 * a small lie.
 */
export class NameEntry {
  constructor(host, onDone) {
    this.onDone = onDone;
    this.root = el('div', 'screen names');
    this.root.hidden = true;
    this.title = el('div', 'over-title', 'NEW HIGH SCORE');
    this.place = el('div', 'name-place pix', '');
    this.form = el('form', 'name-form');
    this.input = el('input', 'name-input');
    this.input.maxLength = NAME_MAX;
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.setAttribute('aria-label', 'name for the high score table');
    this.form.append(this.input, el('button', 'item pix', 'ENTER'));
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    this.root.append(this.title, this.place, this.form,
                     el('div', 'hint', 'enter to confirm · leave it empty for the one shown'));
    host.append(this.root);
  }

  /** `place` is 0-based, and only used to say which line the run landed on. */
  show(on, score = 0, place = 0) {
    this.root.hidden = !on;
    if (!on) return;
    this.suggestion = randomName();
    this.input.placeholder = this.suggestion;
    this.input.value = lastName();
    this.place.textContent = `${ORDINAL[place] || ''} PLACE · ${score}`;
    // After the frame the screen becomes visible on, or the focus lands on a
    // field that is still `hidden` and goes nowhere.
    requestAnimationFrame(() => { this.input.focus(); this.input.select(); });
  }

  submit() {
    const name = this.input.value.trim() || this.suggestion;
    this.input.blur();
    this.onDone(name);
  }

  /** -> true if the key was ours. Everything is, while a field has the focus. */
  key(code) {
    if (code === 'Escape') { this.submit(); return true; }
    return true;
  }
}

/**
 * The table itself, reachable from the menu and shown after a name is entered.
 *
 * A narrow block rather than a row stretched across the field: a name and its
 * score belong next to each other. Everything reads off one left edge -- the
 * heading, the names, the dates -- with the place numbers hanging outside it in
 * the margin, which is both tidier than centring and, it turns out, the only
 * honest thing to do: the dates are wide and dim, so a block centred on its own
 * measure looks off-centre to the eye that is reading the names.
 *
 * The date goes under the name in small dim type. A score with no date is a
 * number; a score with one is a thing that happened on an evening.
 */
export class HighScores {
  constructor(host, onClose) {
    this.onClose = onClose;
    this.root = el('div', 'screen scores');
    this.root.hidden = true;
    const head = el('div', 'scores-head');
    head.append(el('span', 'shop-title pix', 'HIGH SCORES'));
    this.root.append(head);
    this.list = el('div', 'scores-list');
    this.root.append(this.list);
    this.root.append(el('div', 'hint', 'esc or click to go back'));
    this.root.addEventListener('click', (e) => {
      if (e.target.closest('.score-row')) return;      // a row is not a button
      this.onClose();
    });
    host.append(this.root);
  }

  /** `highlight` is the 0-based row just set, or -1. */
  show(on, highlight = -1) {
    this.root.hidden = !on;
    if (!on) return;
    const rows = loadScores();
    this.list.replaceChildren(...rows.map((r, i) => {
      const row = el('div', 'score-row');
      if (i === highlight) row.dataset.new = '1';
      row.append(el('span', 'score-rank', String(i + 1).padStart(2, '0')),
                 el('span', 'score-name', r.name),
                 el('span', 'score-n pix', String(r.score)),
                 el('span', 'score-date', dateOf(r.at)));
      return row;
    }));
  }

  /** -> true if the key was ours. */
  key(code) {
    if (code === 'Escape' || code === 'Enter' || code === 'NumpadEnter' ||
        code === 'Space' || code === 'KeyB') { this.onClose(); return true; }
    return false;
  }
}

/**
 * The credits, and why there is no list of people in them.
 *
 * There are no individual names in B.A.D. Not in the eight level archives, not
 * in `_RECORDS`, `_PSEUDOS` or `_PREVIEW`, not in `BAD.EXE`, not in
 * `README.DOC` or `ORDER.DOC`. A sweep of every resource in every archive for
 * anything that reads as English turns up the item names, the eighty-six
 * announcement lines, the sound-card error messages and two copyright notices,
 * and that is the whole of it. So the screen credits the two companies and
 * stops there rather than inventing a list.
 *
 * Everything quoted is quoted from the files, not from memory: "BAD 2.31" and
 * "(C) 1997 PSEUDOS" are at data:0x4be0 and data:0x4d26, and the publisher line
 * is `README.DOC`'s own wording.
 *
 * A row with no label is a note rather than an entry, and runs the full width.
 */
const CREDITS = [
  ['THE ORIGINAL', [
    ['B*A*D', 'Blasting, Annihilation & Destruction'],
    ['1997', 'version 2.31'],
    ['Written by', 'Pseudos Software'],
    ['Published by', 'Webfoot Technologies, Inc.'],
  ]],
  ['THIS REMASTER', [
    ['2026', 'by Discourage'],
    ['MIT', 'open, not monetised, taken down on request'],
    [null, 'I am endlessly grateful to the people who made the original for ' +
           'the hundreds of hours of thrill and delight it gave me as a ' +
           'teenager. It has become very hard to run on modern hardware, so I ' +
           'set out to rebuild it on technology that does.'],
  ]],
];

/**
 * The credits, laid out on the same left edge as the score table.
 *
 * Two columns: a short label and the thing it labels. The label is dim and the
 * value is bright, which is the opposite of a caption and the right way round
 * here -- what matters is the names, not the words "published by".
 */
export class Credits {
  constructor(host, onClose) {
    this.onClose = onClose;
    this.root = el('div', 'screen credits');
    this.root.hidden = true;
    const head = el('div', 'scores-head');
    head.append(el('span', 'shop-title pix', 'CREDITS'));
    this.root.append(head);
    const body = el('div', 'credits-body');
    for (const [title, rows] of CREDITS) {
      body.append(el('div', 'credits-sect', title));
      for (const [k, v] of rows) {
        if (k === null) { body.append(el('p', 'credits-note', v)); continue; }
        const row = el('div', 'credits-row');
        row.append(el('span', 'credits-k', k), el('span', 'credits-v', v));
        body.append(row);
      }
    }
    this.root.append(body);
    this.root.append(el('div', 'hint', 'esc or click to go back'));
    this.root.addEventListener('click', () => this.onClose());
    host.append(this.root);
  }

  show(on) { this.root.hidden = !on; }

  /** -> true if the key was ours. */
  key(code) {
    if (code === 'Escape' || code === 'Enter' || code === 'NumpadEnter' ||
        code === 'Space' || code === 'KeyB') { this.onClose(); return true; }
    return false;
  }
}

/**
 * The pause menu: two ways out, and Escape to change your mind.
 *
 * Nothing in the original -- it stops for the shop and for nothing else -- but
 * the moment the clock can be stopped at all, a game that cannot be put down
 * mid-level is just rude.
 */
export class Pause {
  constructor(host, onResume, onQuit) {
    this.items = [
      { label: 'CONTINUE', run: onResume },
      { label: 'MAIN MENU', run: onQuit },
    ];
    this.at = 0;
    this.root = el('div', 'screen pause');
    this.root.hidden = true;
    this.root.append(el('div', 'pause-title pix', 'PAUSED'));
    const list = el('nav', 'items');
    this.nodes = this.items.map((it, i) => {
      const b = el('button', 'item pix', it.label);
      b.addEventListener('mouseenter', () => this.select(i));
      b.addEventListener('click', () => { this.select(i); this.choose(); });
      list.append(b);
      return b;
    });
    this.root.append(list);
    this.root.append(el('div', 'hint', '↑↓ select · enter choose · esc resume'));
    host.append(this.root);
  }

  select(i) {
    this.at = (i + this.items.length) % this.items.length;
    this.nodes.forEach((n, k) => n.dataset.on = k === this.at ? '1' : '');
  }

  choose() { this.items[this.at].run(); }

  /** -> true if the key was ours. */
  key(code) {
    if (code === 'ArrowUp' || code === 'KeyW') { this.select(this.at - 1); return true; }
    if (code === 'ArrowDown' || code === 'KeyS') { this.select(this.at + 1); return true; }
    if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') { this.choose(); return true; }
    if (code === 'Escape') { this.items[0].run(); return true; }
    return false;
  }

  show(on) { this.root.hidden = !on; if (on) this.select(0); }
}

/** The end of a run: what you scored, and any key back to the menu. */
export class GameOver {
  constructor(host) {
    this.root = el('div', 'screen over');
    this.title = el('div', 'over-title pix', 'GAME OVER');
    this.root.append(this.title);
    this.score = el('div', 'over-score', '');
    this.root.append(this.score);
    this.hint = el('div', 'hint', 'press any key or click');
    this.root.append(this.hint);
    this.root.hidden = true;
    host.append(this.root);
  }

  /** Whoever owns the screen says what a click means. */
  onClick(fn) { this.root.addEventListener('click', fn); }

  show(on, score = 0, rank = 1, title = 'GAME OVER', hint = 'press any key or click') {
    this.root.hidden = !on;
    if (on) {
      this.title.textContent = title;
      this.hint.textContent = hint;
      this.score.replaceChildren(
        el('span', 'k', 'SCORE'), el('span', 'n pix', String(score).padStart(6, '0')),
        el('span', 'k', 'RANK'), el('span', 'n pix', String(rank)));
    }
  }
}
