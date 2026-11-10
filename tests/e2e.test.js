'use strict';
// End-to-end tests in real Chrome with fake camera/microphone, served over HTTPS
// on a non-localhost hostname (cam.test) — the same conditions as production.
// Run: npm run test:e2e   (needs Chrome + playwright; PLAYWRIGHT_PATH / CHROME_PATH to override)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');

const PW = process.env.PLAYWRIGHT_PATH || '/opt/npm-tools/node_modules/playwright';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const { chromium } = require(PW);
const ROOT = path.join(__dirname, '..');
const PORT = 18443;
const BASE = `https://cam.test:${PORT}`;

let srv; let browser;
const ARGS = [
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-audio-capture=${path.join(__dirname, 'fixtures/speechlike.wav')}`,
  `--host-resolver-rules=MAP cam.test 127.0.0.1`, '--autoplay-policy=no-user-gesture-required',
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-sandbox', '--no-proxy-server',
];

test.before(async () => {
  srv = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', TLS_CERT: 'tests/certs/cert.pem', TLS_KEY: 'tests/certs/key.pem',
      ASR_ZH: 'mock', ASR_RU: 'mock', ASR_EN: 'mock', TRANSLATE: 'mock' },
  });
  await new Promise((res, rej) => { srv.stdout.on('data', (d) => { if (/listening/.test(d)) res(); }); srv.on('exit', rej); });
  browser = await chromium.launch({ executablePath: CHROME, args: ARGS });
});
test.after(async () => { await browser?.close(); srv?.kill(); });

async function newPage(locale = 'zh-CN', opts = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale, viewport: { width: 1280, height: 800 }, permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'], ...opts });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.logs = [];
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') page.logs.push(m.text().slice(0, 300)); });
  page.on('dialog', (d) => d.accept());
  return page;
}
async function createRoom(page, name = '测试琴房') {
  await page.goto(BASE + '/');
  await page.fill('#cName', name);
  await page.click('#createBtn');
  await page.waitForURL(/\/r\/[A-Z0-9]{6}$/);
  return page.url().split('/r/')[1];
}
async function joinFromPrejoin(page, name, role = 'student') {
  await page.waitForSelector('#prejoin:not([hidden])');
  await page.fill('#pName', name);
  await page.click(`#pRole button[data-v=${role}]`);
  await page.click('#joinBtn');
  await page.waitForSelector('#room:not([hidden])');
}
// Wait until the page renders a live remote video (frames advancing).
async function waitRemoteVideo(page, timeout = 45000) {
  try {
    await page.waitForFunction(() => {
      const v = document.querySelector('.tile:not(.self) video');
      if (!v || v.readyState < 2 || !v.videoWidth) return false;
      v._t ??= v.currentTime; return v.currentTime > v._t + 0.3;
    }, null, { timeout, polling: 200 });
  } catch (e) {
    const s = await page.evaluate(() => ({
      peers: [...(window.__cam.pm?.peers.values() || [])].map((x) => [x.id, x.pc.connectionState, x.pc.iceConnectionState, x.pc.signalingState]),
      videos: [...document.querySelectorAll('.tile:not(.self) video')].map((v) => [v.readyState, v.videoWidth, v.paused, v.currentTime, v.srcObject?.getTracks().map((t) => `${t.kind}:${t.readyState}:${t.muted}`)]),
    })).catch(() => ({}));
    e.message += ` — state ${JSON.stringify(s)} logs ${JSON.stringify(page.logs.filter((l) => !/GL Driver|DOM\]/.test(l)).slice(-8))}`;
    throw e;
  }
}
async function pair() {
  const teacher = await newPage('zh-CN');
  const id = await createRoom(teacher);
  await joinFromPrejoin(teacher, '王老师', 'teacher');
  const student = await newPage('ru-RU');
  await student.goto(`${BASE}/r/${id}`); // invite link
  await joinFromPrejoin(student, 'Иван', 'student');
  await Promise.all([waitRemoteVideo(teacher), waitRemoteVideo(student)]);
  return { teacher, student, id };
}
const closeAll = async (...pages) => { for (const p of pages) await p.context().close(); };

/* ------------------------------------------------------------------ */

