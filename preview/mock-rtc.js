export class PeerManager extends EventTarget {
  constructor(o) { super(); Object.assign(this, o); this.peers = new Map(); this.tracks = { audio: null, video: null }; }
  ensure(id) {
    if (this.peers.has(id)) return this.peers.get(id);
    const p = { id, pc: { connectionState: 'connected', restartIce() {}, close() {} }, videoTx: { sender: { track: null } }, audioTx: { sender: { track: null } } };
    this.peers.set(id, p);
    setTimeout(() => {
      p.stream = demoStream('remote');
      this.dispatchEvent(new CustomEvent('stream', { detail: { id, stream: p.stream } }));
      this.dispatchEvent(new CustomEvent('state', { detail: { id, state: 'connected' } }));
    }, 700);
    return p;
  }
  remove(id) { this.peers.delete(id); }
  onSignal() {}
  async setTrack(kind, track) { this.tracks[kind] = track; }
  async applyEncoding() {}
  restartIce() {}
  closeAll() { this.peers.clear(); }
}
export async function connectionQuality() { return { level: 'good', rtt: 0.086, loss: 0 }; }
