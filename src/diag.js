/**
 * `?diag=1`: what this browser can actually do, printed on the page.
 *
 * For a report from a machine nobody here has. The renderer keeps the original
 * in indexed colour -- a single-channel texture of palette indices read through
 * a `usampler2D`, with a `flat` integer-ish varying picking which atlas a
 * vertex came from -- which is the least travelled corner of WebGL2 and the
 * first thing to suspect when a driver renders nothing. So this does not ask
 * the browser what it supports; it compiles that exact shader, uploads that
 * exact texture format, draws one quad and reads the pixel back.
 */
const rows = [];
const say = (k, v) => rows.push([k, String(v)]);

function probeIndexedPath() {
  const c = document.createElement('canvas');
  c.width = c.height = 2;
  const gl = c.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });
  if (!gl) return 'no WebGL2 context at all';
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  if (dbg) say('gpu', gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
  say('gl version', gl.getParameter(gl.VERSION));
  say('glsl', gl.getParameter(gl.SHADING_LANGUAGE_VERSION));

  const vs = `#version 300 es
in vec2 aPos; out vec2 vUV; flat out float vSrc;
void main() { vUV = aPos * 0.5 + 0.5; vSrc = 0.0; gl_Position = vec4(aPos, 0.0, 1.0); }`;
  const fs = `#version 300 es
precision highp float;
in vec2 vUV; flat in float vSrc;
uniform highp usampler2D uAtlas;
uniform sampler2D uPal;
out vec4 fragColor;
void main() {
  uint i = texture(uAtlas, vUV).r;
  fragColor = vec4(texture(uPal, vec2((float(i) + 0.5) / 256.0, 0.5)).rgb, 1.0);
}`;
  const make = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, make(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, make(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (err) {
    return `the indexed-colour shader will not build here: ${err.message}`;
  }
  gl.useProgram(prog);

  // a 1x1 index texture holding 7, and a palette whose entry 7 is pure green
  const atlas = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, atlas);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, 1, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array([7]));
  for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
  const pal = new Uint8Array(256 * 4);
  pal[7 * 4 + 1] = 255; pal[7 * 4 + 3] = 255;
  const palTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, palTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pal);
  for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
  gl.uniform1i(gl.getUniformLocation(prog, 'uAtlas'), 0);
  gl.uniform1i(gl.getUniformLocation(prog, 'uPal'), 1);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.viewport(0, 0, 2, 2);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const px = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const err = gl.getError();
  if (err) return `drew, but GL reported error ${err}`;
  const green = px[0] < 40 && px[1] > 200 && px[2] < 40;
  return green ? 'works: the index came back through the palette'
               : `drew the wrong colour: rgba(${px.join(',')}), expected green`;
}

export function diagnose() {
  say('page', location.href);
  say('agent', navigator.userAgent);
  say('platform', navigator.platform || '(none reported)');
  say('device pixel ratio', devicePixelRatio);
  say('hardware threads', navigator.hardwareConcurrency || '?');
  let verdict;
  try { verdict = probeIndexedPath(); } catch (err) { verdict = `threw: ${err.message}`; }
  say('indexed-colour path', verdict);
  say('AudioWorklet', typeof AudioWorklet !== 'undefined' ? 'yes' : 'NO');
  say('AudioContext', typeof AudioContext !== 'undefined' ? 'yes' : 'NO');
  say('createImageBitmap', typeof createImageBitmap === 'function' ? 'yes' : 'NO');
  say('fetch streaming', typeof ReadableStream === 'function' ? 'yes' : 'NO');
  say('WebGL2', typeof WebGL2RenderingContext !== 'undefined' ? 'yes' : 'NO');

  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;inset:0;z-index:99;margin:0;padding:24px;overflow:auto;'
    + 'background:#0b0a12;color:#EFEFF4;font:400 12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;'
    + 'white-space:pre-wrap;word-break:break-word';
  const w = Math.max(...rows.map(([k]) => k.length));
  pre.textContent = 'B.A.D. — what this browser can do\n\n'
    + rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`).join('\n')
    + '\n\nSend this whole page as a screenshot.';
  document.body.append(pre);
}
