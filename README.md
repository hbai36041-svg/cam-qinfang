# CAM线上琴房

夏空音乐学院（Ciaconna Academy of Music）的线上小提琴教学视频琴房。学生和教授用普通浏览器（Chrome / Edge / Safari / Firefox / 国产 Chromium 浏览器，电脑或手机）打开链接即可上课，无需安装、无需注册任何外部账号。

## 功能

| 需求 | 实现 |
|---|---|
| 实时视频、创建琴房、邀请、全屏 | WebRTC 点对点（最多 6 人），6 位易读房号（不含 0/O/1/I/L），复制链接/系统分享；视频块双击或按钮全屏，iPhone 走原生全屏 |
| 小提琴音乐原声（默认） | 关闭降噪/自动增益/回声消除，48 kHz 立体声 Opus，默认 192 kbps（可调到 256），开启 FEC、关闭 DTX；音轨标记为 music |
| 手动切换降噪 | 侧栏“声音模式”一键切到“语音降噪”，热替换麦克风轨道，通话不中断；原声模式下可单独开回声消除（未戴耳机时用） |
| 中/俄/英实时字幕翻译 | 浏览器分段采集说话声 → 服务器调用识别与翻译 → 推送给房间所有人，每人自选显示语言、可同时显示原文；持续长音（拉琴）会被自动过滤，不送去识别 |
| 美颜 | 默认关闭；WebGL 磨皮（保边双边滤波，仅作用于肤色）+ 提亮，滑杆实时调节；预留专业 SDK 接口 |
| 界面 | 深蓝 / 冰蓝 / 白，使用夏空 Logo；中文 / Русский / English 三语界面；设备、美颜、音频、字幕等次要设置集中在右侧设置栏 |
| 网络诊断 | `/diag` 页面：在中、俄当地网络打开即可测服务器延迟、带宽、信令、TURN 中继、字幕服务可达性，并生成可复制报告 |

## 本地运行

需要 Node.js ≥ 20，**零第三方依赖**（不需要 `npm install`）。

```bash
npm run dev          # 字幕用模拟服务，打开 http://localhost:8080
npm test             # 17 项服务端/逻辑测试
npm run test:e2e     # 10 项真实 Chrome 端到端测试（HTTPS、双人通话、美颜频闪检测、丢包自愈、字幕全链路…）
```

摄像头/麦克风只在 `https://` 或 `localhost` 下可用；局域网用 IP 访问会被浏览器拒绝，这是“打不开摄像头/无法进房”的最常见原因，界面会直接提示。

## 部署（HTTPS）

推荐：**香港**云服务器（腾讯云/阿里云香港，带 CN2 线路），2 核 4 GB、带宽 ≥ 10 Mbps 足够数个并发琴房。理由：
- 大陆服务器的域名必须 ICP 备案才能开放 443；香港不需要。
- 香港到大陆、到俄罗斯都有较好的线路；Docker Hub 在大陆无法直接拉取镜像，在香港可以。
- 媒体流优先点对点直连；只有在 NAT/防火墙阻断时才经服务器上的 TURN 中继。

```bash
# 1. 域名 A 记录指向服务器公网 IP；安全组放行：
#    TCP 80, 443, 3478, 5349   UDP 443, 3478, 49160-49400
# 2. 上传本项目到服务器
cd deploy && cp .env.example .env && nano .env      # 填 DOMAIN / PUBLIC_IP / TURN_SECRET / 字幕密钥
docker compose up -d --build
# 3. 首次签发证书后重启一次 coturn，让 TURNS(5349) 读到证书；之后每 60 天重启一次（可加 cron）
docker compose restart coturn
# 4. 自检
sh verify.sh your.domain.com
```

- `deploy/docker-compose.yml`：app + Caddy（自动申请/续期 Let's Encrypt 证书）+ coturn。
- 已有 Nginx 的服务器：用 `deploy/nginx.conf`（关键是信令路径 `proxy_buffering off`）+ `deploy/cam-qinfang.service` 直接跑 Node。
- 也可不用反向代理：设置 `TLS_CERT`/`TLS_KEY`，Node 直接提供 HTTPS。

