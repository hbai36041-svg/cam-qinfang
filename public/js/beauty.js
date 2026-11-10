// Real-time beauty filter (skin smoothing + brightening) — designed to never flicker.
//
// Why beauty filters usually flicker, and what this file does about each cause:
//  1. Canvas captured while half-drawn / just cleared  -> captureStream(0) + track.requestFrame()
//     only AFTER a complete draw; preserveDrawingBuffer so the buffer is never blanked.
//  2. Transparent pixels encoded as black                -> WebGL context with alpha:false, alpha forced to 1.
//  3. Drawing before the camera has a frame              -> skip draws until readyState>=2; the output
//     track is handed out only after the first real frame was rendered.
//  4. Track swapped / pipeline rebuilt on every slider    -> sliders only update uniforms; one pipeline.
//  5. Canvas resized every frame                          -> resize only when the source size changes,
//     and redraw in the same task before requesting the frame.
//  6. rAF stops in background tabs (remote sees freezes)  -> requestVideoFrameCallback while visible,
//     a Worker-driven ticker while hidden.
//  7. Local preview flashing when srcObject changes       -> the preview shows this canvas directly.
//  8. GPU context loss                                    -> 'lost' event so the app falls back to the raw camera.

const VERT = `attribute vec2 p; varying vec2 v; void main(){ v = p*0.5+0.5; gl_Position = vec4(p,0.0,1.0); }`;
const FRAG = `
precision mediump float;
uniform sampler2D u_tex; uniform vec2 u_px; uniform float u_smooth; uniform float u_bright;
varying vec2 v;
float skin(vec3 c){
  float y  = dot(c, vec3(0.299,0.587,0.114));
  float cb = (c.b - y)*0.564 + 0.5;
  float cr = (c.r - y)*0.713 + 0.5;
  float m = smoothstep(0.26,0.32,cb)*(1.0-smoothstep(0.50,0.56,cb))*smoothstep(0.50,0.55,cr)*(1.0-smoothstep(0.68,0.74,cr));
  return m*smoothstep(0.10,0.22,y);
}
void main(){
  vec3 c = texture2D(u_tex, v).rgb;
  vec3 outc = c;
  if (u_smooth > 0.001) {
    float r = 1.5 + 5.0*u_smooth;
    vec3 sum = c; float ws = 1.0;
    for (int i = 0; i < 16; i++) {
      float fi = float(i);
      float a = fi*0.7854 + (fi >= 8.0 ? 0.3927 : 0.0);
      float rr = fi >= 8.0 ? r*2.0 : r;
      vec3 s = texture2D(u_tex, v + vec2(cos(a), sin(a))*rr*u_px).rgb;
      vec3 d = s - c;
      float w = exp(-dot(d,d)*60.0);           // edge-preserving (bilateral) weight
      sum += s*w; ws += w;
    }
    vec3 blur = sum/ws;
    float m = skin(c)*u_smooth;
    outc = mix(c, blur, clamp(m*1.1, 0.0, 0.92));
    outc += (c - blur)*0.12*m;                  // keep a little texture so skin does not look plastic
  }
  if (u_bright > 0.001) {
    vec3 screen = 1.0 - (1.0-outc)*(1.0-outc);
    outc = mix(outc, screen, u_bright*0.55);
  }
  gl_FragColor = vec4(clamp(outc,0.0,1.0), 1.0);
}`;

