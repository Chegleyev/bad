/**
 * The handful of settings that outlive a session.
 *
 * `localStorage` and nothing else. They belong to this browser rather than to a
 * save: which way the sound switch was left, which way the picture switch was,
 * the name last entered for a high score, and the table itself.
 *
 * Every access is guarded, and a throw means "the default" rather than "an
 * error". A private window, or a browser told to block site data, does not
 * return null from `getItem` -- it throws on the property itself, before there
 * is anything to read -- so both halves have to be inside the `try`.
 */
const key = (name) => `bad.${name}`;

/** -> the stored boolean, or `dflt` if there is none and if there cannot be. */
export function readPref(name, dflt) {
  try {
    const v = localStorage.getItem(key(name));
    return v === null ? dflt : v === 'on';
  } catch {
    return dflt;
  }
}

export function writePref(name, on) {
  try {
    localStorage.setItem(key(name), on ? 'on' : 'off');
  } catch {
    // Nowhere to put it. The setting still works for this session.
  }
}

/** The same guards, for anything that is not a boolean. */
export function readText(name, dflt = '') {
  try {
    const v = localStorage.getItem(key(name));
    return v === null ? dflt : v;
  } catch {
    return dflt;
  }
}

export function writeText(name, value) {
  try {
    localStorage.setItem(key(name), value);
  } catch {
    // As above: no store, no memory, but this session still works.
  }
}
