/**
 * Frame rate in the asteroid belt, across the render knobs.
 *
 *   npm run bench -- <port>        the dev server's port
 *
 * The belt is the worst case in the game: the biggest sprites, several at once.
 * Headless Chrome renders through SwiftShader, a *software* rasteriser, so the
 * absolute numbers mean nothing about a real GPU -- but the shape does: if the
 * frame rate tracks the drawing buffer size rather than the sprite count, the
 * cost is fill, not geometry.
 */
import puppeteer from 'puppeteer-core';
const port = process.argv[2] || '5173';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--headless=new','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--window-size=1440,900'],
});
// The defaults are the fast pair; the rest is what turning each one back off
// costs, so a regression shows up as the default losing to a variant.
for (const extra of ['', '&res=2', '&res=3', '&dpr=1', '&dpr=2']) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${port}/?nogates=1&tick=12200${extra}`, { waitUntil: 'networkidle0' });
  const r = await page.evaluate(async () => {
    const { sim, renderer } = window.dbg;
    sim.entities = sim.entities.filter(e => e.tpl.emitter || e.tpl.type === 14);
    if (!sim.entities.some(e => e.tpl.emitter)) {
      const id = Object.entries(sim.data.templates).find(([, t]) => t.emitter)[0];
      sim.spawn(Number(id));
    }
    for (const e of sim.entities) if (e.tpl.emitter) {
      e.density = 176; e.period = 16; e.speed = 2816; e.emitTimer = 4;
    }
    sim.player.lives = 99; sim.player.state = 'fly';
    await new Promise(r => setTimeout(r, 1200));
    let n = 0;
    const f = renderer.flush.bind(renderer);
    renderer.flush = (...a) => { n++; return f(...a); };
    const t0 = performance.now();
    await new Promise(r => setTimeout(r, 2500));
    const c = document.getElementById('field');
    return { fps: +(n * 1000 / (performance.now() - t0)).toFixed(0),
             buffer: `${c.width}x${c.height}`,
             rocks: sim.entities.filter(e => e.tpl.type === 14).length };
  });
  console.log((extra || '(default)').padEnd(14), JSON.stringify(r));
  await page.close();
}
await browser.close();
