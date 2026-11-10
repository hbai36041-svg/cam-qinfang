'use strict';
// CAM线上琴房 — zero-dependency Node.js server.
// Static files + REST + Server-Sent-Events signalling for WebRTC + caption relay.
// SSE (instead of WebSocket) passes through every proxy/CDN and corporate firewall we tested,
// and needs no third-party packages, which keeps deployment trivial in CN and RU.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const providers = require('./providers');

const PUBLIC = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;
const ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O/1/I/L — easy to read aloud in any language

/* ------------------------------ state ------------------------------ */
const rooms = new Map(); // id -> room

function newRoomId() {
  for (let n = 0; n < 50; n++) {
    let id = '';
    const bytes = crypto.randomBytes(6);
    for (const b of bytes) id += ID_ALPHABET[b % ID_ALPHABET.length];
    if (!rooms.has(id)) return id;
  }
  throw new Error('id space exhausted');
}
const token = () => crypto.randomBytes(18).toString('base64url');
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const clean = (s, max = 40) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

function publicPeer(p) { return { id: p.id, name: p.name, role: p.role, state: p.state, online: !!p.res }; }

function send(peer, event, data) {
  if (!peer.res) { peer.queue.push([event, data]); if (peer.queue.length > 200) peer.queue.shift(); return; }
  peer.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(room, event, data, exceptId) {
  for (const p of room.peers.values()) if (p.id !== exceptId) send(p, event, data);
}
function removePeer(room, peer, reason) {
  if (!room.peers.has(peer.id)) return;
  room.peers.delete(peer.id);
  clearTimeout(peer.graceTimer);
  try { peer.res?.end(); } catch {}
  broadcast(room, 'peer-left', { id: peer.id, reason });
  room.lastActive = Date.now();
}

// Housekeeping: drop idle rooms and peers that never opened their event stream.
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    for (const p of room.peers.values()) if (!p.res && !p.graceTimer && now - p.joinedAt > 30000) removePeer(room, p, 'timeout');
    if (room.peers.size === 0 && now - room.lastActive > cfg.roomTtlHours * 3600e3) rooms.delete(id);
  }
}, 10000).unref();

/* --------------------------- rate limiting --------------------------- */
const buckets = new Map();
function allow(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.t > windowMs) { b = { t: now, n: 0 }; buckets.set(key, b); }
  b.n++;
  return b.n <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.t > 3600e3) buckets.delete(k); }, 600e3).unref();

/* ------------------------------ helpers ------------------------------ */
function clientIp(req) {
  if (cfg.trustProxy) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
const fail = (res, status, code, extra) => json(res, status, { error: code, ...extra });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limit = 64 * 1024) {
  const b = await readBody(req, limit);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
}

function iceServers() {
  const out = [];
  if (cfg.stunUrls.length) out.push({ urls: cfg.stunUrls });
  if (cfg.turnUrls.length && cfg.turnSecret) {
    const username = `${Math.floor(Date.now() / 1000) + cfg.turnTtl}:cam`;
    const credential = crypto.createHmac('sha1', cfg.turnSecret).update(username).digest('base64');
    out.push({ urls: cfg.turnUrls, username, credential });
  }
  return out;
}

