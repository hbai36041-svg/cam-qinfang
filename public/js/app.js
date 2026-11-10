import { t, setLang, getLang, applyI18n } from './i18n.js';
import { api, apiRetry, Signaling } from './api.js';
import { acquire, getAudio, getVideo, listDevices, mediaErrorKey } from './media.js';
import { PeerManager, connectionQuality } from './rtc.js';
import { BeautyEngine, processors } from './beauty.js';
import { CaptionCapture, browserSpeechAvailable } from './captions.js';
import { I } from './icons.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ------------------------------ settings ------------------------------ */
const DEFAULTS = {
  camId: '', micId: '', speakerId: '', quality: '720', mirror: true,
  audioMode: 'music', echo: false, stereo: true, audioBitrate: 192,
  beauty: false, smooth: 50, bright: 30, beautyProc: 'builtin',
  capLang: null, capShow: null, capOrig: true, captions: false,
  name: '', role: 'student',
};
const S = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('cam.settings') || '{}'); } catch {}
  const s = { ...DEFAULTS, ...saved };
  s.beauty = false; // 美颜默认关闭: every session starts with beauty off
  s.capLang ||= getLang(); s.capShow ||= getLang();
  return s;
})();
const save = () => { try { localStorage.setItem('cam.settings', JSON.stringify(S)); } catch {} };

/* ------------------------------ state ------------------------------ */
const state = {
  config: null, roomId: null, room: null, peerId: null, signaling: null, pm: null,
  audio: null, video: null, micOn: true, camOn: true,
  beauty: null, beautyLive: false, beautyStopTimer: null,
  tiles: new Map(), peers: new Map(), pinned: null, captions: null, capMsgs: new Map(),
  joinedAt: 0, timers: [],
};
window.__cam = state; // for diagnostics & tests

/* ------------------------------ helpers ------------------------------ */
let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
function showErr(el, msg) { el.textContent = msg || ''; el.hidden = !msg; }
function show(view) { for (const v of ['home', 'prejoin', 'room']) $(`#${v}`).hidden = v !== view; document.body.dataset.view = view; }
const inviteLink = () => `${location.origin}/r/${state.roomId}`;
const errText = (code) => ({ room_not_found: t('errRoom'), room_full: t('errFull'), bad_password: t('errPw'), network: t('errNet') }[code] || `${t('errNet')} (${code})`);
function iconize() {
  const map = { '#preBack': I.back, '#preSettings': I.gear, '#dClose': I.close, '#iClose': I.close,
    '#tInvite i': I.invite, '#tFull i': I.full, '#tSet i': I.gear, '#tLeave i': I.leave, '#tCC i': I.cc };
  for (const [sel, svg] of Object.entries(map)) { const el = $(sel); if (el) el.innerHTML = svg; }
  syncToggles();
}

/* ------------------------------ home ------------------------------ */
function initHome() {
  $$('.langsel button').forEach((b) => b.addEventListener('click', () => { setLang(b.dataset.lang); markLang(); }));
  $('#createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#createBtn'); btn.disabled = true; showErr($('#createErr'), '');
    try {
      const pw = $('#cPw').value;
      const r = await apiRetry('/api/rooms', { method: 'POST', body: { name: $('#cName').value, password: pw } });
      if (pw) sessionStorage.setItem(`cam.pw.${r.id}`, pw);
      sessionStorage.setItem(`cam.host.${r.id}`, '1');
      history.pushState({}, '', `/r/${r.id}`);
      toast(`${t('created')} · ${r.id}`);
      await route();
    } catch (err) {
      showErr($('#createErr'), `${t('errCreate')}: ${errText(err.code)}`);
    } finally { btn.disabled = false; }
  });
  const code = $('#jCode');
  code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^0-9A-Z]/g, ''); });
  $('#joinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const c = code.value.trim();
    if (c.length < 4) { showErr($('#joinErr'), t('codePh')); return; }
    // Accept a pasted full invite link too
    history.pushState({}, '', `/r/${c}`);
    await route();
  });
}
function markLang() { $$('.langsel button').forEach((b) => b.classList.toggle('on', b.dataset.lang === getLang())); $('#sUi').value = getLang(); }

