/**
 * Load the game in headless Chrome, report anything the console says, and save
 * a screenshot of the canvas.
 *
 * Uses puppeteer-core against an already-installed Chrome rather than
 * downloading its own: nothing here needs a pinned browser build. Headless
 * Chrome has no GPU, so WebGL runs on SwiftShader -- slow, but it compiles the
 * same shaders and fails on the same mistakes, which is the point.
 *
 *   node scripts/shot.mjs [seconds] [outfile]
 */
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean);

const exe = CANDIDATES.find(p => existsSync(p));
if (!exe) { console.error('No Chrome or Edge found; set CHROME.'); process.exit(1); }

const seconds = Number(process.argv[2] ?? 3);
const out = process.argv[3] ?? 'out/shot.png';
const url = process.env.URL ?? 'http://127.0.0.1:5173/';
const tick = process.env.TICK ? `?tick=${process.env.TICK}` : '';

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  args: [
    '--headless=new',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',   // headless has no GPU; allow software WebGL
    '--window-size=1280,900',
    '--no-sandbox',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });

const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', r => logs.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
page.on('response', r => { if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`); });

const resp = await page.goto(url + tick, { waitUntil: 'load', timeout: 30000 });
console.log(`GET ${url}${tick} -> ${resp?.status()}`);

// KEYS=ArrowLeft,Space holds those down for the whole capture, so the shot can
// show the game being played rather than idling.
// The page opens on the menu now; a capture almost always wants the game.
await page.evaluate(() => new Promise(r => setTimeout(r, 300)));
if (await page.evaluate(() => document.body.dataset.screen === 'menu')) {
  await page.click('#stage').catch(() => {});
  await page.keyboard.press('Enter');
  await page.evaluate(() => new Promise(r => setTimeout(r, 200)));
}

const keys = (process.env.KEYS || '').split(',').filter(Boolean);
if (keys.length) await page.click('#stage').catch(() => {});   // key events need focus
for (const k of keys) await page.keyboard.down(k);
await new Promise(r => setTimeout(r, seconds * 1000));
for (const k of keys) await page.keyboard.up(k);

const info = await page.evaluate(() => {
  const c = document.getElementById('field');
  const gl = c?.getContext('webgl2');
  return {
    canvas: c ? [c.width, c.height] : null,
    webgl2: !!gl,
    renderer: gl ? gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info')
                                   ?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER) : null,
    stats: document.getElementById('stats')?.textContent,
  };
});
console.log('canvas   :', info.canvas);
console.log('webgl2   :', info.webgl2);
console.log('renderer :', info.renderer);
console.log('stats    :', info.stats);

mkdirSync(dirname(out), { recursive: true });
await page.screenshot({ path: out });
console.log(`screenshot -> ${out}`);

if (logs.length) { console.log('--- console ---'); logs.forEach(l => console.log(l)); }
await browser.close();
process.exit(logs.some(l => l.startsWith('[pageerror]') || l.startsWith('[error]')) ? 1 : 0);