test('HTTPS secure context on a real hostname; room is created and joined via invite link', async () => {
  const { teacher, student } = await pair();
  assert.equal(await teacher.evaluate(() => window.isSecureContext), true);
  // both directions: video + audio tracks arriving
  for (const p of [teacher, student]) {
    const kinds = await p.evaluate(() => document.querySelector('.tile:not(.self) video').srcObject.getTracks().map((t) => t.kind).sort());
    assert.deepEqual(kinds, ['audio', 'video']);
  }
  // names / roles shown
  assert.match(await student.textContent('.tile:not(.self) .nm'), /王老师/);
  assert.equal(await student.textContent('#rCode'), await teacher.textContent('#rCode'));
  assert.deepEqual([...teacher.errors, ...student.errors], []);
  await closeAll(teacher, student);
});

test('music mode: no NS/AGC/AEC on the mic, stereo high-bitrate Opus negotiated', async () => {
  const { teacher, student } = await pair();
  const s = await teacher.evaluate(() => window.__cam.audio.getSettings());
  assert.equal(s.noiseSuppression, false); assert.equal(s.autoGainControl, false); assert.equal(s.echoCancellation, false);
  const sdp = await student.evaluate(() => [...window.__cam.pm.peers.values()][0].pc.remoteDescription.sdp);
  assert.match(sdp, /a=fmtp:\d+ .*stereo=1/); assert.match(sdp, /maxaveragebitrate=192000/);
  const audioBitrate = await teacher.evaluate(async () => {
    const pc = [...window.__cam.pm.peers.values()][0].pc;
    const a = async () => { let b = 0; (await pc.getStats()).forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'audio') b = r.bytesSent; }); return b; };
    const b0 = await a(); await new Promise((r) => setTimeout(r, 2000)); return ((await a()) - b0) * 8 / 2;
  });
  assert.ok(audioBitrate > 0, 'audio is flowing');
  await closeAll(teacher, student);
});

test('manual switch to noise reduction replaces the mic track without dropping the call', async () => {
  const { teacher, student } = await pair();
  await teacher.click('#tSet');
  await teacher.click('#sMode button[data-v=voice]');
  await teacher.waitForFunction(() => window.__cam.audio.getSettings().noiseSuppression === true);
  const s = await teacher.evaluate(() => window.__cam.audio.getSettings());
  assert.equal(s.echoCancellation, true);
  assert.match(await teacher.textContent('#rMode'), /语音降噪/);
  const sentTrack = await teacher.evaluate(() => [...window.__cam.pm.peers.values()][0].audioTx.sender.track === window.__cam.audio);
  assert.equal(sentTrack, true);
  await waitRemoteVideo(student); // still connected
  assert.equal(await student.evaluate(() => [...window.__cam.pm.peers.values()][0].pc.connectionState), 'connected');
  await closeAll(teacher, student);
});

// Samples the remote video on the receiver every decoded frame and looks for flicker:
// black frames, and single-frame spikes (brightness jumps away and straight back).
async function sampleRemote(page, ms) {
  return page.evaluate((ms) => new Promise((resolve) => {
    const v = document.querySelector('.tile:not(.self) video');
    const c = document.createElement('canvas'); c.width = 64; c.height = 36;
    const g = c.getContext('2d', { willReadFrequently: true });
    const out = []; const t0 = performance.now();
    const step = () => {
      g.drawImage(v, 0, 0, 64, 36);
      const d = g.getImageData(0, 0, 64, 36).data; let s = 0;
      for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      out.push(s / (d.length / 4));
      if (performance.now() - t0 < ms) v.requestVideoFrameCallback(step); else resolve(out);
    };
    v.requestVideoFrameCallback(step);
  }), ms);
}
function flickerReport(xs) {
  const sorted = [...xs].sort((a, b) => a - b); const med = sorted[Math.floor(sorted.length / 2)];
  const black = xs.filter((x) => x < med * 0.25).length;
  let spikes = 0;
  for (let i = 1; i < xs.length - 1; i++) {
    const a = xs[i] - xs[i - 1]; const b = xs[i] - xs[i + 1];
    if (Math.abs(a) > med * 0.2 && Math.abs(b) > med * 0.2 && Math.sign(a) === Math.sign(b)) spikes++;
  }
  return { frames: xs.length, median: med, black, spikes };
}
const setRange = (page, sel, v) => page.evaluate(([sel, v]) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, [sel, v]);