### 字幕服务选择（中俄可用优先）

| 说话语言 | 默认识别服务 | 原因 |
|---|---|---|
| 中文 | 腾讯云 一句话识别（16k_zh） | 大陆与香港可用；腾讯云没有俄语识别引擎 |
| 俄语 | Yandex SpeechKit（ru-RU） | 俄罗斯本土服务；没有中文模型 |
| 英语 | 腾讯云 或 Yandex | 两者均支持 |
| 翻译 | 腾讯云机器翻译（TMT），可改 Yandex Translate | 均支持中↔俄↔英 |
| 可选 | OpenAI（`ASR_*=openai` / `TRANSLATE=openai`） | OpenAI 不对中国大陆、香港、俄罗斯提供服务；只有服务器在其支持地区，或 `OPENAI_BASE_URL` 指向你有权使用的兼容网关（如 Azure OpenAI、阿里云百炼兼容模式用于翻译）时才可用 |

未配置某语言的服务时，若浏览器自带语音识别（Chrome 在海外网络）会自动退回使用，否则提示“未配置”。

## 美颜：为什么不会闪，以及如何接入专业 SDK

`public/js/beauty.js` 头部逐条注释了频闪的 8 个成因和对应处理，核心几点：
- 画布用 `captureStream(0)`，每帧**完整绘制之后**才 `requestFrame()` 推送，从不推送半帧/清空帧；WebGL `alpha:false`，不会出现透明=黑帧。
- 美颜开启时先等第一帧真实处理完成，再“原子”替换发送轨道和本地预览；滑杆只改 shader 参数，不重建管线、不换轨道。
- 切换摄像头时保留上一帧直到新画面到来；标签页在后台时用 Worker 计时器继续出帧，对方不会卡住。
- 低性能设备上自动降低处理分辨率（只降不升，避免来回跳）。

端到端测试会在对方画面逐帧采样亮度，同时快速开关美颜、扫动滑杆，断言 0 黑帧、0 单帧闪烁。

接入相芯 FaceUnity、火山引擎、Banuba 等 Web SDK：在页面加载后调用

```js
window.CAMBeauty.register({
  name: 'faceunity',
  async init(canvas) { /* 初始化 SDK，绑定到 canvas */ },
  process(video, canvas, { smooth, bright }) { /* 把一帧画进 canvas */ return true; },
  destroy() {},
});
```

注册后设置栏“专业美颜 SDK”里即可选择，其余防频闪逻辑自动沿用。

## “无法创建琴房”的防护

- 创建琴房只是一个普通 HTTPS 请求，不依赖摄像头；失败会显示原因并可重试（网络抖动自动重试 3 次）。
- 摄像头/麦克风被拒绝、被占用或不存在时，仍可进房观看收听，并给出对应提示；非 HTTPS 访问会明确提示。
- 服务器重启或房间过期后，旧邀请链接可“以此房号重新开启”。
- 信令消息若在跨境/移动网络中丢失，连接看门狗会在 15 秒内自动重建连接，不会卡在“连接中”。
- 信令用 Server-Sent Events（普通 HTTPS 长连接），比 WebSocket 更不容易被代理/企业防火墙拦截；短暂断网 20 秒内保留座位并自动重连。
- 不依赖任何境外 CDN、字体或 Google STUN（这些在大陆被墙，是“页面卡住/连不上”的常见原因）。

## 目录

```
server/            Node 服务（静态文件、REST、SSE 信令、TURN 临时凭证、字幕识别与翻译代理）
public/            前端（无构建步骤）
  js/rtc.js        WebRTC（perfect negotiation、Opus 调优、码率控制）
  js/media.js      采集约束（音乐原声 / 语音降噪）
  js/beauty.js     美颜管线与 SDK 接口
  js/captions.js   语音分段与上传
  diag.html        网络诊断页
deploy/            Docker Compose、Caddy、coturn、Nginx、systemd、自检脚本
tests/             单元测试 + Playwright 端到端测试
```
