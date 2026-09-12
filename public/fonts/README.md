# The display face

The big lettering — menu items, GAME OVER, the score readouts, the rank numeral
— is set in a pixel font rather than having scanlines drawn over a vector one.
Stripes painted over vector glyphs land wherever the rasteriser happens to put
them: at one zoom a line falls on the middle bar of an E and the letter turns to
mush, and it moves as the window resizes. A pixel face has the texture built in
and stays put.

**GoodLookingFont by Nuflux**, public domain, in place as `GoodLookingFont.ttf`.
The `@font-face` in `index.html` names that file exactly -- Windows does not
care about the case but a Linux host will, so keep the name as it is -- and
falls back to IBM Plex Mono if it ever goes missing.

The face is **unicase**: `CREDITS` and `credits` draw the same glyphs, and that
set mixes cap-height letters (H, G, N, E, W, A, M) with short rounded ones
(c, r, e, d, i, t, s). So `CREDITS` comes out looking lowercase next to
`HIGH SCORES`. That is the typeface, not a bug.

## A note on sizes

A pixel font only looks right at whole multiples of the size it was drawn at.
This one has em = 1000 with its cells on 100 units and advances of 200, 400,
600 and 800, so a cell is a whole number of screen pixels only at sizes that are
multiples of **ten**. `--pix-unit` in `:root` is 10 px for that reason, and the
display sizes are 20, 30 and 40 rather than the `clamp()` fluid sizes the rest
of the interface uses. Tracking is in whole pixels too: an `em` fraction lands
the next glyph on a half-pixel advance and fringes it just as badly.

If you swap the face for another, read its `unitsPerEm` and advances and set
`--pix-unit` to match; every display size follows from it.