function authPeer(room, peerId, tok) {
  const p = room?.peers.get(String(peerId || ''));
  if (!p) return null;
  const a = Buffer.from(String(tok || '')); const b = Buffer.from(p.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? p : null;
}

/* ------------------------------ captions ------------------------------ */
async function translateAll(text, from) {
  const tr = providers.translator();
  const out = { [from]: text };
  if (!tr) return out;
  await Promise.all(providers.LANGS.filter((l) => l !== from).map(async (to) => {
    try { out[to] = await tr.translate(text, from, to); } catch (e) { console.warn('[translate]', e.message); }
  }));
  return out;
}
async function publishCaption(room, peer, lang, text) {
  text = clean(text, 500);
  if (!text) return null;
  const msg = { id: crypto.randomUUID(), from: peer.id, name: peer.name, lang, text, ts: Date.now(), translations: { [lang]: text } };
  // Show the original immediately, then the translations as they arrive.
  broadcast(room, 'caption', msg);
  msg.translations = await translateAll(text, lang);
  broadcast(room, 'caption', msg);
  return msg;
}

/* ------------------------------ API routes ------------------------------ */
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const ip = clientIp(req);
  const m = req.method;

  if (parts[1] === 'health') return json(res, 200, { ok: true, version: VERSION, rooms: rooms.size, uptime: Math.round(process.uptime()) });

  if (parts[1] === 'config' && m === 'GET') {
    const asr = Object.fromEntries(providers.LANGS.map((l) => [l, providers.asrFor(l)?.name || null]));
    return json(res, 200, { version: VERSION, iceServers: iceServers(), maxPeers: cfg.maxPeers, captions: { asr, translate: providers.translator()?.name || null } });
  }

  if (parts[1] === 'diag') {
    if (parts[2] === 'ping') return json(res, 200, { t: Date.now() });
    if (parts[2] === 'download') { // throughput probe (256 KB)
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
      return res.end(crypto.randomBytes(256 * 1024));
    }
    if (parts[2] === 'providers') {
      if (!allow(`diag:${ip}`, 10, 60e3)) return fail(res, 429, 'rate_limited');
      const results = {};
      await Promise.all(Object.entries(providers.endpoints()).map(async ([k, u]) => {
        const t0 = Date.now();
        try {
          const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 6000);
          const r = await fetch(u, { method: 'GET', signal: ctrl.signal }); clearTimeout(to);
          results[k] = { reachable: true, status: r.status, ms: Date.now() - t0 };
        } catch (e) { results[k] = { reachable: false, error: e.cause?.code || e.name, ms: Date.now() - t0 }; }
      }));
      return json(res, 200, { server: cfg.publicUrl || null, results });
    }
  }

  if (parts[1] !== 'rooms') return fail(res, 404, 'not_found');

  // POST /api/rooms  — create
  if (parts.length === 2 && m === 'POST') {
    if (!allow(`create:${ip}`, 30, 600e3)) return fail(res, 429, 'rate_limited');
    if (rooms.size >= cfg.maxRooms) return fail(res, 503, 'server_full');
    const body = await readJson(req);
    // An expired/lost room code can be reopened so old invitation links keep working.
    const wanted = String(body.id || '').toUpperCase();
    const reopen = wanted.length === 6 && [...wanted].every((c) => ID_ALPHABET.includes(c));
    if (reopen && rooms.has(wanted)) return fail(res, 409, 'room_exists');
    const id = reopen ? wanted : newRoomId();
    const salt = crypto.randomBytes(8).toString('hex');
    const pw = clean(body.password, 32);
    rooms.set(id, {
      id, name: clean(body.name, 40) || 'CAM线上琴房', createdAt: Date.now(), lastActive: Date.now(),
      salt, pwHash: pw ? hashPw(pw, salt) : null, peers: new Map(),
    });
    return json(res, 201, { id, name: rooms.get(id).name, hasPassword: !!pw });
  }

  const id = String(parts[2] || '').toUpperCase();
  const room = rooms.get(id);
  if (!room) return fail(res, 404, 'room_not_found');
  const sub = parts[3];

  if (!sub && m === 'GET') {
    return json(res, 200, { id, name: room.name, hasPassword: !!room.pwHash, count: room.peers.size, full: room.peers.size >= cfg.maxPeers });
  }

  if (sub === 'join' && m === 'POST') {
    if (!allow(`join:${ip}`, 60, 600e3)) return fail(res, 429, 'rate_limited');
    const body = await readJson(req);
    if (room.pwHash && hashPw(clean(body.password, 32), room.salt) !== room.pwHash) return fail(res, 403, 'bad_password');
    if (room.peers.size >= cfg.maxPeers) return fail(res, 409, 'room_full');
    const peer = {
      id: crypto.randomBytes(6).toString('hex'), token: token(), name: clean(body.name, 32) || 'Guest',
      role: body.role === 'teacher' ? 'teacher' : 'student', state: {}, res: null, queue: [], joinedAt: Date.now(),
    };
    room.peers.set(peer.id, peer);
    room.lastActive = Date.now();
    return json(res, 200, {
      peerId: peer.id, token: peer.token, room: { id, name: room.name },
      peers: [...room.peers.values()].filter((p) => p.id !== peer.id).map(publicPeer),
    });
  }

  // GET /api/rooms/:id/events?peer=&token=   (EventSource)
  if (sub === 'events' && m === 'GET') {
    const peer = authPeer(room, url.searchParams.get('peer'), url.searchParams.get('token'));
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    if (!peer) { res.write(`event: gone\ndata: {}\n\n`); return res.end(); }
    req.socket.setNoDelay(true);
    req.socket.setTimeout(0);
    const reconnect = !!peer.everConnected;
    try { peer.res?.end(); } catch {}
    clearTimeout(peer.graceTimer); peer.graceTimer = null;
    peer.res = res; peer.everConnected = true;
    send(peer, 'hello', { you: peer.id, peers: [...room.peers.values()].filter((p) => p.id !== peer.id).map(publicPeer) });
    for (const [e, d] of peer.queue.splice(0)) send(peer, e, d);
    broadcast(room, reconnect ? 'peer-reconnected' : 'peer-joined', publicPeer(peer), peer.id);
    const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15000);
    req.on('close', () => {
      clearInterval(ping);
      if (peer.res !== res) return; // superseded by a newer connection
      peer.res = null;
      // Grace period: mobile networks drop streams briefly; keep the seat for 20 s.
      peer.graceTimer = setTimeout(() => removePeer(room, peer, 'disconnected'), 20000);
    });
    return;
  }

  // Everything below needs an authenticated peer.
  const authFrom = async (limit) => {
    const body = await readJson(req, limit);
    const p = authPeer(room, body.peer, body.token);
    return [p, body];
  };

  if (sub === 'signal' && m === 'POST') {
    const [peer, body] = await authFrom(256 * 1024);
    if (!peer) return fail(res, 401, 'unauthorized');
    const target = room.peers.get(String(body.to || ''));
    if (!target) return fail(res, 404, 'peer_not_found');
    send(target, 'signal', { from: peer.id, data: body.data });
    return json(res, 200, { ok: true });
  }

  if (sub === 'state' && m === 'POST') {
    const [peer, body] = await authFrom();
    if (!peer) return fail(res, 401, 'unauthorized');
    const s = body.state || {};
    peer.state = { mic: !!s.mic, cam: !!s.cam, hand: !!s.hand, lang: providers.LANGS.includes(s.lang) ? s.lang : undefined };
    if (s.name) peer.name = clean(s.name, 32);
    broadcast(room, 'peer-state', publicPeer(peer), peer.id);
    return json(res, 200, { ok: true });
  }

  if (sub === 'leave' && m === 'POST') {
    const [peer] = await authFrom();
    if (peer) removePeer(room, peer, 'left');
    return json(res, 200, { ok: true });
  }

  // Text from browser speech recognition (fallback) -> translate & broadcast
  if (sub === 'caption' && m === 'POST') {
    const [peer, body] = await authFrom();
    if (!peer) return fail(res, 401, 'unauthorized');
    const lang = providers.LANGS.includes(body.lang) ? body.lang : null;
    if (!lang) return fail(res, 400, 'bad_lang');
    if (!allow(`cap:${peer.id}`, 120, 60e3)) return fail(res, 429, 'rate_limited');
    const msg = await publishCaption(room, peer, lang, body.text);
    return json(res, 200, { ok: true, id: msg?.id });
  }

  // POST /api/rooms/:id/asr?peer=&token=&lang=   body: audio/wav 16 kHz mono
  if (sub === 'asr' && m === 'POST') {
    const peer = authPeer(room, url.searchParams.get('peer'), url.searchParams.get('token'));
    if (!peer) return fail(res, 401, 'unauthorized');
    const lang = url.searchParams.get('lang');
    const p = providers.asrFor(lang);
    if (!p) return fail(res, 400, 'asr_unavailable', { lang });
    if (!allow(`asr:${peer.id}`, 60, 60e3)) return fail(res, 429, 'rate_limited');
    const wav = await readBody(req, 2 * 1024 * 1024);
    let text = '';
    try { text = await p.asr(lang, wav); } catch (e) { console.warn('[asr]', p.name, e.message); return fail(res, 502, 'asr_failed'); }
    if (text) publishCaption(room, peer, lang, text).catch((e) => console.warn('[caption]', e.message));
    return json(res, 200, { text });
  }

  return fail(res, 404, 'not_found');
}

