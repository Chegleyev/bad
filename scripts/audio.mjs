/**
 * Headless check that the mixer is making sound.
 *
 * An AnalyserNode tap reads nothing in headless Chrome -- there is no device
 * pulling the graph the way a speaker does -- so the number that matters is the
 * one the worklet reports about its own output.
 *
 *   node scripts/audio.mjs <port>
 */
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,
  args:['--headless=new','--autoplay-policy=no-user-gesture-required']});
const p = await b.newPage();
const errs=[]; p.on('pageerror', e=>errs.push(e.message)); p.on('console', m=>{ if(m.type()==='error') errs.push(m.text()); });
await p.goto(`http://127.0.0.1:${process.argv[2]}/?tick=1000`, {waitUntil:'networkidle0'});
await new Promise(r=>setTimeout(r,2000));
console.log(await p.evaluate(async () => {
  const a = globalThis.dbgAudio;
  if (!a || !a.ctx) return { error: 'no context' };
  // Tap the live graph and measure what is actually coming out.
  const an = a.ctx.createAnalyser();
  an.fftSize = 2048;
  a.node.connect(an);
  const buf = new Float32Array(an.fftSize);
  let peak = 0, sum = 0, n = 0;
  for (let k = 0; k < 40; k++) {
    await new Promise(r => setTimeout(r, 25));
    an.getFloatTimeDomainData(buf);
    for (const v of buf) { const x = Math.abs(v); if (x > peak) peak = x; sum += x * x; n++; }
  }
  const ask = () => new Promise(res => { a.node.port.onmessage = e => res(e.data.stat);
                                        a.node.port.postMessage({ cmd: 'stat' }); });
  // Order 0 is sparse; the tune the level actually opens on is order 16.
  a.node.port.postMessage({ cmd: 'play', n: 17 });
  await new Promise(r => setTimeout(r, 4000));
  const stat = await ask();
  return { tapPeak: +peak.toFixed(4), tapRms: +Math.sqrt(sum / n).toFixed(4),
           mixerPeak: stat.peak, fxPeak: stat.fxPeak, blocks: stat.blocks, ctx: a.ctx.state,
           bank: stat.has, playing: stat.playing, order: stat.order, row: stat.row,
           on: stat.voices.filter(v => v.on).length,
           vols: stat.voices.map(v => v.vol).join(','),
           effects: Object.fromEntries(Object.entries(stat.effects)
             .sort((a, b) => b[1] - a[1])
             .map(([k, n]) => ['0x' + (+k).toString(16), n])) };
}));
console.log('errors', errs.slice(0,4));
await b.close();
