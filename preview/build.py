import re, base64, pathlib
R = pathlib.Path('/home/claude/cam-qinfang')
pub = R/'public'
def mod(name, src):
    exports = []
    def imp(m):
        names, path = m.group(1), m.group(2)
        key = pathlib.Path(path).stem
        return f"const {{{names}}} = __m['{key}'];"
    src = re.sub(r"^import \{([^}]*)\} from '\./([^']+)';", imp, src, flags=re.M)
    for m in re.finditer(r"^export (?:async )?(?:function|class|const|let) (\w+)", src, flags=re.M):
        exports.append(m.group(1))
    src = re.sub(r"^export (?=(async |function|class|const|let))", "", src, flags=re.M)
    return f"__m['{name}'] = (() => {{\n{src}\nreturn {{ {', '.join(exports)} }};\n}})();\n"

i18n = (pub/'js/i18n.js').read_text()
i18n = i18n.replace("errDenied: '浏览器拒绝了权限，请在地址栏左侧允许摄像头和麦克风'", "errDenied: '预览页面不能使用真实摄像头和麦克风，已换成演示画面；部署到服务器后即可正常使用'")
i18n = i18n.replace("errDenied: 'Браузер запретил доступ — разрешите камеру и микрофон слева от адреса'", "errDenied: 'В предпросмотре камера и микрофон недоступны — показано демо-видео; после развёртывания всё работает'")
i18n = i18n.replace("errDenied: 'Permission denied — allow camera and microphone next to the address bar'", "errDenied: 'This preview cannot use a real camera or microphone, so a demo picture is shown; it works once deployed'")
beauty = (pub/'js/beauty.js').read_text().replace("new Worker('/js/ticker.js')", "new Worker(URL.createObjectURL(new Blob([TICKER_SRC], { type: 'text/javascript' })))")
ticker = (pub/'js/ticker.js').read_text()
app = (pub/'js/app.js').read_text()
app = app.replace("location.pathname", "__nav.path").replace("history.pushState({}, '', ", "__nav.go(")
app = app.replace("`${location.origin}/r/${state.roomId}`", "`https://你的域名/r/${state.roomId}`")
app = app.replace("if (confirm(t('confirmLeave')))", "if (true)")
media_patch = """
{ const M = __m['media']; const ra = M.acquire, rv = M.getVideo;
  M.acquire = async (s, o) => { const r = await ra(s, o); if (!r.video) { r.video = demoStream('self').getVideoTracks()[0]; } if (!r.audio && !r.errors.video) r.errors.video = r.errors.audio; return r; };
  M.getVideo = async (s) => { try { return await rv(s); } catch { return demoStream('self').getVideoTracks()[0]; } }; }
"""
js = "const __m = {};\nconst TICKER_SRC = " + repr(ticker).replace("\\n","\\n") + ";\n"
js += (R/'preview/mock.js').read_text() + "\n"
js += mod('i18n', i18n) + mod('icons', (pub/'js/icons.js').read_text()) + mod('media', (pub/'js/media.js').read_text()) + media_patch
js += mod('beauty', beauty) + mod('captions', (pub/'js/captions.js').read_text())
js += mod('api', (R/'preview/mock-api.js').read_text()) + mod('rtc', (R/'preview/mock-rtc.js').read_text())
js += """
{ const note = document.getElementById('previewNote'); const { getLang } = __m['i18n'];
  const T = { zh: '界面预览：未连接服务器，对方画面与字幕为演示内容', ru: 'Предпросмотр: без сервера, собеседник и субтитры — демо', en: 'Interface preview: no server, the other person and captions are a demo' };
  const upd = () => { note.textContent = T[getLang()] || T.zh; }; upd(); document.addEventListener('i18n', upd); }
"""
js += mod('app', app)
js = js.replace("</script", "<\\/script")

html = (pub/'index.html').read_text()
body = html.split('<body>',1)[1].rsplit('</body>',1)[0]
body = re.sub(r'<script type="module" src="/js/app.js"></script>', '', body)
logo = 'data:image/png;base64,' + base64.b64encode((pub/'assets/logo.png').read_bytes()).decode()
body = body.replace('src="/assets/logo.png"', f'src="{logo}"')
css = (pub/'styles.css').read_text()
css += """
.diag-link { display: none !important; }
.preview-note { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(10px + env(safe-area-inset-bottom, 0px)); z-index: 90; max-width: calc(100% - 32px); padding: 6px 14px; border-radius: 999px; background: rgba(191, 227, 255, .14); border: 1px solid var(--line-strong); color: var(--ice-200); font-size: 12px; text-align: center; pointer-events: none; backdrop-filter: blur(8px); }
body[data-view="room"] .preview-note { bottom: auto; top: calc(58px + env(safe-area-inset-top, 0px)); }
"""
out = f"""<title>CAM线上琴房</title>
<meta name="theme-color" content="#0A1A33">
<style>
{css}
</style>
<div id="previewNote" class="preview-note"></div>
{body}
<script>
{js}
</script>
"""
(R/'preview/cam-qinfang-preview.html').write_text(out)
print(len(out))
