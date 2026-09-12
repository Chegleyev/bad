// Paste into the browser console on the running game to find out what the frame
// rate is actually limited by. It measures the same page three ways: drawing
// everything, drawing no sprites, and issuing no GL at all.
//
// If all three come out the same, rendering is not the limit -- the browser or
// the display is, and there is nothing left to win in the renderer.
// If "no GL at all" is much higher, the cost is in presenting the canvas, and
// a smaller backing store (?dpr=0.75, ?dpr=0.5) is the lever.
(async () => {
  const { renderer } = window.dbg;
  const draw = renderer.draw.bind(renderer), flush = renderer.flush.bind(renderer);
  const run = async (label, setup) => {
    setup();
    let n = 0;
    renderer.flush = (...a) => { n++; return flush(...a); };
    const t0 = performance.now();
    await new Promise(r => setTimeout(r, 3000));
    const fps = (n * 1000 / (performance.now() - t0)).toFixed(0);
    renderer.draw = draw; renderer.flush = flush;
    console.log(label.padEnd(16), fps, 'fps');
  };
  await run('everything', () => {});
  await run('no sprites', () => { renderer.draw = () => {}; });
  await run('no GL at all', () => { renderer.draw = () => {}; renderer.flush = null; });
  renderer.draw = draw; renderer.flush = flush;
})();
