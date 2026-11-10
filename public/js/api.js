// REST + Server-Sent-Events signalling client.
export class ApiError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

export async function api(path, { method = 'GET', body, timeout = 10000, raw } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(path, {
      method, signal: ctrl.signal, cache: 'no-store',
      headers: raw ? { 'Content-Type': 'audio/wav' } : body ? { 'Content-Type': 'application/json' } : undefined,
      body: raw || (body ? JSON.stringify(body) : undefined),
    });
  } catch (e) {
    throw new ApiError('network', 0);
  } finally { clearTimeout(timer); }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new ApiError(data?.error || `http_${res.status}`, res.status);
  return data;
}

// Retries transient network failures (mobile networks, cross-border links).
export async function apiRetry(path, opts, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await api(path, opts); } catch (e) {
      last = e;
      if (e.code !== 'network' && e.status < 500) throw e;
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw last;
}

export class Signaling extends EventTarget {
  constructor(roomId, peerId, token) {
    super();
    Object.assign(this, { roomId, peerId, token, es: null, closed: false });
  }
  connect() {
    // Event stream first. Some proxies and tunnels buffer or block it; if the first message has not
    // arrived within 6 s, switch to long-polling, which works through anything that passes HTTPS.
    if (!window.EventSource) return this._poll();
    const q = new URLSearchParams({ peer: this.peerId, token: this.token });
    const es = new EventSource(`/api/rooms/${this.roomId}/events?${q}`);
    this.es = es;
    let gotHello = false;
    const fwd = (name) => es.addEventListener(name, (ev) => {
      let data = {}; try { data = JSON.parse(ev.data); } catch {}
      if (name === 'hello') gotHello = true;
      this.dispatchEvent(new CustomEvent(name, { detail: data }));
    });
    ['hello', 'peer-joined', 'peer-reconnected', 'peer-left', 'peer-state', 'signal', 'caption', 'gone'].forEach(fwd);
    es.onopen = () => this.dispatchEvent(new CustomEvent('online'));
    es.onerror = () => { if (!this.closed) this.dispatchEvent(new CustomEvent('offline')); };
    es.addEventListener('gone', () => { es.close(); });
    setTimeout(() => { if (!gotHello && !this.closed) { es.close(); this.es = null; this._poll(); } }, 6000);
  }
  async _poll() {
    this.transport = 'poll';
    const q = new URLSearchParams({ peer: this.peerId, token: this.token });
    let failures = 0;
    while (!this.closed) {
      try {
        const r = await api(`/api/rooms/${this.roomId}/poll?${q}`, { timeout: 35000 });
        if (failures) this.dispatchEvent(new CustomEvent('online'));
        failures = 0;
        for (const { event, data } of r.events || []) {
          this.dispatchEvent(new CustomEvent(event, { detail: data }));
          if (event === 'gone') return;
        }
      } catch {
        if (this.closed) return;
        if (++failures === 1) this.dispatchEvent(new CustomEvent('offline'));
        await new Promise((res) => setTimeout(res, Math.min(5000, 1000 * failures)));
      }
    }
  }
  async signal(to, data) {
    return apiRetry(`/api/rooms/${this.roomId}/signal`, { method: 'POST', body: { peer: this.peerId, token: this.token, to, data } });
  }
  state(state) {
    return api(`/api/rooms/${this.roomId}/state`, { method: 'POST', body: { peer: this.peerId, token: this.token, state } }).catch(() => {});
  }
  caption(lang, text) {
    return api(`/api/rooms/${this.roomId}/caption`, { method: 'POST', body: { peer: this.peerId, token: this.token, lang, text } });
  }
  asr(lang, wav) {
    const q = new URLSearchParams({ peer: this.peerId, token: this.token, lang });
    return api(`/api/rooms/${this.roomId}/asr?${q}`, { method: 'POST', raw: wav, timeout: 25000 });
  }
  leave() {
    this.closed = true;
    try { this.es?.close(); } catch {}
    const body = JSON.stringify({ peer: this.peerId, token: this.token });
    // sendBeacon survives page unload
    if (!navigator.sendBeacon?.(`/api/rooms/${this.roomId}/leave`, new Blob([body], { type: 'application/json' }))) {
      fetch(`/api/rooms/${this.roomId}/leave`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
    }
  }
}
