# B.A.D.

[![Pages](https://github.com/Chegleyev/bad/actions/workflows/pages.yml/badge.svg)](https://github.com/Chegleyev/bad/actions/workflows/pages.yml)
[![Vite](https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white)](https://vite.dev)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?logo=javascript&logoColor=black)](https://developer.mozilla.org/docs/Web/JavaScript)
[![WebGL2](https://img.shields.io/badge/WebGL-2-990000?logo=webgl&logoColor=white)](https://developer.mozilla.org/docs/Web/API/WebGL2RenderingContext)
[![Web Audio](https://img.shields.io/badge/Web%20Audio-AudioWorklet-FF6F00)](https://developer.mozilla.org/docs/Web/API/AudioWorklet)
[![Runtime dependencies](https://img.shields.io/badge/runtime%20deps-none-2ea44f)](package.json)
[![License](https://img.shields.io/badge/code-MIT-blue)](LICENSE)

**English** · [Русский](README.ru.md)

A web remaster of **B.A.D. — Blasting, Annihilation & Destruction**, the 1997
DOS shoot-'em-up by Pseudos Software, published by Webfoot Technologies.

**[Play it](https://chegleyev.github.io/bad/)**

The original is hard to run on anything made this century. This is the same
game, rebuilt to open in a browser.

## Playing

Arrows or **WASD** to move, **Space** or **J** to fire.

| | |
| --- | --- |
| **B** | the shop, mid-level |
| **Esc** | pause |
| **M** | sound on and off |
| **H** | upscaled sprites on and off |

Both switches are also in the header, and both are remembered between visits.

## What it is

The simulation is transcribed from the original rather than reinterpreted:
fixed-point motion, the game's own collision silhouettes, and its **70.0863 Hz**
tick — the vertical retrace of the tweaked VGA mode every speed in the game is
denominated in. The renderer interpolates between ticks, so 60, 144 and 240 Hz
all look right and none of them change the game.

The shell around it is new. The menu, the HUD, the shop and the score table are
not ports of the original's — they keep its manner and nothing else.

Three things are settings a query string away:

* `?hi=1` turns off the upscaled sprites. They are baked at 2x by a pixel-art
  network and mixed back toward the hard nearest scale, so the dither survives.
* `?crt=0` takes off the scanline veil, `?crt=3` lays it on thickly. The default
  is 1.5, and the line pitch follows one row of the original's 350.
* `?stats=1` puts a counter line under the field -- tick, entities, shots,
  drops, frame rate. It is a developer's readout, off by default.

Three rules are deliberately not the original's:

* **" SIDE SPEED UP " stops at four times the starting speed.** `sub_1e8b` has
  no ceiling at all, and a long enough run ends with a ship that crosses the
  field faster than it can be aimed.
* **A pickup with nothing left to give is worth 50 credits.** A full magazine, a
  gun already at its damage cap, a reload at its floor, full hull, top speed —
  the original drops all of those on the floor. Being punished for doing well is
  not a mechanic worth preserving. The compensation is the game's own
  " 50 CREDITS " pickup, announced as such. Buying one in the shop still pays
  nothing back.

* **A homing missile sinks 0.225 of a pixel a tick.** `sub_37f9` has no such
  term — it is thirteen instructions of move-and-steer and nothing else — and
  without one the level 5 boss, which has two guns, is close to unanswerable.
  Searched over 3 351 dodge plans, counting the share that survive: one missile
  at base speed, 18%; two of them sixty ticks apart, 11% — and at twice the
  speed, still 12%. A missile that levels out at the ship's altitude runs along
  the rail at three pixels a tick, so going faster buys nothing. With the sink,
  averaged over twelve launch geometries, 24% of plans survive at base speed and
  37% at three and a half times it: still hard where the ship is slow, and speed
  now pays — which is what the speed a death costs you is supposed to mean.

## Build

    npm install
    npm run dev        # http://127.0.0.1:5173
    npm run build      # -> dist/
    npm run preview    # serve the build
    npm test           # the simulation, headless, no browser

Nothing but Node is needed: the decoded game data is in `public/data`.

## Licence, and the assets

The code is MIT — see [LICENSE](LICENSE).

The game's assets are not mine and are not covered by it. The art, music, sound,
level data and the name B.A.D. are Copyright © 1997 Pseudos Software and Webfoot
Technologies, Inc. They are decoded from the original release and are here for
preservation: free, no advertising, nothing to buy, no claim of ownership. If
you hold those rights and would rather this did not exist, say so and it comes
down.

No individual is named anywhere in the original's files — that was checked,
resource by resource, across every archive and every executable it shipped with.
If you worked on B.A.D., the credits screen has a seat waiting.
