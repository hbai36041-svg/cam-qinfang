// AudioWorklet: downsample microphone to 16 kHz mono Int16, post ~100 ms chunks with their RMS.
class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.acc = 0;
    this.buf = new Int16Array(1600);
    this.n = 0;
    this.sq = 0;
  }
  process(inputs) {
    const ch = inputs[0];
    if (!ch || !ch.length) return true;
    const a = ch[0]; const b = ch[1];
    for (let i = 0; i < a.length; i++) {
      this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        const s = b ? (a[i] + b[i]) * 0.5 : a[i];
        const c = Math.max(-1, Math.min(1, s));
        this.buf[this.n++] = c < 0 ? c * 0x8000 : c * 0x7fff;
        this.sq += c * c;
        if (this.n === this.buf.length) {
          this.port.postMessage({ pcm: this.buf, rms: Math.sqrt(this.sq / this.n) }, [this.buf.buffer]);
          this.buf = new Int16Array(1600); this.n = 0; this.sq = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-downsampler', PcmDownsampler);
