/**
 * The high score table: ten rows, in this browser.
 *
 * The original has one -- `_HISCORE.LDC` -- and it is still on the list to
 * read. This is not it: it is the table the port keeps, in `localStorage`, so
 * that a run has somewhere to land before that archive is understood. When it
 * is, the two can be reconciled; the shape here (a name, a score, a date) is a
 * superset of what a 1997 table could hold.
 *
 * The date is the part worth saying out loud. A score with no date is a number;
 * a score with one is a thing that happened on an evening. It costs eight bytes
 * and it is the reason the table is worth looking at twice.
 */
import { readText, writeText } from './prefs.js';

export const SIZE = 10;
/** Long enough for " Cosmic Cuttlefish " and no longer: the column is `19ch`. */
export const NAME_MAX = 18;

/**
 * Ubuntu's release names, used as they are.
 *
 * Not a nod -- the scheme is genuinely the right one for this. An adjective and
 * an animal that alliterate is memorable, pronounceable, never accidentally
 * rude, and needs no seed from the player. Splitting the real list by first
 * letter and recombining within a letter generates names in the same scheme
 * rather than an imitation of it: " Bionic Badger " is not a release, but it is
 * indistinguishable from one.
 */
const RELEASES = [
  'Warty Warthog', 'Hoary Hedgehog', 'Breezy Badger', 'Dapper Drake',
  'Edgy Eft', 'Feisty Fawn', 'Gutsy Gibbon', 'Hardy Heron',
  'Intrepid Ibex', 'Jaunty Jackalope', 'Karmic Koala', 'Lucid Lynx',
  'Maverick Meerkat', 'Natty Narwhal', 'Oneiric Ocelot', 'Precise Pangolin',
  'Quantal Quetzal', 'Raring Ringtail', 'Saucy Salamander', 'Trusty Tahr',
  'Utopic Unicorn', 'Vivid Vervet', 'Wily Werewolf', 'Xenial Xerus',
  'Yakkety Yak', 'Zesty Zapus', 'Artful Aardvark', 'Bionic Beaver',
  'Cosmic Cuttlefish', 'Disco Dingo', 'Eoan Ermine', 'Focal Fossa',
  'Groovy Gorilla', 'Hirsute Hippo', 'Impish Indri', 'Jammy Jellyfish',
  'Kinetic Kudu', 'Lunar Lobster', 'Mantic Minotaur', 'Noble Numbat',
  'Oracular Oriole', 'Plucky Puffin', 'Questing Quokka', 'Resolute Raccoon',
];

const POOL = new Map();
for (const r of RELEASES) {
  const [adj, animal] = r.split(' ');
  const k = adj[0];
  if (!POOL.has(k)) POOL.set(k, { adj: [], animal: [] });
  POOL.get(k).adj.push(adj);
  POOL.get(k).animal.push(animal);
}
// Only letters that have both halves, which here is all of them.
const LETTERS = [...POOL.keys()];

const pick = (a) => a[Math.floor(Math.random() * a.length)];

/** An adjective and an animal that alliterate, in the scheme above. */
export function randomName() {
  const p = POOL.get(pick(LETTERS));
  return `${pick(p.adj)} ${pick(p.animal)}`;
}

/**
 * What a player typed, made fit to store.
 *
 * Whitespace collapsed, control characters dropped, and cut to the width of the
 * column it will be drawn in. Nothing here is about safety -- every one of
 * these ends up as `textContent` -- it is about a row that fits.
 */
export function clean(s) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * A fixed format rather than the browser's.
 *
 * `toLocaleDateString` would put the table into the reader's locale, which
 * sounds right and is not: every other word on this page is English set in one
 * mono face, and a row that reads " 13.09.2026 " in the middle of it looks like
 * a bug rather than a courtesy.
 */
export function dateOf(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Ten plausible rows, so the table is never an empty box. */
function seed() {
  const now = Date.now();
  const used = new Set();
  const rows = [];
  for (let i = 0; i < SIZE; i++) {
    let name = randomName();
    while (used.has(name)) name = randomName();
    used.add(name);
    rows.push({
      name,
      score: (SIZE - i) * 100,
      // Scattered through the past few months rather than all of one evening,
      // and deliberately modest: the point of the seed is to be beaten.
      at: now - Math.round((10 + Math.random() * 190) * 864e5),
    });
  }
  return rows;
}

const ok = (r) => r && typeof r.name === 'string' && Number.isFinite(r.score);

/** The table, seeded and written back the first time anyone asks for it. */
export function load() {
  const raw = readText('scores', '');
  if (raw) {
    try {
      const rows = JSON.parse(raw);
      if (Array.isArray(rows)) {
        const good = rows.filter(ok).slice(0, SIZE);
        if (good.length) return good;
      }
    } catch {
      // Someone else's key, or a half-written one. Start again rather than
      // show a broken table for ever.
    }
  }
  const rows = seed();
  save(rows);
  return rows;
}

function save(rows) {
  writeText('scores', JSON.stringify(rows));
}

/**
 * Is this run worth asking a name for?
 *
 * Strictly better than the last row, so a tie does not displace anyone: the
 * table belongs to whoever got there first. A scoreless run never qualifies,
 * however empty the table is.
 */
export function qualifies(score) {
  if (!Number.isFinite(score) || score <= 0) return false;
  const rows = load();
  return rows.length < SIZE || score > rows[rows.length - 1].score;
}

/** -> the row's place, 0-based, or -1 if it did not make it after all. */
export function add(name, score) {
  const rows = load();
  const row = { name: clean(name) || randomName(), score, at: Date.now() };
  rows.push(row);
  // Equal scores keep their order by date, oldest first, for the same reason
  // `qualifies` is strict.
  rows.sort((a, b) => b.score - a.score || a.at - b.at);
  rows.length = Math.min(rows.length, SIZE);
  save(rows);
  return rows.indexOf(row);
}

export const lastName = () => readText('name', '');
export const rememberName = (n) => writeText('name', clean(n));