/* ------------------------------ local tile & media ------------------------------ */
function makeTile(id, name, isSelf) {
  const el = document.createElement('div');
  el.className = `tile${isSelf ? ' self' : ''}`;
  el.dataset.id = id;
  el.innerHTML = `
    <video playsinline autoplay ${isSelf ? 'muted' : ''}></video>
    <div class="tile-off">${I.note}</div>
    <div class="tile-label"><span class="mic-ind"></span><span class="nm"></span></div>
    <div class="tile-actions">
      <button class="tile-btn pin" title="${t('pin')}">${I.pin}</button>
      <button class="tile-btn fs" title="${t('fullscreen')}">${I.full}</button>
    </div>`;
  const video = el.querySelector('video');
  el.querySelector('.nm').textContent = name;
  el.querySelector('.fs').addEventListener('click', (e) => { e.stopPropagation(); toggleFullscreen(el); });
  el.querySelector('.pin').addEventListener('click', (e) => { e.stopPropagation(); state.pinned = state.pinned === id ? null : id; layout(); });
  el.addEventListener('dblclick', () => toggleFullscreen(el));
  const tile = { el, video, id, isSelf };
  state.tiles.set(id, tile);
  return tile;
}
function selfTile() {
  return state.tiles.get('self') || makeTile('self', S.name || t('you'), true);
}
function attachLocalVideo() {
  const tile = selfTile();
  tile.el.classList.toggle('mirror', !!S.mirror);
  if (state.video && tile.video.srcObject?.getVideoTracks()[0] !== state.video) tile.video.srcObject = new MediaStream([state.video]);
  if (!state.video) tile.video.srcObject = null;
  tile.video.play().catch(() => {});
  tile.el.classList.toggle('cam-off', !state.video || !state.camOn);
  // Beauty canvas lives inside the same tile; we only flip visibility after its first frame.
  if (state.beauty && state.beauty.canvas.parentNode !== tile.el) tile.el.insertBefore(state.beauty.canvas, tile.video.nextSibling);
  tile.el.classList.toggle('beauty-live', state.beautyLive);
}

async function startMedia() {
  const r = await acquire(S);
  state.audio = r.audio; state.video = r.video;
  state.micOn = !!r.audio; state.camOn = !!r.video;
  if (state.audio) state.audio.enabled = state.micOn;
  const errs = Object.values(r.errors);
  if (errs.length) {
    const key = mediaErrorKey(errs[0]);
    showErr($('#preMediaErr'), `${t('errNoMedia')}${t(key)}${!r.audio && !r.video ? ` — ${t('joinWithout')}` : ''}`);
  } else showErr($('#preMediaErr'), '');
  attachLocalVideo();
  startMeter();
  await fillDevices();
  if (S.beauty) await setBeauty(true);
}

let meterRaf;
function startMeter() {
  cancelAnimationFrame(meterRaf);
  if (!state.audio) return;
  try {
    const ctx = state.meterCtx || (state.meterCtx = new AudioContext());
    state.meterSrc?.disconnect();
    const an = ctx.createAnalyser(); an.fftSize = 512;
    state.meterSrc = ctx.createMediaStreamSource(new MediaStream([state.audio]));
    state.meterSrc.connect(an);
    const buf = new Float32Array(an.fftSize);
    const bar = $('#meterBar');
    const tick = () => {
      an.getFloatTimeDomainData(buf);
      let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v));
      bar.style.transform = `scaleX(${Math.min(1, peak * 1.6)})`;
      if (document.body.dataset.view === 'prejoin') meterRaf = requestAnimationFrame(tick);
    };
    tick();
  } catch {}
}

/* ------------------------------ beauty (flicker-free swaps) ------------------------------ */
function outgoingVideo() { return state.camOn ? (state.beautyLive ? state.beauty.track : state.video) : null; }

