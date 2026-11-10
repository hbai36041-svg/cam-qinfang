// In-browser network diagnostics, meant to be run by real users in China and Russia.
const out = document.getElementById('out');
const report = {};
function row(key, label, value, cls = '') {
  let tr = document.getElementById(`r-${key}`);
  if (!tr) { tr = document.createElement('tr'); tr.id = `r-${key}`; out.appendChild(tr); }
  tr.innerHTML = `<td>${label}</td><td class="${cls}"></td>`;
  tr.lastChild.textContent = value;
  report[key] = value;
  document.getElementById('report').value = JSON.stringify({ time: new Date().toISOString(), ua: navigator.userAgent, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, ...report }, null, 2);
}
const ms = (n) => `${Math.round(n)} ms`;

async function ping(n = 8) {
  const xs = [];
  for (let i = 0; i < n; i++) { const t0 = performance.now(); await fetch('/api/diag/ping', { cache: 'no-store' }); xs.push(performance.now() - t0); }
  xs.sort((a, b) => a - b);
  return { median: xs[Math.floor(xs.length / 2)], max: xs[xs.length - 1] };
}
async function download() {
  const t0 = performance.now(); const r = await fetch('/api/diag/download', { cache: 'no-store' }); const b = await r.arrayBuffer();
  return (b.byteLength * 8) / ((performance.now() - t0) / 1000) / 1e6;
}
function gather(iceServers, policy) {
  return new Promise((resolve) => {
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: policy });
    const types = new Set(); const t0 = performance.now();
    pc.createDataChannel('x');
    pc.onicecandidate = (e) => { if (e.candidate) { const m = / typ (\w+)/.exec(e.candidate.candidate); if (m) types.add(m[1]); } else { pc.close(); resolve({ types: [...types], ms: performance.now() - t0 }); } };
    pc.createOffer().then((o) => pc.setLocalDescription(o));
    setTimeout(() => { pc.close(); resolve({ types: [...types], ms: performance.now() - t0, timeout: true }); }, 8000);
  });
}
async function loopback(iceServers) { // two peers that may only talk via TURN relay
  const a = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'relay' });
  const b = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'relay' });
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
  const ch = a.createDataChannel('t'); const t0 = performance.now();
  const opened = new Promise((r) => { ch.onopen = () => r(true); setTimeout(() => r(false), 10000); });
  await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription);
  const ok = await opened; a.close(); b.close();
  return { ok, ms: performance.now() - t0 };
}
function sseTest() {
  return new Promise(async (resolve) => {
    try {
      const room = await (await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'diag' }) })).json();
      const j = await (await fetch(`/api/rooms/${room.id}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'diag' }) })).json();
      const t0 = performance.now();
      const es = new EventSource(`/api/rooms/${room.id}/events?peer=${j.peerId}&token=${encodeURIComponent(j.token)}`);
      const done = (ok) => { es.close(); fetch(`/api/rooms/${room.id}/leave`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ peer: j.peerId, token: j.token }) }); resolve({ ok, ms: performance.now() - t0 }); };
      es.addEventListener('hello', () => done(true));
      setTimeout(() => done(false), 8000);
    } catch { resolve({ ok: false }); }
  });
}

async function run() {
  out.innerHTML = '';
  row('https', 'HTTPS / 安全上下文', window.isSecureContext ? 'OK' : 'NO — 需要 HTTPS', window.isSecureContext ? 'ok' : 'bad');
  row('webrtc', 'WebRTC', window.RTCPeerConnection ? 'OK' : 'NO', window.RTCPeerConnection ? 'ok' : 'bad');
  try {
    const p = await ping(); row('ping', '服务器延迟 · Задержка · RTT', `${ms(p.median)} (max ${ms(p.max)})`, p.median < 200 ? 'ok' : p.median < 400 ? 'warn' : 'bad');
    const d = await download(); row('down', '下载速度 · Скорость · Download', `${d.toFixed(1)} Mbps`, d > 5 ? 'ok' : d > 2 ? 'warn' : 'bad');
  } catch (e) { row('ping', '服务器 · Сервер · Server', `unreachable: ${e.message}`, 'bad'); return; }
  const s = await sseTest(); row('sse', '信令通道 · Сигналинг · Signalling', s.ok ? `OK ${ms(s.ms)}` : 'FAILED', s.ok ? 'ok' : 'bad');
  let cfg = {};
  try { cfg = await (await fetch('/api/config')).json(); } catch {}
  const ice = cfg.iceServers || [];
  row('iceConf', 'STUN/TURN 配置', ice.length ? ice.map((x) => [].concat(x.urls).join(' ')).join(' | ') : '未配置 · not configured', ice.length ? '' : 'bad');
  const g = await gather(ice, 'all'); row('cand', 'ICE 候选 · Кандидаты', g.types.join(', ') || 'none', g.types.includes('srflx') ? 'ok' : 'warn');
  const r = await gather(ice, 'relay'); row('relay', 'TURN 中继 · TURN relay', r.types.includes('relay') ? `OK ${ms(r.ms)}` : 'FAILED', r.types.includes('relay') ? 'ok' : 'bad');
  if (r.types.includes('relay')) { const l = await loopback(ice); row('loop', 'TURN 回环 · TURN loopback', l.ok ? `OK ${ms(l.ms)}` : 'FAILED', l.ok ? 'ok' : 'bad'); }
  try {
    const c = cfg.captions || {};
    row('cap', '字幕服务 · Субтитры · Captions', `asr zh=${c.asr?.zh || '-'} ru=${c.asr?.ru || '-'} en=${c.asr?.en || '-'} · translate=${c.translate || '-'}`);
    const pr = await (await fetch('/api/diag/providers')).json();
    for (const [k, v] of Object.entries(pr.results || {})) row(`p-${k}`, `服务器→${k}`, v.reachable ? `OK ${ms(v.ms)} (HTTP ${v.status})` : `FAIL ${v.error}`, v.reachable ? 'ok' : 'warn');
  } catch {}
  try {
    const st = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    row('media', '摄像头/麦克风 · Камера/микрофон', st.getTracks().map((t) => `${t.kind}: ${t.label}`).join('; '), 'ok');
    st.getTracks().forEach((t) => t.stop());
  } catch (e) { row('media', '摄像头/麦克风 · Камера/микрофон', e.name, 'bad'); }
}
document.getElementById('run').onclick = run;
document.getElementById('copy').onclick = () => { const t = document.getElementById('report'); t.select(); navigator.clipboard?.writeText(t.value).catch(() => document.execCommand('copy')); };