test('beauty is off by default, and toggling / adjusting it never flickers', async () => {
  const { teacher, student } = await pair();
  assert.equal(await teacher.evaluate(() => window.__cam.beautyLive), false, 'default off');
  const before = flickerReport(await sampleRemote(student, 3000));
  const baseFps = before.frames / 3;

  await teacher.click('#tSet');
  const sampling = sampleRemote(student, 9000);
  await teacher.waitForTimeout(500);
  // Hammer it: on, rapid slider sweeps, off, on, camera quality change while on.
  await teacher.check('#sBeauty');
  await teacher.waitForFunction(() => window.__cam.beautyLive === true);
  for (let i = 0; i <= 20; i++) { await setRange(teacher, '#sSmooth', (i * 37) % 101); await teacher.waitForTimeout(40); }
  for (let i = 30; i <= 60; i += 5) { await setRange(teacher, '#sBright', i); await teacher.waitForTimeout(60); }
  await teacher.uncheck('#sBeauty'); await teacher.waitForTimeout(400);
  await teacher.check('#sBeauty'); await teacher.waitForTimeout(400);
  await teacher.uncheck('#sBeauty'); await teacher.check('#sBeauty');
  await teacher.waitForFunction(() => window.__cam.beautyLive === true);
  const xs = await sampling;
  const r = flickerReport(xs);
  console.log('  beauty flicker report', JSON.stringify(r), 'baseline', JSON.stringify(before));
  const fps = r.frames / 9;
  // On machines without a GPU (CI, this sandbox) Chrome falls back to SwiftShader, where *every* WebGL
  // canvas starves the whole tab — including the camera itself. There we only require the stream to keep
  // flowing; on a real GPU it must keep at least half of the baseline frame rate.
  const renderer = await teacher.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl'); const ext = gl.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ''; });
  const software = /swiftshader|llvmpipe|software/i.test(renderer);
  console.log(`  renderer: ${renderer} → ${fps.toFixed(1)} fps with beauty vs ${baseFps.toFixed(1)} baseline`);
  assert.ok(fps >= (software ? 3 : baseFps * 0.5), `remote kept receiving frames (${fps.toFixed(1)} fps vs baseline ${baseFps.toFixed(1)})`);
  assert.equal(r.black, 0, 'no black frames');
  assert.ok(r.spikes <= 1, `no single-frame flashes (got ${r.spikes})`);

  // The filter really changes the picture: brightening raises luminance on the far end.
  await setRange(teacher, '#sBright', 100); await teacher.waitForTimeout(1200);
  const bright = flickerReport(await sampleRemote(student, 1000)).median;
  assert.ok(bright > before.median * 1.05, `brightening visible remotely (${before.median.toFixed(1)} → ${bright.toFixed(1)})`);
  // The outgoing track is the beauty canvas track and the local preview shows the canvas
  assert.equal(await teacher.evaluate(() => [...window.__cam.pm.peers.values()][0].videoTx.sender.track === window.__cam.beauty.track), true);
  assert.equal(await teacher.evaluate(() => document.querySelector('.tile.self').classList.contains('beauty-live')), true);
  assert.deepEqual(teacher.errors, []);
  await closeAll(teacher, student);
});

test('beauty keeps producing frames while the tab is hidden (worker ticker)', async () => {
  const { teacher, student } = await pair();
  await teacher.click('#tSet'); await teacher.check('#sBeauty');
  await teacher.waitForFunction(() => window.__cam.beautyLive === true);
  await teacher.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  const f0 = await teacher.evaluate(() => window.__cam.beauty.frames);
  await teacher.waitForTimeout(1500);
  const f1 = await teacher.evaluate(() => window.__cam.beauty.frames);
  assert.ok(f1 - f0 > 20, `frames while hidden: ${f1 - f0}`);
  assert.equal(await teacher.evaluate(() => !!window.__cam.beauty.ticker), true);
  await closeAll(teacher, student);
});