async function setBeauty(on) {
  S.beauty = on; save();
  clearTimeout(state.beautyStopTimer);
  if (on && state.video) {
    try {
      if (!state.beauty || state.beauty.processorName !== S.beautyProc) {
        state.beauty?.destroy();
        state.beauty = new BeautyEngine(S.beautyProc);
        state.beauty.addEventListener('lost', () => { state.beautyLive = false; swapVideo(); });
        state.beauty.addEventListener('restored', () => { if (S.beauty) { state.beautyLive = true; swapVideo(); } });
      }
      state.beauty.setParams({ smooth: S.smooth / 100, bright: S.bright / 100 });
      attachLocalVideo();
      await state.beauty.start(state.video); // resolves only after a real processed frame exists
      if (!S.beauty) return; // toggled off meanwhile
      state.beautyLive = true;
    } catch (e) {
      console.warn('beauty failed', e); state.beautyLive = false; S.beauty = false; $('#sBeauty').checked = false;
    }
  } else {
    state.beautyLive = false;
    // Keep the pipeline warm briefly so quick on/off doesn't rebuild it.
    state.beautyStopTimer = setTimeout(() => state.beauty?.pause(), 3000);
  }
  await swapVideo();
}
async function swapVideo() {
  attachLocalVideo();
  if (state.pm) await state.pm.setTrack('video', outgoingVideo());
}

/* ------------------------------ device switching ------------------------------ */
async function switchCamera() {
  if (!state.camOn) return;
  try {
    const nv = await getVideo(S);
    const old = state.video;
    state.video = nv;
    if (state.beauty && state.beautyLive) state.beauty.setSource(nv); // canvas keeps last frame until new one arrives
    await swapVideo();
    old?.stop();
  } catch (e) { toast(t(mediaErrorKey(e))); }
}
async function switchAudio() {
  try {
    const na = await getAudio(S);
    na.enabled = state.micOn;
    const old = state.audio;
    state.audio = na;
    if (state.pm) { await state.pm.setTrack('audio', na); await state.pm.applyEncoding(); }
    old?.stop();
    startMeter();
    if (state.captions?.active) startCaptions();
  } catch (e) { toast(t(mediaErrorKey(e))); }
  syncModeChip();
}

async function toggleMic() {
  if (!state.audio) { await switchAudio(); if (!state.audio) return; state.micOn = true; state.audio.enabled = true; state.pm?.setTrack('audio', state.audio); }
  else { state.micOn = !state.micOn; state.audio.enabled = state.micOn; }
  syncToggles(); pushState();
}
async function toggleCam() {
  if (state.camOn) {
    state.camOn = false;
    if (state.pm) await state.pm.setTrack('video', null);
    state.beauty?.pause(); state.beautyLive = false;
    state.video?.stop(); state.video = null;
  } else {
    try { state.video = await getVideo(S); state.camOn = true; } catch (e) { toast(t(mediaErrorKey(e))); return; }
    if (S.beauty) await setBeauty(true); else await swapVideo();
  }
  attachLocalVideo(); syncToggles(); pushState();
}
function syncToggles() {
  for (const [btn, on, onI, offI] of [['#tMic', state.micOn, I.mic, I.micOff], ['#tCam', state.camOn, I.cam, I.camOff], ['#preMic', state.micOn, I.mic, I.micOff], ['#preCam', state.camOn, I.cam, I.camOff]]) {
    const el = $(btn); if (!el) continue;
    el.classList.toggle('off', !on);
    (el.querySelector('i') || el).innerHTML = on ? onI : offI;
  }
  $('#tCC')?.classList.toggle('active', !!S.captions);
  const self = state.tiles.get('self');
  if (self) { self.el.classList.toggle('muted', !state.micOn); self.el.classList.toggle('cam-off', !state.camOn); }
}
function syncModeChip() {
  const el = $('#rMode'); if (!el) return;
  el.innerHTML = `${S.audioMode === 'music' ? I.note : I.wave}<span>${t(S.audioMode === 'music' ? 'modeMusic' : 'modeVoice')}</span>`;
  el.classList.toggle('music', S.audioMode === 'music');
  $('#headHint').hidden = S.audioMode !== 'music';
  $('#sEchoWrap').hidden = S.audioMode !== 'music';
}

