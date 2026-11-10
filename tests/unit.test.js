'use strict';
// Server + pure-logic tests. Run: npm test
process.env.ASR_ZH = 'mock'; process.env.ASR_RU = 'mock'; process.env.ASR_EN = 'mock'; process.env.TRANSLATE = 'mock';
process.env.TURN_URLS = 'turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp';
process.env.TURN_SECRET = 'test-secret';
process.env.STUN_URLS = 'stun:turn.example.com:3478';
process.env.MAX_PEERS = '3';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { start } = require('../server/server');

let server; let base;
test.before(async () => { server = await start(0, '127.0.0.1'); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.closeAllConnections?.(); server.close(); });

const req = async (path, { method = 'GET', body, raw, headers } = {}) => {
  const r = await fetch(base + path, { method, body: raw || (body ? JSON.stringify(body) : undefined), headers: raw ? { 'Content-Type': 'audio/wav', ...headers } : { 'Content-Type': 'application/json', ...headers } });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data, headers: r.headers };
};

// Minimal EventSource for Node: collects events from an SSE stream.
function sse(path) {
  const ctrl = new AbortController();
  const events = []; const waiters = [];
  (async () => {
    const r = await fetch(base + path, { signal: ctrl.signal });
    const dec = new TextDecoder(); let buf = '';
    try {
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!ev) continue;
          const e = { event: ev, data: data ? JSON.parse(data) : null };
          events.push(e);
          waiters.splice(0).forEach((w) => w());
        }
      }
    } catch {}
  })();
  const next = async (name, pred = () => true, timeout = 3000) => {
    const t0 = Date.now();
    for (;;) {
      const idx = events.findIndex((e) => e.event === name && pred(e.data));
      if (idx >= 0) return events.splice(idx, 1)[0].data;
      if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${name}`);
      await new Promise((r) => { waiters.push(r); setTimeout(r, 100); });
    }
  };
  return { next, close: () => ctrl.abort(), events };
}

async function createAndJoin(name = 'Room', password) {
  const c = await req('/api/rooms', { method: 'POST', body: { name, password } });
  return c.data.id;
}
const join = (id, name, extra = {}) => req(`/api/rooms/${id}/join`, { method: 'POST', body: { name, ...extra } });

test('health and static files', async () => {
  const h = await req('/api/health');
  assert.equal(h.status, 200); assert.equal(h.data.ok, true);
  const idx = await fetch(base + '/');
  assert.equal(idx.status, 200);
  assert.match(await idx.text(), /CAM线上琴房/);
  assert.match(idx.headers.get('content-security-policy'), /default-src 'self'/);
  const deep = await fetch(base + '/r/ABC234'); assert.equal(deep.status, 200); // SPA deep link
  const diag = await fetch(base + '/diag'); assert.equal(diag.status, 200);
  const trav = await fetch(base + '/..%2fpackage.json'); assert.notEqual(trav.status, 200);
  const logo = await fetch(base + '/assets/logo.png'); assert.equal(logo.headers.get('content-type'), 'image/png');
});

test('config exposes TURN REST credentials that coturn can verify', async () => {
  const { data } = await req('/api/config');
  const turn = data.iceServers.find((s) => s.username);
  assert.ok(turn, 'turn entry present');
  const [expiry] = turn.username.split(':');
  assert.ok(+expiry > Date.now() / 1000 + 3600, 'credential valid for hours');
  const expected = crypto.createHmac('sha1', 'test-secret').update(turn.username).digest('base64');
  assert.equal(turn.credential, expected);
  assert.deepEqual(data.captions.asr, { zh: 'mock', ru: 'mock', en: 'mock' });
});

test('create room → readable 6-char code; get; unknown room 404', async () => {
  const c = await req('/api/rooms', { method: 'POST', body: { name: '王老师的琴房' } });
  assert.equal(c.status, 201);
  assert.match(c.data.id, /^[2-9A-HJKMNP-Z]{6}$/);
  const g = await req(`/api/rooms/${c.data.id.toLowerCase()}`); // case-insensitive
  assert.equal(g.status, 200); assert.equal(g.data.name, '王老师的琴房'); assert.equal(g.data.count, 0);
  assert.equal((await req('/api/rooms/ZZZZZZ')).status, 404);
});

test('create works with empty body and strips markup from names', async () => {
  const r = await fetch(base + '/api/rooms', { method: 'POST' });
  assert.equal(r.status, 201);
  const c = await req('/api/rooms', { method: 'POST', body: { name: '<script>x</script>' } });
  assert.ok(!c.data.name.includes('<'));
});

test('expired room code can be reopened (old invite links keep working)', async () => {
  const r = await req('/api/rooms', { method: 'POST', body: { id: 'K7M2PQ' } });
  assert.equal(r.status, 201); assert.equal(r.data.id, 'K7M2PQ');
  const again = await req('/api/rooms', { method: 'POST', body: { id: 'K7M2PQ' } });
  assert.equal(again.status, 409);
});

test('password protection', async () => {
  const id = await createAndJoin('pw', '1234');
  assert.equal((await req(`/api/rooms/${id}`)).data.hasPassword, true);
  assert.equal((await join(id, 'a', { password: 'nope' })).status, 403);
  assert.equal((await join(id, 'a', { password: '1234' })).status, 200);
});

test('room capacity is enforced', async () => {
  const id = await createAndJoin('cap');
  for (let i = 0; i < 3; i++) assert.equal((await join(id, `p${i}`)).status, 200);
  assert.equal((await join(id, 'p4')).status, 409);
});

test('signalling: hello, peer-joined, relay, state, leave', async () => {
  const id = await createAndJoin('sig');
  const a = (await join(id, 'Teacher', { role: 'teacher' })).data;
  const sa = sse(`/api/rooms/${id}/events?peer=${a.peerId}&token=${a.token}`);
  const helloA = await sa.next('hello');
  assert.equal(helloA.you, a.peerId); assert.equal(helloA.peers.length, 0);

  const b = (await join(id, 'Student')).data;
  assert.equal(b.peers.length, 1); assert.equal(b.peers[0].role, 'teacher');
  const sb = sse(`/api/rooms/${id}/events?peer=${b.peerId}&token=${b.token}`);
  await sb.next('hello');
  const joined = await sa.next('peer-joined');
  assert.equal(joined.id, b.peerId); assert.equal(joined.name, 'Student');

  // bad token rejected
  assert.equal((await req(`/api/rooms/${id}/signal`, { method: 'POST', body: { peer: a.peerId, token: 'x', to: b.peerId, data: {} } })).status, 401);
  const r = await req(`/api/rooms/${id}/signal`, { method: 'POST', body: { peer: a.peerId, token: a.token, to: b.peerId, data: { description: { type: 'offer', sdp: 'v=0' } } } });
  assert.equal(r.status, 200);
  const sig = await sb.next('signal');
  assert.equal(sig.from, a.peerId); assert.equal(sig.data.description.type, 'offer');

  await req(`/api/rooms/${id}/state`, { method: 'POST', body: { peer: b.peerId, token: b.token, state: { mic: false, cam: true, lang: 'ru' } } });
  const st = await sa.next('peer-state');
  assert.equal(st.state.mic, false); assert.equal(st.state.lang, 'ru');

  await req(`/api/rooms/${id}/leave`, { method: 'POST', body: { peer: b.peerId, token: b.token } });
  const left = await sa.next('peer-left');
  assert.equal(left.id, b.peerId);
  sa.close(); sb.close();
});

test('long-poll fallback: hello, relayed signals, and announcements work without an event stream', async () => {
  const id = await createAndJoin('poll');
  const a = (await join(id, 'A')).data; const b = (await join(id, 'B')).data;
  const sa = sse(`/api/rooms/${id}/events?peer=${a.peerId}&token=${a.token}`); await sa.next('hello');
  const poll = async (p) => (await req(`/api/rooms/${id}/poll?peer=${p.peerId}&token=${p.token}`)).data.events;
  const first = await poll(b);
  assert.equal(first[0].event, 'hello'); assert.equal(first[0].data.peers[0].id, a.peerId);
  await sa.next('peer-joined', (d) => d.id === b.peerId);
  // a long poll waits, then returns as soon as a signal arrives
  const pending = poll(b);
  await new Promise((r) => setTimeout(r, 200));
  await req(`/api/rooms/${id}/signal`, { method: 'POST', body: { peer: a.peerId, token: a.token, to: b.peerId, data: { x: 1 } } });
  const evs = await pending;
  assert.equal(evs[0].event, 'signal'); assert.deepEqual(evs[0].data.data, { x: 1 });
  // poller can signal back to the SSE peer
  await req(`/api/rooms/${id}/signal`, { method: 'POST', body: { peer: b.peerId, token: b.token, to: a.peerId, data: { y: 2 } } });
  assert.deepEqual((await sa.next('signal')).data, { y: 2 });
  assert.equal((await req(`/api/rooms/${id}/poll?peer=x&token=y`)).data.events[0].event, 'gone');
  sa.close();
});

test('SSE with an expired seat gets a "gone" event (client then re-joins)', async () => {
  const id = await createAndJoin('gone');
  const s = sse(`/api/rooms/${id}/events?peer=nobody&token=x`);
  await s.next('gone');
  s.close();
});

test('brief disconnect keeps the seat (grace period) and reconnect is announced', async () => {
  const id = await createAndJoin('grace');
  const a = (await join(id, 'A')).data; const b = (await join(id, 'B')).data;
  const sa = sse(`/api/rooms/${id}/events?peer=${a.peerId}&token=${a.token}`); await sa.next('hello');
  let sb = sse(`/api/rooms/${id}/events?peer=${b.peerId}&token=${b.token}`); await sb.next('hello');
  sb.close();
  await new Promise((r) => setTimeout(r, 300));
  sb = sse(`/api/rooms/${id}/events?peer=${b.peerId}&token=${b.token}`);
  await sb.next('hello');
  await sa.next('peer-reconnected', (d) => d.id === b.peerId);
  assert.equal(sa.events.some((e) => e.event === 'peer-left'), false);
  sa.close(); sb.close();
});

test('captions: text caption is translated into the other two languages', async () => {
  const id = await createAndJoin('cap');
  const a = (await join(id, '王老师')).data; const b = (await join(id, 'Иван')).data;
  const sb = sse(`/api/rooms/${id}/events?peer=${b.peerId}&token=${b.token}`); await sb.next('hello');
  await req(`/api/rooms/${id}/caption`, { method: 'POST', body: { peer: a.peerId, token: a.token, lang: 'zh', text: '注意换弓' } });
  const full = await sb.next('caption', (d) => Object.keys(d.translations).length === 3);
  assert.equal(full.translations.zh, '注意换弓');
  assert.equal(full.translations.ru, '[ru] 注意换弓');
  assert.equal(full.translations.en, '[en] 注意换弓');
  sb.close();
});

test('captions: ASR endpoint accepts 16 kHz WAV and broadcasts the result', async () => {
  const id = await createAndJoin('asr');
  const a = (await join(id, 'Teacher')).data; const b = (await join(id, 'Student')).data;
  const sb = sse(`/api/rooms/${id}/events?peer=${b.peerId}&token=${b.token}`); await sb.next('hello');
  const pcm = Buffer.alloc(32000 * 2); // 2 s of silence
  const hdr = Buffer.alloc(44); hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVEfmt ', 8);
  hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(16000, 24); hdr.writeUInt32LE(32000, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
  const r = await req(`/api/rooms/${id}/asr?peer=${a.peerId}&token=${a.token}&lang=ru`, { method: 'POST', raw: Buffer.concat([hdr, pcm]) });
  assert.equal(r.status, 200); assert.match(r.data.text, /2\.0/);
  const cap = await sb.next('caption');
  assert.equal(cap.lang, 'ru'); assert.equal(cap.name, 'Teacher');
  assert.equal((await req(`/api/rooms/${id}/asr?peer=${a.peerId}&token=${a.token}&lang=de`, { method: 'POST', raw: hdr })).status, 400);
  sb.close();
});

test('rate limit on room creation', async () => {
  let last;
  for (let i = 0; i < 40; i++) last = await req('/api/rooms', { method: 'POST', body: {}, headers: { 'X-Forwarded-For': '203.0.113.9' } });
  assert.equal(last.status, 429);
});

test('opus SDP tuning requests stereo, high bitrate, FEC, no DTX', async () => {
  const { tuneOpus } = await import('../public/js/media.js');
  const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 63\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\na=rtpmap:63 red/48000/2\r\n';
  const out = tuneOpus(sdp, { bitrate: 192000, stereo: true });
  const line = out.match(/a=fmtp:111 (.*)/)[1];
  for (const kv of ['stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=192000', 'useinbandfec=1', 'usedtx=0']) assert.ok(line.includes(kv), kv);
  assert.equal((out.match(/a=fmtp:111/g) || []).length, 1);
  const noFmtp = tuneOpus('m=audio 9 x 111\r\na=rtpmap:111 opus/48000/2\r\n');
  assert.match(noFmtp, /a=fmtp:111 .*stereo=1/);
});

test('music-mode audio constraints disable voice processing; voice mode enables it', async () => {
  const { audioConstraints } = await import('../public/js/media.js');
  const m = audioConstraints({ audioMode: 'music', echo: false, stereo: true });
  assert.equal(m.noiseSuppression, false); assert.equal(m.autoGainControl, false); assert.equal(m.echoCancellation, false);
  assert.deepEqual(m.channelCount, { ideal: 2 });
  const v = audioConstraints({ audioMode: 'voice' });
  assert.equal(v.noiseSuppression, true); assert.equal(v.echoCancellation, true); assert.equal(v.autoGainControl, true);
});

test('caption VAD rejects sustained steady tones (violin notes) but keeps speech-like energy', async () => {
  const { isSteadyTone } = await import('../public/js/captions.js');
  const note = Array.from({ length: 40 }, (_, i) => 0.2 + 0.01 * Math.sin(i));
  const speech = Array.from({ length: 40 }, (_, i) => 0.05 + 0.15 * Math.abs(Math.sin(i * 0.8)));
  assert.equal(isSteadyTone(note), true);
  assert.equal(isSteadyTone(speech), false);
});

test('Tencent TC3 signature headers are well-formed', () => {
  const cfg = require('../server/config');
  cfg.tencent.secretId = 'AKIDtest'; cfg.tencent.secretKey = 'key';
  const { tc3Headers } = require('../server/providers');
  const h = tc3Headers({ service: 'tmt', host: 'tmt.tencentcloudapi.com', action: 'TextTranslate', version: '2018-03-21', region: 'ap-hongkong', body: '{}' });
  assert.match(h.Authorization, /^TC3-HMAC-SHA256 Credential=AKIDtest\/\d{4}-\d{2}-\d{2}\/tmt\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/);
  assert.equal(h['X-TC-Region'], 'ap-hongkong');
});
