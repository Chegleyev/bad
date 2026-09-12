/**
 * WebGL2 sprite batch that keeps the original's indexed colour.
 *
 * The atlas is uploaded as a single-channel texture of *palette indices*, and
 * the palette as a 256x1 RGBA texture the shader looks up. That is not
 * nostalgia: index 0 is the game's transparency, and the palette is the thing
 * the original fades by ramping the DAC, so keeping the indirection means fades
 * and palette swaps stay exact instead of being approximated in RGB.
 */
const VS = `#version 300 es
in vec2 aPos; in vec2 aUV; in float aSrc;
uniform vec2 uField;          // field size in the buffer's own pixels
out vec2 vUV;
flat out float vSrc;          // 0 = the index atlas, 1 = the baked one
void main() {
  vec2 p = aPos / uField * 2.0 - 1.0;
  gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
  vUV = aUV;                  // already normalised on the way in
  vSrc = aSrc;
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUV;
flat in float vSrc;
uniform highp usampler2D uAtlas;
uniform sampler2D uPal;
uniform sampler2D uBig;       // the upscaled sprites, already RGBA
uniform float uFade;
out vec4 fragColor;
void main() {
  // Two atlases, one pass. Splitting them into two draw calls would have been
  // simpler and would have broken the draw order: a baked boss would sort
  // above or below everything unbaked rather than where it belongs.
  if (vSrc > 0.5) {
    vec4 c = texture(uBig, vUV);
    if (c.a < 0.5) discard;                     // the cutout stayed hard
    fragColor = vec4(c.rgb * uFade, 1.0);
    return;
  }
  uint idx = texture(uAtlas, vUV).r;
  if (idx == 0u) discard;                       // index 0 is transparent
  vec3 rgb = texelFetch(uPal, ivec2(int(idx), 0), 0).rgb;
  fragColor = vec4(rgb * uFade, 1.0);
}`;