test('a lost signalling message does not leave the call stuck (watchdog rebuilds the connection)', async () => {
  const teacher = await newPage('zh-CN');
  const id = await createRoom(teacher);
  await joinFromPrejoin(teacher, '王老师', 'teacher');
  const student = await newPage('ru-RU');
  // Drop every outgoing signalling message from the student for the first 3 seconds of the call.
  await student.addInitScript(() => {
    const iv = setInterval(() => {
      const sig = window.__cam?.signaling;
      if (!sig || sig._patched) return;
      sig._patched = true; const real = sig.signal.bind(sig); const t0 = Date.now();
      sig.signal = (to, data) => (Date.now() - t0 < 3000 ? Promise.resolve({ dropped: true }) : real(to, data));
      clearInterval(iv);
    }, 5);
  });
  await student.goto(`${BASE}/r/${id}`);
  await joinFromPrejoin(student, 'Иван');
  await Promise.all([waitRemoteVideo(teacher, 60000), waitRemoteVideo(student, 60000)]);
  await closeAll(teacher, student);
});

test('works through proxies/tunnels that block the event stream (long-poll fallback)', async () => {
  const teacher = await newPage('zh-CN');
  const id = await createRoom(teacher);
  await joinFromPrejoin(teacher, '王老师', 'teacher');
  const student = await newPage('ru-RU');
  // Simulate a tunnel that never delivers server-sent events
  await student.addInitScript(() => { window.EventSource = class extends EventTarget { constructor() { super(); } close() {} }; });
  await student.goto(`${BASE}/r/${id}`);
  await joinFromPrejoin(student, 'Иван');
  await Promise.all([waitRemoteVideo(teacher, 60000), waitRemoteVideo(student, 60000)]);
  assert.equal(await student.evaluate(() => window.__cam.signaling.transport), 'poll');
  await closeAll(teacher, student);
});

test('fullscreen on a video tile', async () => {
  const { teacher, student } = await pair();
  await student.hover('.tile:not(.self)');
  await student.click('.tile:not(.self) .fs');
  await student.waitForFunction(() => document.fullscreenElement?.classList.contains('tile'));
  await student.evaluate(() => document.exitFullscreen());
  await student.click('#tFull');
  await student.waitForFunction(() => !!document.fullscreenElement);
  await closeAll(teacher, student);
});

test('live captions: speech from the mic → server ASR → translated subtitles on the other side', async () => {
  const { teacher, student } = await pair();
  // teacher speaks Chinese, student reads Russian
  await student.click('#tSet'); await student.selectOption('#sCapShow', 'ru'); await student.click('#dClose');
  await teacher.click('#tSet'); await teacher.selectOption('#sCapLang', 'zh'); await teacher.click('#dClose');
  await teacher.click('#tCC');
  await student.waitForFunction(() => [...document.querySelectorAll('#captionBox .cap span')].some((s) => s.textContent.startsWith('[ru] 测试字幕')), null, { timeout: 20000 });
  const txt = await student.textContent('#captionBox');
  assert.match(txt, /王老师/);
  await closeAll(teacher, student);
});

test('"cannot create room" safeguards: expired code can be reopened, and joining works without camera permission', async () => {
  const p = await newPage('en-US');
  await p.goto(`${BASE}/r/QW3RTY`);
  await p.waitForSelector('#preErr:not([hidden]) .link-btn');
  await p.click('#preErr .link-btn');
  await p.waitForSelector('#preErr', { state: 'hidden' });
  await joinFromPrejoin(p, 'Host', 'teacher');
  assert.equal(await p.textContent('#rCode'), 'QW3RTY');

  // A second participant who denies camera/mic still gets into the room
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: [] });
  const denied = await ctx.newPage();
  await denied.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); });
  await denied.goto(`${BASE}/r/QW3RTY`);
  await denied.waitForSelector('#preMediaErr:not([hidden])');
  assert.match(await denied.textContent('#preMediaErr'), /(权限|Permission|запретил)/);
  await joinFromPrejoin(denied, 'Viewer');
  await waitRemoteVideo(denied); // can still watch the host
  await closeAll(p, denied);
});

test('Russian interface and code-entry flow from the home page', async () => {
  const t = await newPage('zh-CN');
  const id = await createRoom(t);
  const r = await newPage('ru-RU');
  await r.goto(BASE + '/');
  assert.equal(await r.textContent('#createBtn'), 'Создать класс');
  await r.fill('#jCode', id.toLowerCase());
  await r.click('#joinForm button[type=submit]');
  await r.waitForSelector('#prejoin:not([hidden])');
  assert.equal(await r.textContent('#preCode'), id);
  await closeAll(t, r);
});
