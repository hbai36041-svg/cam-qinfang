// UI strings: Chinese / Russian / English
const S = {
  zh: {
    app: 'CAM线上琴房', tagline: '夏空音乐学院 · 线上小提琴教学',
    create: '创建琴房', join: '加入琴房', roomName: '琴房名称（可选）', password: '密码（可选）',
    code: '琴房号', codePh: '输入 6 位琴房号', enter: '进入', yourName: '您的名字', role: '身份',
    teacher: '教授', student: '学生', joinNow: '进入琴房', back: '返回',
    mic: '麦克风', cam: '摄像头', captions: '字幕', invite: '邀请', fullscreen: '全屏', settings: '设置', leave: '离开',
    copied: '已复制邀请链接', copyLink: '复制链接', share: '分享', inviteText: '邀请您进入 CAM线上琴房',
    waiting: '等待其他人加入…', waitingSub: '把邀请链接发给学生或教授即可', you: '我',
    s_device: '设备', s_audio: '音频', s_beauty: '美颜', s_captions: '字幕翻译', s_general: '通用',
    camera: '摄像头', microphone: '麦克风', speaker: '扬声器', quality: '画质', mirror: '镜像本地画面',
    audioMode: '声音模式', modeMusic: '音乐原声', modeMusicSub: '关闭降噪与自动增益，完整保留琴声泛音（建议戴耳机）',
    modeVoice: '语音降噪', modeVoiceSub: '开启降噪、回声消除，适合讲解与嘈杂环境',
    echo: '回声消除', echoSub: '未戴耳机时开启，可防止对方听到回声', stereo: '立体声采集',
    bitrate: '音频码率',
    beautyOn: '美颜', smooth: '磨皮', bright: '提亮', beautyPro: '专业美颜 SDK', beautyProNone: '未接入（使用内置）',
    capLang: '我说的语言', capShow: '字幕显示为', capOrig: '同时显示原文', capEngine: '识别服务',
    capUnavailable: '服务器未配置该语言的识别服务', capBrowser: '浏览器识别', capOff: '字幕已关闭',
    uiLang: '界面语言', network: '网络', diag: '网络诊断',
    errNoMedia: '无法使用摄像头/麦克风：', errInsecure: '必须通过 HTTPS 访问才能使用摄像头和麦克风',
    errDenied: '浏览器拒绝了权限，请在地址栏左侧允许摄像头和麦克风', errNotFound: '未检测到设备', errBusy: '设备被其他程序占用',
    joinWithout: '仍可进入琴房观看和收听',
    errRoom: '琴房不存在或已过期', reopen: '以此房号重新开启', errFull: '琴房人数已满', errPw: '密码错误',
    errNet: '网络连接失败，请重试', errCreate: '创建失败', retry: '重试', reconnecting: '正在重新连接…',
    left: '离开了琴房', joined: '进入了琴房', confirmLeave: '确定离开琴房？',
    good: '良好', fair: '一般', poor: '较差', headphones: '音乐原声模式下建议佩戴耳机',
    q1080: '1080p 高清', q720: '720p 标准', q480: '480p 省流',
    langZh: '中文', langRu: 'Русский', langEn: 'English', on: '开', off: '关', default: '默认',
    hostTip: '房号', created: '琴房已创建', pin: '放大',
  },
  ru: {
    app: 'CAM线上琴房', tagline: 'Академия музыки «Чаккона» · онлайн-уроки скрипки',
    create: 'Создать класс', join: 'Войти в класс', roomName: 'Название (необязательно)', password: 'Пароль (необязательно)',
    code: 'Номер класса', codePh: '6-значный номер', enter: 'Войти', yourName: 'Ваше имя', role: 'Роль',
    teacher: 'Преподаватель', student: 'Студент', joinNow: 'Войти в класс', back: 'Назад',
    mic: 'Микрофон', cam: 'Камера', captions: 'Субтитры', invite: 'Пригласить', fullscreen: 'Во весь экран', settings: 'Настройки', leave: 'Выйти',
    copied: 'Ссылка скопирована', copyLink: 'Копировать', share: 'Поделиться', inviteText: 'Приглашение в CAM线上琴房',
    waiting: 'Ожидание участников…', waitingSub: 'Отправьте ссылку студенту или преподавателю', you: 'Я',
    s_device: 'Устройства', s_audio: 'Звук', s_beauty: 'Бьюти-фильтр', s_captions: 'Субтитры и перевод', s_general: 'Общие',
    camera: 'Камера', microphone: 'Микрофон', speaker: 'Динамики', quality: 'Качество', mirror: 'Зеркалить своё видео',
    audioMode: 'Режим звука', modeMusic: 'Оригинальный звук', modeMusicSub: 'Без шумоподавления и АРУ — сохраняет обертоны скрипки (лучше в наушниках)',
    modeVoice: 'Шумоподавление', modeVoiceSub: 'Шумо- и эхоподавление для объяснений и шумной обстановки',
    echo: 'Эхоподавление', echoSub: 'Включите без наушников, чтобы собеседник не слышал эхо', stereo: 'Стерео',
    bitrate: 'Битрейт звука',
    beautyOn: 'Бьюти-фильтр', smooth: 'Сглаживание', bright: 'Осветление', beautyPro: 'Проф. SDK', beautyProNone: 'не подключён (встроенный)',
    capLang: 'Мой язык', capShow: 'Показывать на', capOrig: 'Показывать оригинал', capEngine: 'Распознавание',
    capUnavailable: 'Распознавание для этого языка не настроено на сервере', capBrowser: 'браузер', capOff: 'Субтитры выключены',
    uiLang: 'Язык интерфейса', network: 'Сеть', diag: 'Диагностика сети',
    errNoMedia: 'Нет доступа к камере/микрофону: ', errInsecure: 'Для камеры и микрофона нужен HTTPS',
    errDenied: 'Браузер запретил доступ — разрешите камеру и микрофон слева от адреса', errNotFound: 'Устройство не найдено', errBusy: 'Устройство занято другой программой',
    joinWithout: 'Можно войти, чтобы смотреть и слушать',
    errRoom: 'Класс не найден или истёк', reopen: 'Открыть заново с этим номером', errFull: 'Класс заполнен', errPw: 'Неверный пароль',
    errNet: 'Ошибка сети, повторите', errCreate: 'Не удалось создать', retry: 'Повторить', reconnecting: 'Переподключение…',
    left: 'вышел(а)', joined: 'вошёл(а)', confirmLeave: 'Выйти из класса?',
    good: 'хорошая', fair: 'средняя', poor: 'плохая', headphones: 'В режиме оригинального звука используйте наушники',
    q1080: '1080p', q720: '720p', q480: '480p (эконом)',
    langZh: '中文', langRu: 'Русский', langEn: 'English', on: 'Вкл', off: 'Выкл', default: 'По умолчанию',
    hostTip: 'Номер', created: 'Класс создан', pin: 'Увеличить',
  },
  en: {
    app: 'CAM线上琴房', tagline: 'Ciaconna Academy of Music · Online violin lessons',
    create: 'Create room', join: 'Join room', roomName: 'Room name (optional)', password: 'Password (optional)',
    code: 'Room code', codePh: '6-character code', enter: 'Enter', yourName: 'Your name', role: 'Role',
    teacher: 'Professor', student: 'Student', joinNow: 'Join room', back: 'Back',
    mic: 'Mic', cam: 'Camera', captions: 'Captions', invite: 'Invite', fullscreen: 'Fullscreen', settings: 'Settings', leave: 'Leave',
    copied: 'Invite link copied', copyLink: 'Copy link', share: 'Share', inviteText: 'Join me in CAM线上琴房',
    waiting: 'Waiting for others…', waitingSub: 'Send the invite link to your student or professor', you: 'Me',
    s_device: 'Devices', s_audio: 'Audio', s_beauty: 'Beauty', s_captions: 'Captions & translation', s_general: 'General',
    camera: 'Camera', microphone: 'Microphone', speaker: 'Speaker', quality: 'Quality', mirror: 'Mirror my preview',
    audioMode: 'Sound mode', modeMusic: 'Original sound', modeMusicSub: 'No noise suppression or auto-gain — keeps violin overtones (headphones recommended)',
    modeVoice: 'Noise reduction', modeVoiceSub: 'Noise & echo suppression for talking or noisy rooms',
    echo: 'Echo cancellation', echoSub: 'Turn on without headphones so others do not hear an echo', stereo: 'Stereo capture',
    bitrate: 'Audio bitrate',
    beautyOn: 'Beauty', smooth: 'Smoothing', bright: 'Brightening', beautyPro: 'Pro beauty SDK', beautyProNone: 'not connected (built-in)',
    capLang: 'I speak', capShow: 'Show captions in', capOrig: 'Also show original', capEngine: 'Recognition',
    capUnavailable: 'No recogniser configured on the server for this language', capBrowser: 'browser', capOff: 'Captions off',
    uiLang: 'Interface language', network: 'Network', diag: 'Network check',
    errNoMedia: 'Cannot use camera/microphone: ', errInsecure: 'HTTPS is required for camera and microphone',
    errDenied: 'Permission denied — allow camera and microphone next to the address bar', errNotFound: 'No device found', errBusy: 'Device is in use by another app',
    joinWithout: 'You can still join to watch and listen',
    errRoom: 'Room not found or expired', reopen: 'Reopen with this code', errFull: 'Room is full', errPw: 'Wrong password',
    errNet: 'Network error, please retry', errCreate: 'Could not create room', retry: 'Retry', reconnecting: 'Reconnecting…',
    left: 'left', joined: 'joined', confirmLeave: 'Leave the room?',
    good: 'good', fair: 'fair', poor: 'poor', headphones: 'Use headphones in original sound mode',
    q1080: '1080p HD', q720: '720p', q480: '480p (data saver)',
    langZh: '中文', langRu: 'Русский', langEn: 'English', on: 'On', off: 'Off', default: 'Default',
    hostTip: 'Code', created: 'Room created', pin: 'Enlarge',
  },
};

function detect() {
  const saved = localStorage.getItem('cam.ui');
  if (saved && S[saved]) return saved;
  const n = (navigator.language || 'zh').toLowerCase();
  return n.startsWith('ru') ? 'ru' : n.startsWith('zh') ? 'zh' : n.startsWith('en') ? 'en' : 'zh';
}
let lang = (() => { try { return detect(); } catch { return 'zh'; } })();

export const t = (k) => S[lang][k] ?? S.zh[k] ?? k;
export const getLang = () => lang;
export function setLang(l) {
  if (!S[l]) return;
  lang = l;
  try { localStorage.setItem('cam.ui', l); } catch {}
  applyI18n();
}
export function applyI18n(root = document) {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); el.setAttribute('aria-label', t(el.dataset.i18nTitle)); });
  document.dispatchEvent(new CustomEvent('i18n'));
}
