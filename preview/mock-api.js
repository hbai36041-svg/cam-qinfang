export class ApiError extends Error { constructor(code, status) { super(code); this.code = code; this.status = status; } }
const rooms = {};
const CODE = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export async function api(path, { method = 'GET', body } = {}) {
  await new Promise((r) => setTimeout(r, 120));
  if (path === '/api/config') return { version: '1.0.0 · 预览', iceServers: [], maxPeers: 6, captions: { asr: { zh: 'demo', ru: 'demo', en: 'demo' }, translate: 'demo' } };
  if (path === '/api/rooms' && method === 'POST') {
    const id = body?.id || Array.from({ length: 6 }, () => CODE[Math.floor(Math.random() * CODE.length)]).join('');
    rooms[id] = { id, name: body?.name || 'CAM线上琴房' };
    return { id, name: rooms[id].name, hasPassword: false };
  }
  const m = path.match(/^\/api\/rooms\/([A-Z0-9]+)(\/join)?/);
  if (m) {
    const r = rooms[m[1]] || (rooms[m[1]] = { id: m[1], name: 'CAM线上琴房' });
    if (m[2]) return { peerId: 'me', token: 'x', room: r, peers: [] };
    return { ...r, hasPassword: false, count: 0, full: false };
  }
  throw new ApiError('not_found', 404);
}
export const apiRetry = api;
const LINES = [
  { name: 'Иван', lang: 'ru', t: { ru: 'Профессор, на третьей позиции у меня фальшивит ми.', zh: '教授，我在第三把位上 E 音不准。', en: 'Professor, my E is out of tune in third position.' } },
  { name: '王老师', lang: 'zh', t: { zh: '换把之前先放松拇指，再听一下空弦。', ru: 'Перед сменой позиции расслабьте большой палец и сверьтесь с открытой струной.', en: 'Relax your thumb before the shift, then check against the open string.' } },
  { name: 'Иван', lang: 'ru', t: { ru: 'Понял, попробую ещё раз медленно.', zh: '明白了，我再慢慢试一遍。', en: 'Got it, I will try again slowly.' } },
];
export class Signaling extends EventTarget {
  constructor(roomId, peerId, token) { super(); Object.assign(this, { roomId, peerId, token, timers: [] }); }
  emit(n, d) { this.dispatchEvent(new CustomEvent(n, { detail: d })); }
  connect() {
    const T = (ms, f) => this.timers.push(setTimeout(f, ms));
    T(150, () => { this.emit('online'); this.emit('hello', { you: 'me', peers: [] }); });
    T(2500, () => this.emit('peer-joined', { id: 'demo', name: 'Иван', role: 'student', state: { mic: true, cam: true } }));
    let k = 0;
    const cap = () => {
      const l = LINES[k++ % LINES.length];
      this.emit('caption', { id: 'c' + k, from: l.name === '王老师' ? 'me' : 'demo', name: l.name, lang: l.lang, text: l.t[l.lang], ts: Date.now(), translations: l.t });
      T(5500, cap);
    };
    T(5000, cap);
  }
  async signal() { return { ok: true }; }
  async state() { return { ok: true }; }
  async caption(lang, text) { this.emit('caption', { id: 'u' + Date.now(), from: 'me', name: 'me', lang, text, translations: { [lang]: text } }); }
  async asr() { return { text: '' }; }
  leave() { this.timers.forEach(clearTimeout); }
}
