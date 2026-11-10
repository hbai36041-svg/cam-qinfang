// Camera / microphone acquisition tuned for violin.
// "music" mode disables every voice-processing stage that damages a violin's sound:
//   noise suppression eats sustained tones & overtones, AGC pumps dynamics,
//   echo cancellation ducks the instrument while the other side talks.
export const QUALITY = {
  '1080': { width: 1920, height: 1080, bitrate: 4_000_000 },
  '720': { width: 1280, height: 720, bitrate: 2_500_000 },
  '480': { width: 854, height: 480, bitrate: 900_000 },
};

export function audioConstraints(s) {
  const music = s.audioMode === 'music';
  const c = {
    echoCancellation: music ? !!s.echo : true,
    noiseSuppression: !music,
    autoGainControl: !music,
    sampleRate: { ideal: 48000 },
    sampleSize: { ideal: 16 },
    channelCount: { ideal: music && s.stereo ? 2 : 1 },
    latency: { ideal: 0.01 },
  };
  // Chromium legacy flags — some builds still honour them and re-enable processing otherwise.
  if (music) Object.assign(c, { googEchoCancellation: !!s.echo, googAutoGainControl: false, googNoiseSuppression: false, googHighpassFilter: false });
  if (s.micId) c.deviceId = { exact: s.micId };
  return c;
}
export function videoConstraints(s) {
  const q = QUALITY[s.quality] || QUALITY['720'];
  const c = { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: 30, max: 30 } };
  if (s.camId) c.deviceId = { exact: s.camId };
  return c;
}

export function mediaErrorKey(e) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return 'errInsecure';
  switch (e?.name) {
    case 'NotAllowedError': case 'SecurityError': return 'errDenied';
    case 'NotFoundError': case 'OverconstrainedError': return 'errNotFound';
    case 'NotReadableError': case 'AbortError': return 'errBusy';
    default: return 'errNotFound';
  }
}

async function gum(c) {
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('insecure'), { name: 'SecurityError' });
  return navigator.mediaDevices.getUserMedia(c);
}

// Acquire audio and video separately so one failing device never blocks the other.
export async function acquire(s, { audio = true, video = true } = {}) {
  const out = { audio: null, video: null, errors: {} };
  const tasks = [];
  if (audio) tasks.push(getAudio(s).then((t) => { out.audio = t; }, (e) => { out.errors.audio = e; }));
  if (video) tasks.push(getVideo(s).then((t) => { out.video = t; }, (e) => { out.errors.video = e; }));
  await Promise.all(tasks);
  return out;
}

export async function getAudio(s) {
  let st;
  try { st = await gum({ audio: audioConstraints(s) }); } catch (e) {
    if (s.micId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) st = await gum({ audio: audioConstraints({ ...s, micId: '' }) });
    else throw e;
  }
  const t = st.getAudioTracks()[0];
  try { t.contentHint = s.audioMode === 'music' ? 'music' : 'speech'; } catch {}
  return t;
}
export async function getVideo(s) {
  let st;
  try { st = await gum({ video: videoConstraints(s) }); } catch (e) {
    if (s.camId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) st = await gum({ video: videoConstraints({ ...s, camId: '' }) });
    else throw e;
  }
  const t = st.getVideoTracks()[0];
  try { t.contentHint = 'motion'; } catch {} // keep frame-rate for bowing motion
  return t;
}

export async function listDevices() {
  try {
    const d = await navigator.mediaDevices.enumerateDevices();
    return {
      mics: d.filter((x) => x.kind === 'audioinput'),
      cams: d.filter((x) => x.kind === 'videoinput'),
      speakers: d.filter((x) => x.kind === 'audiooutput'),
    };
  } catch { return { mics: [], cams: [], speakers: [] }; }
}

// --- SDP: ask the remote encoder for full-band stereo Opus at a high bitrate. ---
// These fmtp parameters describe what *we* want to receive, so they are applied
// to the description we hand to the other side's encoder via setRemoteDescription.
export function tuneOpus(sdp, { bitrate = 256000, stereo = true } = {}) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!m) return sdp;
  const pt = m[1];
  const want = { stereo: stereo ? 1 : 0, 'sprop-stereo': stereo ? 1 : 0, maxaveragebitrate: bitrate, maxplaybackrate: 48000, useinbandfec: 1, usedtx: 0, cbr: 0, minptime: 10 };
  const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  const merge = (existing) => {
    const kv = Object.fromEntries(existing.split(';').filter(Boolean).map((p) => p.trim().split('=')));
    Object.assign(kv, want);
    return Object.entries(kv).map(([k, v]) => `${k}=${v}`).join(';');
  };
  if (re.test(sdp)) return sdp.replace(re, (_, p) => `a=fmtp:${pt} ${merge(p)}`);
  return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${merge('')}`);
}
