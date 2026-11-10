'use strict';
// Speech recognition + translation providers behind one small interface:
//   asr(lang, wavBuffer)        -> Promise<string>
//   translate(text, from, to)   -> Promise<string>
// lang codes inside the app: 'zh' | 'ru' | 'en'
const crypto = require('crypto');
const cfg = require('../config');

const TIMEOUT = 12000;
async function http(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split('?')[0]}: ${text.slice(0, 300)}`);
    return json ?? text;
  } finally { clearTimeout(t); }
}

// Strip a 44-byte canonical WAV header to raw 16-bit LE PCM.
function wavToPcm(buf) {
  if (buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF') {
    const idx = buf.indexOf('data', 12, 'ascii');
    if (idx > 0) return buf.subarray(idx + 8);
    return buf.subarray(44);
  }
  return buf;
}

/* ---------------------------- Tencent Cloud ---------------------------- */
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();

function tc3Headers({ service, host, action, version, region, body }) {
  const { secretId, secretKey } = cfg.tencent;
  const ts = Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const ct = 'application/json; charset=utf-8';
  const canonicalHeaders = `content-type:${ct}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(body)}`;
  const scope = `${date}/${service}/tc3_request`;
  const sts = `TC3-HMAC-SHA256\n${ts}\n${scope}\n${sha256(canonicalRequest)}`;
  const kSigning = hmac(hmac(hmac('TC3' + secretKey, date), service), 'tc3_request');
  const signature = crypto.createHmac('sha256', kSigning).update(sts).digest('hex');
  const h = {
    Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'Content-Type': ct, Host: host, 'X-TC-Action': action, 'X-TC-Timestamp': String(ts), 'X-TC-Version': version,
  };
  if (region) h['X-TC-Region'] = region;
  return h;
}
async function tencentCall(service, host, action, version, payload, region) {
  const body = JSON.stringify(payload);
  const r = await http(`https://${host}/`, { method: 'POST', headers: tc3Headers({ service, host, action, version, region, body }), body });
  if (r?.Response?.Error) throw new Error(`Tencent ${action}: ${r.Response.Error.Code} ${r.Response.Error.Message}`);
  return r.Response;
}
const tencent = {
  name: 'tencent',
  configured: () => !!(cfg.tencent.secretId && cfg.tencent.secretKey),
  langs: ['zh', 'en'], // Tencent sentence recognition has no Russian engine — use Yandex for ru
  async asr(lang, wav) {
    const engine = { zh: '16k_zh', en: '16k_en' }[lang];
    if (!engine) throw new Error(`tencent asr: unsupported ${lang}`);
    const r = await tencentCall('asr', cfg.tencent.asrHost, 'SentenceRecognition', '2019-06-14', {
      EngSerViceType: engine, SourceType: 1, VoiceFormat: 'wav', Data: wav.toString('base64'), DataLen: wav.length,
      FilterDirty: 0, FilterModal: 1, ConvertNumMode: 1,
    });
    return (r.Result || '').trim();
  },
  async translate(text, from, to) {
    const r = await tencentCall('tmt', cfg.tencent.tmtHost, 'TextTranslate', '2018-03-21',
      { SourceText: text, Source: from, Target: to, ProjectId: 0 }, cfg.tencent.region);
    return (r.TargetText || '').trim();
  },
};

/* ------------------------------ Yandex Cloud ------------------------------ */
const yandex = {
  name: 'yandex',
  configured: () => !!(cfg.yandex.apiKey && cfg.yandex.folderId),
  langs: ['ru', 'en'], // SpeechKit has no Chinese model
  async asr(lang, wav) {
    const code = { ru: 'ru-RU', en: 'en-US' }[lang];
    if (!code) throw new Error(`yandex asr: unsupported ${lang}`);
    const q = new URLSearchParams({ topic: 'general', lang: code, format: 'lpcm', sampleRateHertz: '16000', folderId: cfg.yandex.folderId, profanityFilter: 'false' });
    const r = await http(`${cfg.yandex.sttUrl}?${q}`, {
      method: 'POST', headers: { Authorization: `Api-Key ${cfg.yandex.apiKey}` }, body: wavToPcm(wav),
    });
    return (r.result || '').trim();
  },
  async translate(text, from, to) {
    const r = await http(cfg.yandex.translateUrl, {
      method: 'POST',
      headers: { Authorization: `Api-Key ${cfg.yandex.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: cfg.yandex.folderId, texts: [text], sourceLanguageCode: from, targetLanguageCode: to }),
    });
    return (r.translations?.[0]?.text || '').trim();
  },
};

/* ------------------------- OpenAI (optional) ------------------------- */
const LANG_NAME = { zh: 'Simplified Chinese', ru: 'Russian', en: 'English' };
const openai = {
  name: 'openai',
  configured: () => !!cfg.openai.apiKey,
  langs: ['zh', 'ru', 'en'],
  async asr(lang, wav) {
    const fd = new FormData();
    fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
    fd.append('model', cfg.openai.asrModel);
    fd.append('language', lang);
    fd.append('prompt', 'Violin lesson: bow, string, shift, vibrato, intonation, détaché, spiccato.');
    const r = await http(`${cfg.openai.baseUrl}/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${cfg.openai.apiKey}` }, body: fd, timeout: 20000,
    });
    return (r.text || '').trim();
  },
  async translate(text, from, to) {
    const r = await http(`${cfg.openai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.openai.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.openai.translateModel, temperature: 0,
        messages: [
          { role: 'system', content: `You translate live subtitles of a violin lesson from ${LANG_NAME[from]} to ${LANG_NAME[to]}. Keep musical terms accurate. Output only the translation.` },
          { role: 'user', content: text },
        ],
      }),
    });
    return (r.choices?.[0]?.message?.content || '').trim();
  },
};

/* ----------------------------- Mock (tests) ----------------------------- */
const mock = {
  name: 'mock',
  configured: () => true,
  langs: ['zh', 'ru', 'en'],
  async asr(lang, wav) {
    const secs = (wavToPcm(wav).length / 32000).toFixed(1);
    return { zh: `测试字幕 ${secs} 秒`, ru: `Тестовые субтитры ${secs} с`, en: `Test caption ${secs}s` }[lang];
  },
  async translate(text, from, to) { return `[${to}] ${text}`; },
};

const registry = { tencent, yandex, openai, mock };

function asrFor(lang) {
  const p = registry[cfg.asr[lang]];
  return p && p.configured() && p.langs.includes(lang) ? p : null;
}
function translator() {
  const p = registry[cfg.translate];
  return p && p.configured() ? p : null;
}

// Hosts the server must reach; used by /api/diag/providers.
function endpoints() {
  return {
    tencent_asr: `https://${cfg.tencent.asrHost}/`,
    tencent_tmt: `https://${cfg.tencent.tmtHost}/`,
    yandex_stt: cfg.yandex.sttUrl,
    yandex_translate: cfg.yandex.translateUrl,
    openai: `${cfg.openai.baseUrl}/models`,
  };
}

module.exports = { asrFor, translator, endpoints, registry, wavToPcm, tc3Headers, LANGS: ['zh', 'ru', 'en'] };
