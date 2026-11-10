// Speech capture for live captions.
// Speech segments are cut with a light VAD, sent to our server (which calls Tencent / Yandex /
// OpenAI depending on configuration), and the server broadcasts recognised text + translations.
// Long, very steady sounds (sustained violin notes) are skipped so music is not sent to ASR.

const BCP47 = { zh: 'zh-CN', ru: 'ru-RU', en: 'en-US' };

function wav(int16chunks) {
  const len = int16chunks.reduce((a, c) => a + c.length, 0);
  const buf = new ArrayBuffer(44 + len * 2);
  const dv = new DataView(buf);
  const w = (o, s) => [...s].forEach((ch, i) => dv.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); dv.setUint32(4, 36 + len * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, len * 2, true);
  let o = 44;
  for (const c of int16chunks) { new Int16Array(buf, o, c.length).set(c); o += c.length * 2; }
  return new Blob([buf], { type: 'audio/wav' });
}

export function isSteadyTone(rmsList) {
  if (rmsList.length < 20) return false;
  const mean = rmsList.reduce((a, b) => a + b, 0) / rmsList.length;
  const sd = Math.sqrt(rmsList.reduce((a, b) => a + (b - mean) ** 2, 0) / rmsList.length);
  return sd / (mean || 1) < 0.22;
}

export class CaptionCapture extends EventTarget {
  constructor(signaling) { super(); this.signaling = signaling; this.active = false; }

  async start(track, lang, mode) {
    await this.stop();
    if (!track) return;
    this.lang = lang; this.active = true;
    if (mode === 'browser') return this._startBrowser(lang);
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule('/js/pcm-worklet.js');
    this.src = this.ctx.createMediaStreamSource(new MediaStream([track]));
    this.node = new AudioWorkletNode(this.ctx, 'pcm-downsampler');
    const sink = this.ctx.createGain(); sink.gain.value = 0; // keep graph pulling without playing audio
    this.src.connect(this.node); this.node.connect(sink); sink.connect(this.ctx.destination);
    this.floor = 0.004; this.pre = []; this.seg = null; this.pending = 0;
    this.node.port.onmessage = (e) => this._chunk(e.data.pcm, e.data.rms);
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  _chunk(pcm, rms) {
    const thr = Math.max(0.012, this.floor * 3.5);
    if (!this.seg) {
      this.pre.push(pcm); if (this.pre.length > 3) this.pre.shift();
      if (rms > thr) { this.seg = { chunks: [...this.pre], rms: [rms], silence: 0 }; this.pre = []; }
      else this.floor = this.floor * 0.95 + Math.max(rms, 0.002) * 0.05;
      return;
    }
    const s = this.seg;
    s.chunks.push(pcm); s.rms.push(rms);
    s.silence = rms < thr * 0.6 ? s.silence + 1 : 0;
    if (s.silence >= 7 || s.chunks.length >= 120) {
      this.seg = null;
      const voiced = s.rms.slice(0, s.rms.length - s.silence);
      if (voiced.length < 5) return;
      if (isSteadyTone(voiced)) { this.dispatchEvent(new CustomEvent('skipped')); return; }
      this._send(wav(s.chunks));
    }
  }

  async _send(blob) {
    if (this.pending >= 2) return; // drop rather than lag behind
    this.pending++;
    try { await this.signaling.asr(this.lang, blob); this.dispatchEvent(new CustomEvent('sent')); }
    catch (e) { this.dispatchEvent(new CustomEvent('error', { detail: e })); }
    finally { this.pending--; }
  }

  _startBrowser(lang) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) throw new Error('no speech recognition');
    const r = new SR();
    r.lang = BCP47[lang]; r.continuous = true; r.interimResults = false;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) this.signaling.caption(lang, e.results[i][0].transcript).catch(() => {});
      }
    };
    r.onend = () => { if (this.active && this.rec === r) setTimeout(() => { try { r.start(); } catch {} }, 300); };
    r.onerror = (e) => this.dispatchEvent(new CustomEvent('error', { detail: e }));
    this.rec = r;
    r.start();
  }

  async stop() {
    this.active = false;
    try { this.rec?.stop(); } catch {} this.rec = null;
    try { this.src?.disconnect(); this.node?.disconnect(); } catch {}
    if (this.ctx) { try { await this.ctx.close(); } catch {} }
    this.ctx = this.src = this.node = null; this.seg = null;
  }
}

export const browserSpeechAvailable = () => !!(window.SpeechRecognition || window.webkitSpeechRecognition);