// Built-in processor. A professional SDK plugs in with the same three methods.
class GLProcessor {
  constructor() { this.name = 'builtin'; }
  init(canvas) {
    const gl = canvas.getContext('webgl', { alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('webgl unavailable');
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    this.gl = gl;
    this.u = { px: gl.getUniformLocation(prog, 'u_px'), smooth: gl.getUniformLocation(prog, 'u_smooth'), bright: gl.getUniformLocation(prog, 'u_bright') };
  }
  process(video, canvas, params) {
    const gl = this.gl;
    if (gl.isContextLost()) return false;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
    gl.uniform2f(this.u.px, 1 / canvas.width, 1 / canvas.height);
    gl.uniform1f(this.u.smooth, params.smooth);
    gl.uniform1f(this.u.bright, params.bright);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }
  destroy() { try { this.gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch {} }
}

// ---- Professional SDK hook ------------------------------------------------
// Register e.g. FaceUnity / 火山引擎 / Banuba web SDK adapters:
//   window.CAMBeauty.register({
//     name: 'faceunity', label: 'FaceUnity',
//     async init(canvas) { ... load SDK, bind to canvas ... },
//     process(video, canvas, { smooth, bright }) { ... draw one frame into canvas ...; return true },
//     destroy() { ... }
//   })
const registry = new Map([['builtin', () => new GLProcessor()]]);
export function registerProcessor(p) {
  if (!p?.name || typeof p.process !== 'function') throw new Error('processor needs name + process()');
  registry.set(p.name, () => p);
  document.dispatchEvent(new CustomEvent('beauty-processors'));
}
export const processors = () => [...registry.keys()];
window.CAMBeauty = { register: registerProcessor, list: processors };

export class BeautyEngine extends EventTarget {
  constructor(processorName = 'builtin') {
    super();
    this.params = { smooth: 0.5, bright: 0.3 };
    this.processorName = registry.has(processorName) ? processorName : 'builtin';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'beauty-canvas';
    this.canvas.width = 1280; this.canvas.height = 720;
    // Source <video> stays in the DOM (visually hidden) so requestVideoFrameCallback keeps firing.
    this.video = document.createElement('video');
    Object.assign(this.video, { muted: true, playsInline: true, autoplay: true });
    this.video.setAttribute('playsinline', '');
    this.video.className = 'beauty-src';
    document.body.appendChild(this.video);
    this.running = false;
    this.frames = 0;
    this.scale = 1; this.cost = 0; this.lastScaleAt = 0;
    this.track = null;
    this._onVis = () => this._schedule();
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.dispatchEvent(new Event('lost')); });
    this.canvas.addEventListener('webglcontextrestored', () => { try { this.proc.init(this.canvas); this.dispatchEvent(new Event('restored')); } catch {} });
  }

  setParams(p) { Object.assign(this.params, p); } // uniforms only — never rebuilds anything

  // Resolves with the output track once the first processed frame exists.
  async start(sourceTrack) {
    if (!this.proc) { this.proc = registry.get(this.processorName)(); await this.proc.init(this.canvas); }
    this.setSource(sourceTrack);
    if (!this.track) {
      const stream = this.canvas.captureStream(0);
      this.track = stream.getVideoTracks()[0];
      this.manual = typeof this.track.requestFrame === 'function';
      if (!this.manual) { this.track.stop(); this.track = this.canvas.captureStream(30).getVideoTracks()[0]; }
      try { this.track.contentHint = 'motion'; } catch {}
    }
    this.running = true;
    document.addEventListener('visibilitychange', this._onVis);
    this._first = new Promise((r) => { this._resolveFirst = r; });
    if (this.frames > 0) this._resolveFirst();
    this._schedule();
    await Promise.race([this._first, new Promise((_, rej) => setTimeout(() => rej(new Error('no camera frames')), 5000))]);
    return this.track;
  }

  // Camera switched: keep showing the last good frame until the new camera delivers one.
  setSource(track) {
    if (this.srcTrack === track) return;
    this.srcTrack = track;
    this.video.srcObject = new MediaStream([track]);
    this.video.play().catch(() => {});
  }

  _draw() {
    if (!this.running) return;
    const v = this.video;
    if (v.readyState < 2 || !v.videoWidth) return;
    // Adaptive cost: on slow (software-GL / old) machines, process at a lower resolution.
    // Only ever steps down, at most twice, so the output size never oscillates.
    const w = Math.round(v.videoWidth * this.scale) & ~1; const h = Math.round(v.videoHeight * this.scale) & ~1;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    let ok = false;
    const t0 = performance.now();
    try { ok = this.proc.process(v, this.canvas, this.params) !== false; } catch (e) { console.warn('beauty', e); }
    if (!ok) return;
    this.cost = this.cost * 0.9 + (performance.now() - t0) * 0.1;
    if (this.frames > 30 && this.cost > 14 && this.scale > 0.5 && this.frames - this.lastScaleAt > 60) {
      this.scale = this.scale > 0.75 ? 0.75 : 0.5; this.lastScaleAt = this.frames;
    }
    if (this.manual) this.track.requestFrame();
    this.frames++;
    if (this.frames === 1 || this._resolveFirst) { this._resolveFirst?.(); this._resolveFirst = null; }
  }

  _schedule() {
    if (!this.running) return;
    if (document.hidden) { this._startTicker(); return; }
    this._stopTicker();
    if (this._loopActive) return;
    this._loopActive = true;
    const v = this.video;
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      const step = () => {
        if (!this.running || document.hidden) { this._loopActive = false; return; }
        this._draw(); v.requestVideoFrameCallback(step);
      };
      v.requestVideoFrameCallback(step);
      // rVFC only fires on new frames; kick once in case a frame is already decoded
      requestAnimationFrame(() => this._draw());
    } else {
      const step = () => {
        if (!this.running || document.hidden) { this._loopActive = false; return; }
        this._draw(); requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }
  _startTicker() {
    if (this.ticker) return;
    try {
      this.ticker = new Worker('/js/ticker.js');
      this.ticker.onmessage = () => this._draw();
      this.ticker.postMessage({ fps: 30 });
    } catch { this.ticker = setInterval(() => this._draw(), 33); }
  }
  _stopTicker() {
    if (!this.ticker) return;
    if (this.ticker instanceof Worker) this.ticker.terminate(); else clearInterval(this.ticker);
    this.ticker = null;
  }

  pause() { this.running = false; this._loopActive = false; this._stopTicker(); document.removeEventListener('visibilitychange', this._onVis); }
  destroy() {
    this.pause();
    try { this.track?.stop(); } catch {}
    try { this.proc?.destroy?.(); } catch {}
    this.video.srcObject = null; this.video.remove(); this.canvas.remove();
  }
}
