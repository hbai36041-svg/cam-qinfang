// Mesh WebRTC with the "perfect negotiation" pattern (no glare, safe renegotiation).
import { tuneOpus, QUALITY } from './media.js';

export class PeerManager extends EventTarget {
  constructor({ signaling, selfId, iceServers, getSettings }) {
    super();
    Object.assign(this, { signaling, selfId, iceServers, getSettings });
    this.peers = new Map();
    this.tracks = { audio: null, video: null };
    // Watchdog: a signalling message lost on a flaky (cross-border / mobile) link can leave a
    // connection stuck in "new"/"connecting" forever. The polite side then rebuilds the connection
    // and tells the other side to do the same.
    this.watchdog = setInterval(() => this.checkHealth(), 2000);
  }

  checkHealth() {
    const now = Date.now();
    for (const p of this.peers.values()) {
      if (p.pc.connectionState === 'connected') { p.healthyAt = now; continue; }
      const since = now - Math.max(p.healthyAt || 0, p.createdAt);
      if (p.polite && since > 15000 && !p.resetting) { p.resetting = true; this.reset(p.id, true); }
    }
  }
  async reset(remoteId, notify) {
    const old = this.peers.get(remoteId);
    if (old) { old.close(); this.peers.delete(remoteId); }
    // Make sure the other side has dropped its old connection before our new offer can arrive.
    if (notify) { try { await this.signaling.signal(remoteId, { reset: true }); } catch {} }
    const p = this.ensure(remoteId);
    this.dispatchEvent(new CustomEvent('reset', { detail: { id: remoteId } }));
    return p;
  }

  // Remote side asked us to talk: create (or reuse) a connection.
  ensure(remoteId) {
    let p = this.peers.get(remoteId);
    if (!p) { p = new Peer(this, remoteId); this.peers.set(remoteId, p); }
    return p;
  }
  remove(remoteId) {
    const p = this.peers.get(remoteId);
    if (!p) return;
    p.close();
    this.peers.delete(remoteId);
    this.dispatchEvent(new CustomEvent('removed', { detail: { id: remoteId } }));
  }
  onSignal(from, data) {
    if (data?.reset) { this.reset(from, false); return; }
    this.ensure(from).enqueue(data);
  }

  // Swap outgoing tracks without renegotiation (no flash, no re-connect).
  async setTrack(kind, track) {
    this.tracks[kind] = track;
    await Promise.all([...this.peers.values()].map((p) => p.setTrack(kind, track)));
  }
  async applyEncoding() { await Promise.all([...this.peers.values()].map((p) => p.applyEncoding())); }
  restartIce(remoteId) { this.peers.get(remoteId)?.pc.restartIce(); }
  closeAll() { clearInterval(this.watchdog); for (const id of [...this.peers.keys()]) this.remove(id); }
}

class Peer {
  constructor(mgr, remoteId) {
    this.mgr = mgr;
    this.id = remoteId;
    this.polite = mgr.selfId < remoteId;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.chain = Promise.resolve();
    this.createdAt = Date.now();
    this.stream = new MediaStream();
    const pc = new RTCPeerConnection({ iceServers: mgr.iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    this.pc = pc;

    // Fixed transceivers so swapping tracks never needs renegotiation.
    const q = QUALITY[mgr.getSettings().quality] || QUALITY['720'];
    this.audioTx = pc.addTransceiver('audio', { direction: 'sendrecv' });
    this.videoTx = pc.addTransceiver('video', { direction: 'sendrecv', sendEncodings: [{ maxBitrate: q.bitrate, maxFramerate: 30 }] });
    if (mgr.tracks.audio) this.audioTx.sender.replaceTrack(mgr.tracks.audio);
    if (mgr.tracks.video) this.videoTx.sender.replaceTrack(mgr.tracks.video);
    this.applyEncoding();

    pc.ontrack = ({ track }) => {
      this.stream.getTracks().filter((t) => t.kind === track.kind).forEach((t) => this.stream.removeTrack(t));
      this.stream.addTrack(track);
      mgr.dispatchEvent(new CustomEvent('stream', { detail: { id: this.id, stream: this.stream } }));
    };
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.send({ candidate }); };
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.send({ description: pc.localDescription });
      } catch (e) { console.warn('negotiation', e); } finally { this.makingOffer = false; }
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      mgr.dispatchEvent(new CustomEvent('state', { detail: { id: this.id, state: s } }));
      clearTimeout(this.failTimer);
      if (s === 'failed') pc.restartIce();
      if (s === 'disconnected') this.failTimer = setTimeout(() => pc.connectionState === 'disconnected' && pc.restartIce(), 4000);
    };
  }

  send(data) {
    this.mgr.signaling.signal(this.id, JSON.parse(JSON.stringify(data))).catch((e) => console.warn('signal', e));
  }
  enqueue(data) { this.chain = this.chain.then(() => this.handle(data)).catch((e) => console.warn('signal handling', e)); }

  async handle({ description, candidate }) {
    const pc = this.pc;
    if (description) {
      const collision = description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
      this.ignoreOffer = !this.polite && collision;
      if (this.ignoreOffer) return;
      const s = this.mgr.getSettings();
      const tuned = { type: description.type, sdp: tuneOpus(description.sdp, { bitrate: s.audioBitrate * 1000, stereo: s.audioMode === 'music' }) };
      await pc.setRemoteDescription(tuned);
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        this.send({ description: pc.localDescription });
      }
    } else if (candidate) {
      try { await pc.addIceCandidate(candidate); } catch (e) { if (!this.ignoreOffer) throw e; }
    }
  }

  async setTrack(kind, track) {
    const tx = kind === 'audio' ? this.audioTx : this.videoTx;
    await tx.sender.replaceTrack(track || null);
  }

  async applyEncoding() {
    const s = this.mgr.getSettings();
    const q = QUALITY[s.quality] || QUALITY['720'];
    try {
      const vp = this.videoTx.sender.getParameters();
      vp.encodings = vp.encodings?.length ? vp.encodings : [{}];
      vp.encodings[0].maxBitrate = q.bitrate;
      vp.encodings[0].maxFramerate = 30;
      vp.degradationPreference = 'maintain-framerate';
      await this.videoTx.sender.setParameters(vp);
    } catch {}
    try {
      const ap = this.audioTx.sender.getParameters();
      ap.encodings = ap.encodings?.length ? ap.encodings : [{}];
      ap.encodings[0].maxBitrate = s.audioBitrate * 1000;
      ap.encodings[0].priority = 'high';
      ap.encodings[0].networkPriority = 'high';
      await this.audioTx.sender.setParameters(ap);
    } catch {}
  }

  close() { clearTimeout(this.failTimer); try { this.pc.close(); } catch {} }
}

// Simple quality probe from getStats: RTT + packet loss of inbound video.
export async function connectionQuality(pc) {
  try {
    const stats = await pc.getStats();
    let rtt = null; let lost = 0; let recv = 0;
    stats.forEach((r) => {
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') rtt = r.currentRoundTripTime;
      if (r.type === 'inbound-rtp' && !r.isRemote) { lost += r.packetsLost || 0; recv += r.packetsReceived || 0; }
    });
    const loss = recv ? lost / (lost + recv) : 0;
    const level = rtt == null ? 'fair' : rtt < 0.25 && loss < 0.03 ? 'good' : rtt < 0.5 && loss < 0.08 ? 'fair' : 'poor';
    return { rtt, loss, level };
  } catch { return { level: 'fair' }; }
}