// The field is composed at its own 320x350 and blown up once, with a single
// quad, at the end. Drawing the sprites straight onto a 2000x1500 canvas made
// the cost of a frame depend on the window: every sprite quad was rasterised at
// the upscaled size, through a fragment shader that `discard`s -- which is the
// slow path -- and a 26x larger drawing buffer cost about a third of the frame
// rate. This way the sprite work is fixed at 112 000 pixels however big the
// window is, and the only full-size pass is one textured quad with no discard.
const BLIT_VS = `#version 300 es
out vec2 vUV;
void main() {
  // A single oversized triangle; no vertex buffer needed.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSrc;
out vec4 fragColor;
void main() { fragColor = texture(uSrc, vUV); }`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export class Renderer {
  constructor(canvas, data, atlasBytes, opts = {}) {
    const gl = this.gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,             // no compositing against the page behind it
      depth: false,             // nothing here is depth tested
      stencil: false,
      preserveDrawingBuffer: false,
      // On a laptop with switchable graphics this is what picks the discrete
      // GPU rather than the integrated one.
      powerPreference: 'high-performance',
      // Let the canvas present without waiting on the page compositor. Safe
      // here because nothing ever reads the drawing buffer back.
      desynchronized: true,
    });
    if (!gl) throw new Error('WebGL2 is required');
    this.data = data;
    // `?fbo=1` composes at 320x350 and upscales once, which bounds the sprite
    // work however big the window is. It was expected to make a HiDPI backing
    // store affordable; measured, it does not -- at dpr 2 it moved the belt
    // from 55 fps to 60, and at dpr 1 it measured neutral. So whatever the
    // frame is spent on, it is not rasterising sprites, and the extra pass is
    // off by default. The path is kept: a post-process (a CRT curve, a palette
    // effect) would need to render into a buffer anyway.
    this.wantFbo = opts.fbo === true;
    this.useFbo = this.wantFbo;

    const prog = this.prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.uField = gl.getUniformLocation(prog, 'uField');
    this.uFade = gl.getUniformLocation(prog, 'uFade');
    gl.uniform1i(gl.getUniformLocation(prog, 'uAtlas'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'uPal'), 1);
    gl.uniform1i(gl.getUniformLocation(prog, 'uBig'), 3);
    // How many buffer pixels to a field pixel. Baked sprites only show at more
    // than one, and at more than one the whole field has to be composed there,
    // so the framebuffer path stops being optional.
    this.scale = Math.max(1, Math.min(4, opts.scale || 1));
    if (this.scale > 1) this.useFbo = true;
    this.invAtlas = [1 / data.atlas.w, 1 / data.atlas.h];
    this.big = null;

    const a = data.atlas;
    this.atlasTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, a.w, a.h, 0, gl.RED_INTEGER,
                  gl.UNSIGNED_BYTE, atlasBytes);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
      gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);

    const pal = new Uint8Array(256 * 4);
    data.palette.forEach(([r, g, b], i) => pal.set([r, g, b, 255], i * 4));
    this.palTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.palTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pal);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
      gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const stride = 20;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 16);
    this.verts = new Float32Array(4096 * 6 * 5);
    // Sized once. `bufferData` every frame asks the driver for a fresh store
    // each time; `bufferSubData` into a store this big never does.
    gl.bufferData(gl.ARRAY_BUFFER, this.verts.byteLength, gl.DYNAMIC_DRAW);
    this.n = 0;

    // ---- the field buffer and the quad that shows it -------------------
    this.fbo = gl.createFramebuffer();
    this.makeField();

    const blit = this.blit = gl.createProgram();
    gl.attachShader(blit, compile(gl, gl.VERTEX_SHADER, BLIT_VS));
    gl.attachShader(blit, compile(gl, gl.FRAGMENT_SHADER, BLIT_FS));
    gl.linkProgram(blit);
    if (!gl.getProgramParameter(blit, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(blit));
    gl.useProgram(blit);
    gl.uniform1i(gl.getUniformLocation(blit, 'uSrc'), 2);
    this.blitVao = gl.createVertexArray();     // empty, but one must be bound
  }

  /**
   * Point the renderer at another level. Each archive has its own atlas and its
   * own 256 colours, and nothing else about the pipeline changes -- the field
   * is 320x350 in all eight.
   */
  setLevel(data, atlasBytes) {
    const gl = this.gl;
    this.data = data;
    this.invAtlas = [1 / data.atlas.w, 1 / data.atlas.h];
    const a = data.atlas;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, a.w, a.h, 0, gl.RED_INTEGER,
                  gl.UNSIGNED_BYTE, atlasBytes);
    const pal = new Uint8Array(256 * 4);
    data.palette.forEach(([r, g, b], i) => pal.set([r, g, b, 255], i * 4));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.palTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pal);
  }

  begin(fade = 1) {
    this.n = 0;
    this.fade = fade;
  }

  /** Queue one sprite. x, y are field pixels; the sprite's top-left corner. */
  /**
   * `frame` is the sprite's rect in the index atlas and fixes where and how big
   * it is; `big`, when the baked atlas has this sprite, is where to read the
   * pixels from instead. Both draw to the same place at the same size -- the
   * baked one just has sixteen times as many pixels to say it with.
   */
  draw(frame, x, y, big) {
    if (!frame) return;
    const v = this.verts;
    let o = this.n * 30;
    if (o + 30 > v.length) return;
    const S = this.scale;
    const x1 = Math.round(x) * S, y1 = Math.round(y) * S;
    const x2 = x1 + frame.w * S, y2 = y1 + frame.h * S;
    // Normalised here rather than in the shader: there are two atlases now and
    // they are different sizes, so the divisor cannot be a uniform.
    const src = big || frame;
    const inv = big ? this.big.inv : this.invAtlas;
    const f = big ? 1 : 0;
    const u = src.x * inv[0], t = src.y * inv[1];
    const u2 = (src.x + src.w) * inv[0], t2 = (src.y + src.h) * inv[1];
    // Written straight into the buffer: the array literal this used to build
    // was one allocation per sprite per frame.
    v[o] = x1; v[o + 1] = y1; v[o + 2] = u; v[o + 3] = t; v[o + 4] = f;
    v[o + 5] = x2; v[o + 6] = y1; v[o + 7] = u2; v[o + 8] = t; v[o + 9] = f;
    v[o + 10] = x1; v[o + 11] = y2; v[o + 12] = u; v[o + 13] = t2; v[o + 14] = f;
    v[o + 15] = x2; v[o + 16] = y1; v[o + 17] = u2; v[o + 18] = t; v[o + 19] = f;
    v[o + 20] = x2; v[o + 21] = y2; v[o + 22] = u2; v[o + 23] = t2; v[o + 24] = f;
    v[o + 25] = x1; v[o + 26] = y2; v[o + 27] = u; v[o + 28] = t2; v[o + 29] = f;
    this.n++;
  }

  /**
   * (Re)make the buffer the field is composed into, at the current scale.
   *
   * A texture cannot be resized, so this makes a new one and hangs it off the
   * same framebuffer. Called once at startup and again whenever the scale is
   * turned up or down, which is why it is a method and not inline.
   */
  makeField() {
    const gl = this.gl;
    this.field = [this.data.screen[0] * this.scale, this.data.screen[1] * this.scale];
    if (this.fieldTex) gl.deleteTexture(this.fieldTex);
    this.fieldTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.field[0], this.field[1], 0,
                  gl.RGBA, gl.UNSIGNED_BYTE, null);
    // NEAREST at 1:1, where the point is that a pixel stays a pixel. Above
    // that the buffer is larger than the window it lands in, and dropping
    // pixels on the way down is worse than not having drawn them: the final
    // blit resamples instead.
    const filt = this.scale > 1 ? gl.LINEAR : gl.NEAREST;
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
      gl.texParameteri(gl.TEXTURE_2D, p, filt);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
      gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D,
                            this.fieldTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Change how many buffer pixels go to a field pixel, mid-game.
   *
   * The baked sprites are only worth reading at more than 1:1 -- at 1:1 they
   * would be a 4x picture sampled down by NEAREST, which is worse than the
   * hard sprite it replaced -- so the same switch decides whether the big
   * atlas is consulted at all. The bitmap stays uploaded either way: turning
   * the mode off and on again should not refetch four megabytes.
   */
  setScale(s) {
    s = Math.max(1, Math.min(4, s | 0));
    if (s === this.scale) return;
    this.scale = s;
    this.useFbo = s > 1 || this.wantFbo;
    this.makeField();
  }

  /**
   * Hand over the baked sprites: an `ImageBitmap` of the 4x atlas and the table
   * saying where each sprite id sits in it.
   */
  setBig(bitmap, meta) {
    const gl = this.gl;
    if (!this.bigTex) this.bigTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.bigTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
      gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
      gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    this.big = { frames: meta.frames, inv: [1 / meta.w, 1 / meta.h] };
  }

  /** The baked rect for a sprite id, or undefined if it was left hard. */
  bigOf(gid) {
    return this.big && this.scale > 1 ? this.big.frames[gid] : undefined;
  }

  flush(canvasW, canvasH) {
    const gl = this.gl;

    // 1. the sprites -- at the field's own resolution, or straight onto the
    //    canvas when the framebuffer path is turned off
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.useFbo ? this.fbo : null);
    if (this.useFbo) gl.viewport(0, 0, this.field[0], this.field[1]);
    else gl.viewport(0, 0, canvasW, canvasH);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.n) {
      gl.useProgram(this.prog);
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.verts, 0, this.n * 30);
      gl.uniform2f(this.uField, this.field[0], this.field[1]);
      gl.uniform1f(this.uFade, this.fade);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.palTex);
      if (this.bigTex) { gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.bigTex); }
      gl.drawArrays(gl.TRIANGLES, 0, this.n * 6);
    }

    // 2. and that buffer, once, at whatever size the window is
    if (!this.useFbo) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasW, canvasH);
    gl.useProgram(this.blit);
    gl.bindVertexArray(this.blitVao);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
