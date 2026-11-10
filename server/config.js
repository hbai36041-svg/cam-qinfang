'use strict';
// All configuration comes from environment variables (see deploy/.env.example).
const env = process.env;
// `node server/server.js --demo` (or DEMO=1): demo captions without any cloud account — works the same on Windows and macOS
const demo = process.argv.includes('--demo') || env.DEMO === '1';
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);

module.exports = {
  port: int(env.PORT, 8080),
  host: env.HOST || '0.0.0.0',
  tlsCert: env.TLS_CERT || '',          // optional: serve HTTPS directly (otherwise put Caddy/Nginx in front)
  tlsKey: env.TLS_KEY || '',
  trustProxy: env.TRUST_PROXY !== '0',
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),

  maxPeers: int(env.MAX_PEERS, 6),
  roomTtlHours: int(env.ROOM_TTL_HOURS, 24),
  maxRooms: int(env.MAX_ROOMS, 2000),

  // ICE. Self-hosted coturn with "use-auth-secret" (TURN REST credentials).
  // Public Google STUN is blocked in mainland China, so never rely on it.
  stunUrls: list(env.STUN_URLS),
  turnUrls: list(env.TURN_URLS),
  turnSecret: env.TURN_SECRET || '',
  turnTtl: int(env.TURN_TTL, 12 * 3600),

  // Captions. Per spoken language, which recogniser to use: tencent | yandex | openai | mock | none
  asr: {
    zh: env.ASR_ZH || (demo ? 'mock' : 'none'),
    ru: env.ASR_RU || (demo ? 'mock' : 'none'),
    en: env.ASR_EN || (demo ? 'mock' : 'none'),
  },
  // Translation: tencent | yandex | openai | mock | none
  translate: env.TRANSLATE || (demo ? 'mock' : 'none'),

  tencent: {
    secretId: env.TENCENT_SECRET_ID || '',
    secretKey: env.TENCENT_SECRET_KEY || '',
    region: env.TENCENT_REGION || 'ap-hongkong',
    asrHost: env.TENCENT_ASR_HOST || 'asr.tencentcloudapi.com',
    tmtHost: env.TENCENT_TMT_HOST || 'tmt.tencentcloudapi.com',
  },
  yandex: {
    apiKey: env.YANDEX_API_KEY || '',
    folderId: env.YANDEX_FOLDER_ID || '',
    sttUrl: env.YANDEX_STT_URL || 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize',
    translateUrl: env.YANDEX_TRANSLATE_URL || 'https://translate.api.cloud.yandex.net/translate/v2/translate',
  },
  // Optional. Any OpenAI-compatible endpoint works for translation (e.g. Alibaba DashScope
  // compatible-mode, Azure OpenAI gateway). Note OpenAI itself does not serve CN/HK/RU.
  openai: {
    apiKey: env.OPENAI_API_KEY || '',
    baseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    asrModel: env.OPENAI_ASR_MODEL || 'gpt-4o-mini-transcribe',
    translateModel: env.OPENAI_TRANSLATE_MODEL || 'gpt-4o-mini',
  },
};
