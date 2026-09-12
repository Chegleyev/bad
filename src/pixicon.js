/**
 * Small pixel icons, drawn as SVG rectangles on an integer grid.
 *
 * The game has no art for any of these -- a heart, a shield, a gauge -- so they
 * are drawn here rather than borrowed. SVG rather than a sprite sheet because
 * they have to sit inline with text at whatever size the label is, stay crisp
 * at any zoom, and take their colour from the CSS around them: `currentColor`
 * and the two tone slots do that for free.
 *
 * Legend: `.` transparent, `1` currentColor, `2` a dim tone, `3` a bright one.
 */
const ICONS = {
  heart: [
    '.11...11.',
    '111111111',
    '111111111',
    '111111111',
    '.1111111.',
    '..11111..',
    '...111...',
    '....1....',
  ],
  shield: [
    '111111111',
    '111111111',
    '111111111',
    '111111111',
    '.1111111.',
    '.1111111.',
    '..11111..',
    '...111...',
    '....1....',
  ],
  // Two chevrons, the way a rank is worn.
  chevrons: [
    '11.....11',
    '.11...11.',
    '..11.11..',
    '...111...',
    '....1....',
    '11.....11',
    '.11...11.',
    '..11.11..',
    '...111...',
  ],
  // Three rising bars: a condition meter.
  bars: [
    '......11',
    '......11',
    '...11.11',
    '...11.11',
    '11.11.11',
    '11.11.11',
    '11.11.11',
  ],
  // Two arrows, for side speed. A dial was the first try and at nine pixels
  // across it read as a rounded box: the needle is a single cell.
  gauge: [
    '1...1....',
    '11..11...',
    '111.111..',
    '1111.1111'.slice(0, 9),
    '111.111..',
    '11..11...',
    '1...1....',
  ],
  // A stopwatch, for the rate of fire.
  stopwatch: [
    '...111...',
    '..11111..',
    '.1.....1.',
    '1...1...1',
    '1...1...1',
    '1...111.1',
    '1.......1',
    '.1.....1.',
    '..11111..',
  ],
  // A cartridge, for the magazine.
  round: [
    '.111.',
    '11111',
    '11111',
    '11111',
    '1...1',
    '11111',
    '11111',
    '11111',
    '.111.',
  ],
  burst: [
    '....1....',
    '.1..1..1.',
    '..1.1.1..',
    '...111...',
    '11.111.11',
    '...111...',
    '..1.1.1..',
    '.1..1..1.',
    '....1....',
  ],
  // A dollar, for the shop. The game has no such art to borrow.
  dollar: [
    '...1...',
    '.11111.',
    '11.1.11',
    '11.1...',
    '.111...',
    '...111.',
    '...1.11',
    '11.1.11',
    '.11111.',
    '...1...',
  ],
  // A speaker, for the sound switch: the cone, then two arcs of sound.
  speaker: [
    '.....11..1.',
    '....111....',
    '...1111.1.1',
    '1111111.1.1',
    '1111111.1.1',
    '1111111.1.1',
    '...1111.1.1',
    '....111....',
    '.....11..1.',
  ],
  // The same with the arcs replaced by a cross.
  muted: [
    '.....11....',
    '....111....',
    '...1111....',
    '1111111.1.1',
    '1111111..1.',
    '1111111.1.1',
    '...1111....',
    '....111....',
    '.....11....',
  ],
  // The hi-res switch, as what it does: the same square drawn in few big
  // pixels and in many small ones.
  coarse: [
    '11111.....',
    '11111.....',
    '11111.....',
    '11111.....',
    '11111.....',
    '.....11111',
    '.....11111',
    '.....11111',
    '.....11111',
    '.....11111',
  ],
  fine: [
    '11..11..11',
    '11..11..11',
    '..11..11..',
    '..11..11..',
    '11..11..11',
    '11..11..11',
    '..11..11..',
    '..11..11..',
    '11..11..11',
    '11..11..11',
  ],
  crate: [
    '..111111..',
    '.11111111.',
    '1122222211',
    '1123333211',
    '1123333211',
    '1122222211',
    '1123333211',
    '1123333211',
    '.11111111.',
    '..111111..',
  ],
};

const NS = 'http://www.w3.org/2000/svg';

/**
 * -> an <svg> of the named icon, `px` pixels per cell.
 *
 * `1` becomes currentColor so an icon inherits the label's colour; `2` and `3`
 * are the dim and bright tones, defaulting to a wash of the same colour.
 */
export function pixIcon(name, px = 2, dim = 'currentColor', bright = 'currentColor') {
  const map = ICONS[name];
  if (!map) return null;
  const w = map[0].length, h = map.length;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', w * px);
  svg.setAttribute('height', h * px);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  const tone = { 1: 'currentColor', 2: dim, 3: bright };
  // One <rect> per run of equal cells, not per cell: a row of eight lit pixels
  // is one rectangle.
  map.forEach((row, y) => {
    let x = 0;
    while (x < w) {
      const c = row[x];
      let n = 1;
      while (x + n < w && row[x + n] === c) n++;
      if (tone[c]) {
        const r = document.createElementNS(NS, 'rect');
        r.setAttribute('x', x); r.setAttribute('y', y);
        r.setAttribute('width', n); r.setAttribute('height', 1);
        r.setAttribute('fill', tone[c]);
        svg.append(r);
      }
      x += n;
    }
  });
  return svg;
}