/* ------------------------------ settings drawer ------------------------------ */
async function fillDevices() {
  const d = await listDevices();
  const fill = (sel, list, cur) => {
    const real = list.filter((x) => x.deviceId && x.deviceId !== 'default' && x.deviceId !== 'communications');
    sel.innerHTML = `<option value="">${t('default')}</option>` + real
      .map((x, i) => `<option value="${x.deviceId}">${(x.label || `#${i + 1}`).replace(/</g, '&lt;')}</option>`).join('');
    sel.value = real.some((x) => x.deviceId === cur) ? cur : '';
  };
  fill($('#sCam'), d.cams, state.video?.getSettings().deviceId || S.camId);
  fill($('#sMic'), d.mics, state.audio?.getSettings().deviceId || S.micId);
  fill($('#sSpk'), d.speakers, S.speakerId);
  $('#sSpkWrap').hidden = !('setSinkId' in HTMLMediaElement.prototype) || !d.speakers.length;
}
function fillProcessors() {
  const sel = $('#sProc');
  sel.innerHTML = processors().map((p) => `<option value="${p}">${p === 'builtin' ? t('beautyProNone') : p}</option>`).join('');
  sel.value = processors().includes(S.beautyProc) ? S.beautyProc : 'builtin';
}
function openDrawer(open = true) {
  $('#drawer').classList.toggle('open', open);
  $('#drawer').setAttribute('aria-hidden', String(!open));
  $('#scrim').hidden = !open;
  if (open) { fillDevices(); fillProcessors(); syncCapEngine(); }
}
function initDrawer() {
  $('#dClose').addEventListener('click', () => openDrawer(false));
  $('#scrim').addEventListener('click', () => openDrawer(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { openDrawer(false); $('#inviteDlg').hidden = true; } });

  $('#sCam').addEventListener('change', (e) => { S.camId = e.target.value; save(); switchCamera(); });
  $('#sMic').addEventListener('change', (e) => { S.micId = e.target.value; save(); switchAudio(); });
  $('#sSpk').addEventListener('change', (e) => { S.speakerId = e.target.value; save(); applySink(); });
  $('#sQuality').value = S.quality;
  $('#sQuality').addEventListener('change', async (e) => { S.quality = e.target.value; save(); await switchCamera(); state.pm?.applyEncoding(); });
  $('#sMirror').checked = S.mirror;
  $('#sMirror').addEventListener('change', (e) => { S.mirror = e.target.checked; save(); attachLocalVideo(); });

  const markMode = () => $$('#sMode button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.audioMode));
  markMode();
  $$('#sMode button').forEach((b) => b.addEventListener('click', () => { if (S.audioMode === b.dataset.v) return; S.audioMode = b.dataset.v; save(); markMode(); switchAudio(); }));
  $('#sEcho').checked = S.echo;
  $('#sEcho').addEventListener('change', (e) => { S.echo = e.target.checked; save(); switchAudio(); });
  $('#sStereo').checked = S.stereo;
  $('#sStereo').addEventListener('change', (e) => { S.stereo = e.target.checked; save(); switchAudio(); });
  $('#sBitrate').value = String(S.audioBitrate);
  $('#sBitrate').addEventListener('change', (e) => { S.audioBitrate = +e.target.value; save(); state.pm?.applyEncoding(); });

  $('#sBeauty').checked = S.beauty;
  $('#sBeauty').addEventListener('change', (e) => setBeauty(e.target.checked));
  for (const k of ['smooth', 'bright']) {
    const inp = $(`#s${k[0].toUpperCase()}${k.slice(1)}`); const out = $(`#o${k[0].toUpperCase()}${k.slice(1)}`);
    inp.value = S[k]; out.textContent = S[k];
    inp.addEventListener('input', () => {
      S[k] = +inp.value; out.textContent = inp.value;
      state.beauty?.setParams({ [k]: S[k] / 100 }); // uniforms only → no flicker
    });
    inp.addEventListener('change', save);
  }
  $('#sProc').addEventListener('change', (e) => { S.beautyProc = e.target.value; save(); if (S.beauty) setBeauty(true); });
  document.addEventListener('beauty-processors', fillProcessors);

  $('#sCapLang').value = S.capLang; $('#sCapShow').value = S.capShow; $('#sCapOrig').checked = S.capOrig;
  $('#sCapLang').addEventListener('change', (e) => { S.capLang = e.target.value; save(); syncCapEngine(); pushState(); if (S.captions) startCaptions(); });
  $('#sCapShow').addEventListener('change', (e) => { S.capShow = e.target.value; save(); renderCaptions(); });
  $('#sCapOrig').addEventListener('change', (e) => { S.capOrig = e.target.checked; save(); renderCaptions(); });
  $('#sUi').addEventListener('change', (e) => { setLang(e.target.value); markLang(); });
}
function applySink() {
  if (!S.speakerId) return;
  for (const tile of state.tiles.values()) if (!tile.isSelf) tile.video.setSinkId?.(S.speakerId).catch(() => {});
}

/* ------------------------------ captions ------------------------------ */
function captionMode() {
  if (state.config?.captions?.asr?.[S.capLang]) return 'server';
  if (browserSpeechAvailable()) return 'browser';
  return null;
}
function syncCapEngine() {
  const m = captionMode();
  const el = $('#capEngine');
  el.textContent = m === 'server' ? `${t('capEngine')}: ${state.config.captions.asr[S.capLang]}${state.config.captions.translate ? ` · → ${state.config.captions.translate}` : ''}`
    : m === 'browser' ? `${t('capEngine')}: ${t('capBrowser')}` : t('capUnavailable');
}
async function startCaptions() {
  if (!state.signaling) return;
  state.captions ||= new CaptionCapture(state.signaling);
  const mode = captionMode();
  if (!mode) { toast(t('capUnavailable')); S.captions = false; syncToggles(); return; }
  try { await state.captions.start(state.audio, S.capLang, mode); }
  catch (e) { console.warn(e); toast(t('capUnavailable')); }
}
async function toggleCaptions() {
  S.captions = !S.captions; save(); syncToggles();
  if (S.captions) await startCaptions(); else { await state.captions?.stop(); toast(t('capOff')); }
  renderCaptions();
}
function onCaption(msg) {
  state.capMsgs.set(msg.id, { ...msg, until: Date.now() + 9000 });
  while (state.capMsgs.size > 3) state.capMsgs.delete(state.capMsgs.keys().next().value);
  renderCaptions();
}
function renderCaptions() {
  const box = $('#captionBox');
  const now = Date.now();
  for (const [k, m] of state.capMsgs) if (m.until < now) state.capMsgs.delete(k);
  box.innerHTML = '';
  for (const m of state.capMsgs.values()) {
    const line = document.createElement('div'); line.className = 'cap';
    const shown = m.translations?.[S.capShow] || m.text;
    const nm = document.createElement('b'); nm.textContent = m.from === state.peerId ? t('you') : m.name;
    const tx = document.createElement('span'); tx.textContent = shown;
    line.append(nm, tx);
    if (S.capOrig && m.lang !== S.capShow && shown !== m.text) { const o = document.createElement('small'); o.textContent = m.text; line.append(o); }
    box.append(line);
  }
}
setInterval(renderCaptions, 1500);

/* ------------------------------ layout & fullscreen ------------------------------ */
function layout() {
  const stage = $('#stage');
  const remotes = [...state.tiles.values()].filter((x) => !x.isSelf);
  if (state.pinned && !state.tiles.has(state.pinned)) state.pinned = null;
  stage.dataset.count = String(remotes.length + 1);
  stage.classList.toggle('solo', remotes.length === 0);
  stage.classList.toggle('duo', remotes.length === 1 && !state.pinned);
  stage.classList.toggle('pinned', !!state.pinned);
  for (const tile of state.tiles.values()) {
    if (tile.el.parentNode !== stage && document.body.dataset.view === 'room') stage.appendChild(tile.el);
    tile.el.classList.toggle('is-pinned', state.pinned === tile.id);
    tile.el.classList.toggle('pip', remotes.length === 1 && !state.pinned && tile.isSelf);
  }
  $('#waiting').hidden = remotes.length > 0;
  for (const tile of state.tiles.values()) tile.video.play().catch(() => {});
}
function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement; }
async function toggleFullscreen(el) {
  try {
    if (fsElement()) { await (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else el.querySelector('video')?.webkitEnterFullscreen?.(); // iPhone Safari
  } catch (e) { console.warn('fullscreen', e); }
}
document.addEventListener('fullscreenchange', () => { const i = $('#tFull i'); if (i) i.innerHTML = fsElement() ? I.exitFull : I.full; });

/* ------------------------------ invite ------------------------------ */
async function copyInvite() {
  const text = inviteLink();
  try { await navigator.clipboard.writeText(text); toast(t('copied')); }
  catch { const i = $('#iLink'); i.value = text; i.select(); document.execCommand('copy'); toast(t('copied')); }
}
function openInvite() {
  $('#iCode').textContent = state.roomId; $('#iLink').value = inviteLink();
  $('#iShare').hidden = !navigator.share;
  $('#inviteDlg').hidden = false;
}

/* ------------------------------ prejoin ------------------------------ */
async function showPrejoin(id) {
  show('prejoin');
  state.roomId = id;
  $('#preCode').textContent = id;
  showErr($('#preErr'), '');
  $('#joinBtn').disabled = false;
  $('#pName').value = S.name;
  markRole();
  $('#previewSlot').appendChild(selfTile().el);
  try {
    const info = await apiRetry(`/api/rooms/${id}`);
    state.room = info;
    $('#preRoomName').textContent = info.name;
    $('#pPwWrap').hidden = !info.hasPassword;
    $('#pPw').value = sessionStorage.getItem(`cam.pw.${id}`) || '';
    if (info.full) showErr($('#preErr'), t('errFull'));
  } catch (e) {
    $('#preRoomName').textContent = t('app');
    if (e.code === 'room_not_found') roomMissing(id); else showErr($('#preErr'), errText(e.code));
  }
  if (!state.audio && !state.video) await startMedia();
  else attachLocalVideo();
  if (!window.isSecureContext) showErr($('#preMediaErr'), t('errInsecure'));
}
function roomMissing(id) {
  const box = $('#preErr');
  box.hidden = false; box.textContent = `${t('errRoom')} `;
  const b = document.createElement('button'); b.type = 'button'; b.className = 'link-btn'; b.textContent = t('reopen');
  b.onclick = async () => {
    try { const r = await apiRetry('/api/rooms', { method: 'POST', body: { id } }); state.room = { ...r, hasPassword: false }; showErr(box, ''); $('#preRoomName').textContent = r.name; sessionStorage.setItem(`cam.host.${id}`, '1'); }
    catch (e) { showErr(box, errText(e.code)); }
  };
  box.append(b);
}
function markRole() { $$('#pRole button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.role)); }

function initPrejoin() {
  $$('#pRole button').forEach((b) => b.addEventListener('click', () => { S.role = b.dataset.v; save(); markRole(); }));
  $('#preBack').addEventListener('click', () => { stopMedia(); history.pushState({}, '', '/'); route(); });
  $('#preSettings').addEventListener('click', () => openDrawer(true));
  $('#preMic').addEventListener('click', toggleMic);
  $('#preCam').addEventListener('click', toggleCam);
  $('#preInvite').addEventListener('click', copyInvite);
  $('#prejoinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    S.name = $('#pName').value.trim() || t('you'); save();
    const btn = $('#joinBtn'); btn.disabled = true; showErr($('#preErr'), '');
    try { await joinRoom(); } catch (err) {
      if (err.code === 'room_not_found') roomMissing(state.roomId); else showErr($('#preErr'), errText(err.code));
      btn.disabled = false;
    }
  });
}

/* ------------------------------ room ------------------------------ */
async function joinRoom() {
  state.config = await apiRetry('/api/config');
  const pw = $('#pPw').value;
  const r = await apiRetry(`/api/rooms/${state.roomId}/join`, { method: 'POST', body: { name: S.name, role: S.role, password: pw } });
  if (pw) sessionStorage.setItem(`cam.pw.${state.roomId}`, pw);
  state.peerId = r.peerId;
  const sig = new Signaling(state.roomId, r.peerId, r.token);
  state.signaling = sig;
  const pm = new PeerManager({ signaling: sig, selfId: r.peerId, iceServers: state.config.iceServers, getSettings: () => S });
  state.pm = pm;
  pm.tracks.audio = state.audio; pm.tracks.video = outgoingVideo();

  pm.addEventListener('stream', ({ detail }) => {
    const tile = state.tiles.get(detail.id) || remoteTile(detail.id);
    if (tile.video.srcObject !== detail.stream) tile.video.srcObject = detail.stream;
    tile.video.play().catch(() => {});
    tile.el.classList.toggle('cam-off', !detail.stream.getVideoTracks().length);
    if (S.speakerId) tile.video.setSinkId?.(S.speakerId).catch(() => {});
  });
  pm.addEventListener('state', ({ detail }) => { const tile = state.tiles.get(detail.id); tile?.el.classList.toggle('connecting', detail.state !== 'connected'); });

  sig.addEventListener('hello', ({ detail }) => {
    $('#banner').hidden = true;
    for (const p of detail.peers) { state.peers.set(p.id, p); remoteTile(p.id); pm.ensure(p.id); applyPeerState(p); }
    layout();
  });
  sig.addEventListener('peer-joined', ({ detail: p }) => { state.peers.set(p.id, p); remoteTile(p.id); pm.ensure(p.id); applyPeerState(p); layout(); toast(`${p.name} ${t('joined')}`); });
  sig.addEventListener('peer-reconnected', ({ detail: p }) => { state.peers.set(p.id, p); if (!pm.peers.has(p.id)) pm.ensure(p.id); else pm.restartIce(p.id); });
  sig.addEventListener('peer-left', ({ detail }) => {
    const p = state.peers.get(detail.id); state.peers.delete(detail.id);
    pm.remove(detail.id); state.tiles.get(detail.id)?.el.remove(); state.tiles.delete(detail.id);
    layout(); if (p) toast(`${p.name} ${t('left')}`);
  });
  sig.addEventListener('peer-state', ({ detail }) => { state.peers.set(detail.id, detail); applyPeerState(detail); });
  sig.addEventListener('signal', ({ detail }) => pm.onSignal(detail.from, detail.data));
  sig.addEventListener('caption', ({ detail }) => onCaption(detail));
  sig.addEventListener('offline', () => { const b = $('#banner'); b.textContent = t('reconnecting'); b.hidden = false; });
  sig.addEventListener('online', () => { $('#banner').hidden = true; });
  sig.addEventListener('gone', async () => { // seat expired (long disconnect) → rejoin transparently
    leaveRoom(false);
    try { await joinRoom(); } catch (e) { toast(errText(e.code)); goHome(); }
  });
  sig.connect();

  show('room');
  $('#rName').textContent = r.room.name;
  $('#rCode').textContent = state.roomId;
  selfTile().el.querySelector('.nm').textContent = `${S.name} (${t('you')})`;
  layout();
  syncToggles(); syncModeChip();
  pushState();
  state.joinedAt = Date.now();
  state.timers.push(setInterval(tickTimer, 1000), setInterval(updateNet, 3000));
  if (S.captions) startCaptions();
  cancelAnimationFrame(meterRaf);
}
function remoteTile(id) {
  if (state.tiles.has(id)) return state.tiles.get(id);
  const p = state.peers.get(id);
  const tile = makeTile(id, p?.name || '…', false);
  tile.el.classList.add('connecting');
  if (p?.role === 'teacher') tile.el.classList.add('teacher');
  layout();
  return tile;
}
function applyPeerState(p) {
  const tile = state.tiles.get(p.id); if (!tile) return;
  tile.el.querySelector('.nm').textContent = `${p.name}${p.role === 'teacher' ? ` · ${t('teacher')}` : ''}`;
  tile.el.classList.toggle('muted', p.state?.mic === false);
  tile.el.classList.toggle('cam-off', p.state?.cam === false);
}
function pushState() { state.signaling?.state({ mic: state.micOn, cam: state.camOn, lang: S.capLang }); }
function tickTimer() {
  const s = Math.floor((Date.now() - state.joinedAt) / 1000);
  const h = Math.floor(s / 3600); const mm = String(Math.floor(s / 60) % 60).padStart(2, '0'); const ss = String(s % 60).padStart(2, '0');
  $('#rTimer').textContent = h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
async function updateNet() {
  const p = [...(state.pm?.peers.values() || [])][0];
  const el = $('#rNet');
  if (!p) { el.dataset.level = ''; el.querySelector('span').textContent = ''; return; }
  const q = await connectionQuality(p.pc);
  el.dataset.level = q.level;
  el.querySelector('span').textContent = `${t(q.level)}${q.rtt != null ? ` · ${Math.round(q.rtt * 1000)}ms` : ''}`;
}
function leaveRoom(stop = true) {
  state.timers.forEach(clearInterval); state.timers = [];
  state.captions?.stop(); state.captions = null;
  state.signaling?.leave(); state.signaling = null;
  state.pm?.closeAll(); state.pm = null;
  for (const [id, tile] of state.tiles) if (!tile.isSelf) { tile.el.remove(); state.tiles.delete(id); }
  state.peers.clear(); state.capMsgs.clear(); renderCaptions();
  if (stop) stopMedia();
}
function stopMedia() {
  cancelAnimationFrame(meterRaf);
  state.audio?.stop(); state.video?.stop(); state.audio = state.video = null;
  state.beauty?.destroy(); state.beauty = null; state.beautyLive = false;
  const self = state.tiles.get('self'); if (self) { self.el.remove(); state.tiles.delete('self'); }
}
function goHome() { history.pushState({}, '', '/'); route(); }

function initRoom() {
  $('#tMic').addEventListener('click', toggleMic);
  $('#tCam').addEventListener('click', toggleCam);
  $('#tCC').addEventListener('click', toggleCaptions);
  $('#tInvite').addEventListener('click', openInvite);
  $('#waitInvite').addEventListener('click', openInvite);
  $('#tFull').addEventListener('click', () => {
    const target = state.pinned ? state.tiles.get(state.pinned)?.el : [...state.tiles.values()].find((x) => !x.isSelf)?.el;
    toggleFullscreen(target || $('#room'));
  });
  $('#tSet').addEventListener('click', () => openDrawer(true));
  $('#rMode').addEventListener('click', () => openDrawer(true));
  $('#rCode').addEventListener('click', copyInvite);
  $('#tLeave').addEventListener('click', () => { if (confirm(t('confirmLeave'))) { leaveRoom(); goHome(); } });
  $('#iCopy').addEventListener('click', copyInvite);
  $('#iShare').addEventListener('click', () => navigator.share?.({ title: t('app'), text: `${t('inviteText')} · ${t('code')} ${state.roomId}`, url: inviteLink() }).catch(() => {}));
  $('#iClose').addEventListener('click', () => { $('#inviteDlg').hidden = true; });
  $('#inviteDlg').addEventListener('click', (e) => { if (e.target.id === 'inviteDlg') e.target.hidden = true; });
  window.addEventListener('pagehide', () => state.signaling?.leave());
  navigator.mediaDevices?.addEventListener?.('devicechange', () => { if ($('#drawer').classList.contains('open')) fillDevices(); });
}

/* ------------------------------ router ------------------------------ */
async function route() {
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9]{4,12})\/?$/);
  if (m) {
    const id = m[1].toUpperCase();
    if (state.signaling && state.roomId === id) return show('room');
    if (state.signaling) leaveRoom(false);
    return showPrejoin(id);
  }
  if (state.signaling) leaveRoom();
  stopMedia();
  show('home');
  markLang();
}
window.addEventListener('popstate', route);
document.addEventListener('i18n', () => { iconize(); syncModeChip(); syncCapEngine(); fillProcessors(); });

async function boot() {
  initHome(); initPrejoin(); initRoom(); initDrawer();
  applyI18n();
  api('/api/config').then((c) => { state.config = c; $('#sVersion').textContent = `v${c.version}`; syncCapEngine(); }).catch(() => {});
  await route();
}
boot();