/* ------------------------------ static files ------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), fullscreen=(self)',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'",
};
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || /^\/r\/[A-Za-z0-9]{4,12}\/?$/.test(p)) p = '/index.html';
  if (p === '/diag') p = '/diag.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) return fail(res, 403, 'forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return fail(res, 404, 'not_found');
    const ext = path.extname(file);
    const headers = { ...SEC_HEADERS, 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' };
    if (req.headers['x-forwarded-proto'] === 'https' || cfg.tlsCert) headers['Strict-Transport-Security'] = 'max-age=31536000';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ------------------------------ server ------------------------------ */
async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method_not_allowed');
    return serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) fail(res, e.status || 500, e.status ? e.message : 'server_error');
    if (!e.status) console.error(e);
  }
}

function start(port = cfg.port, host = cfg.host) {
  const server = cfg.tlsCert
    ? https.createServer({ cert: fs.readFileSync(cfg.tlsCert), key: fs.readFileSync(cfg.tlsKey) }, handler)
    : http.createServer(handler);
  server.keepAliveTimeout = 65000;
  server.requestTimeout = 0; // SSE streams are long-lived
  return new Promise((resolve) => server.listen(port, host, () => {
    const a = server.address();
    console.log(`CAM线上琴房 v${VERSION} listening on ${cfg.tlsCert ? 'https' : 'http'}://${host}:${a.port}`);
    console.log(`  captions asr: zh=${providers.asrFor('zh')?.name || '-'} ru=${providers.asrFor('ru')?.name || '-'} en=${providers.asrFor('en')?.name || '-'}  translate=${providers.translator()?.name || '-'}`);
    console.log(`  ice: stun=${cfg.stunUrls.length} turn=${cfg.turnUrls.length && cfg.turnSecret ? cfg.turnUrls.length : 0}`);
    resolve(server);
  }));
}

if (require.main === module) {
  start();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
}
module.exports = { start, rooms };
