// 桌面端设置持久化：userData/settings.json
'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_PORT } = require('../shared/constants');

const DEFAULTS = {
  // harness 服务
  dshCommand: '', // 空 = 自动探测（PATH -> npx 缓存）
  port: DEFAULT_PORT,
  autoStartHarness: true, // 应用启动时自动拉起 harness 服务
  stopHarnessOnQuit: true, // 退出应用时停止 harness 服务
  // 窗口
  closeBehavior: 'tray', // 'tray' 关窗最小化到托盘 | 'quit' 关窗即退出 | 'keep' 仅关窗服务继续
  windowBounds: null, // {x,y,width,height} 上次主窗口位置
  // 主题
  themeSource: 'system', // 'system' | 'light' | 'dark'（同步控制 harness 页面 prefers-color-scheme）
  customCss: '', // 注入到 harness 页面的自定义样式
  // 快捷键（globalShortcut 格式）
  shortcuts: {
    quickInput: 'CommandOrControl+Shift+Space',
    newWindow: 'CommandOrControl+Shift+N',
  },
  // 通知
  notificationsEnabled: true,
  // 多模态模型路由：常规任务 / 图片理解 / 图片生成 / 视频生成 分别配置
  modelRouting: {
    default: { provider: '', model: '' }, // 空 = 跟随 harness 默认（不覆盖）
    vision: { provider: '', model: '' },
    image: { provider: '', model: '' },
    video: { provider: '', model: '' },
  },
  // 自定义 UI：背景 / 强调色 / 圆角 / 组件透明度
  uiCustom: {
    backgroundType: 'color',   // 'color' | 'image'
    background: '#111418',     // 背景色（type=color 时生效）
    backgroundImage: '',       // 背景图片本地路径（type=image 时生效）
    backgroundBlur: 12,        // 背景模糊 0-40
    backgroundDim: 0.35,       // 背景暗化 0-0.9
    accent: '#3b82f6',
    accent2: '#2563eb',
    radius: 10,                // 圆角 4-20
    titlebarOpacity: 0.94,     // 顶栏不透明度 0.3-1
    panelOpacity: 0.92,        // 面板（命令面板/抽屉/看板）不透明度 0.3-1
  },
  // 移动端联动
  lan: {
    enabled: false,
    port: 3180,
    // 自定义公网地址：用户自有域名（SSH 反向隧道 / frp / Cloudflare named tunnel）映射到本机后的 URL
    customTunnelUrl: '',
    // frp 内网穿透（推荐：自持服务器 + 域名）
    frp: {
      enabled: false,
      server: '',          // 服务器公网 IP 或域名
      bindPort: 7000,      // frps 通信端口
      remotePort: 8080,    // frps 上对外开放的映射端口
      token: '',           // frps auth token
      domain: '',          // 对外访问域名（如 dsh.example.com）
    },
    // SSH 反向隧道（复用 22 端口，无需服务器开新端口；配合 nginx 反代）
    sshTunnel: {
      enabled: false,
      server: '',          // 服务器地址（IP 或域名）
      user: 'root',        // SSH 登录用户
      keyPath: '',         // 私钥路径（如 ~/.ssh/id_rsa 或桌面 key.pem）
      remotePort: 8080,    // 服务器上监听的回环端口（nginx 反代目标）
      domain: '',          // 对外访问域名（如 dsh.example.com）
    },
  },
  // 看板智能摘要（agnes 小模型，本地缓存）
  summary: {
    enabled: true,
    model: 'agnes-2.5-flash',
  },
  // 首次启动向导是否已完成
  onboardingDone: false,
  // 记忆锚点：新会话回顾 / 任务完成沉淀 / 每 x 轮沉淀 / 定期总结
  memoryAnchor: {
    enabled: true,
    turnInterval: 10,      // 每多少轮触发中期沉淀
    periodic: 'weekly',    // 'weekly' | 'daily' | 'off'
  },
};

let file = null;
let cache = null;

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  file = settingsPath();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache = { ...structuredClone(DEFAULTS), ...raw };
    if (raw.shortcuts) cache.shortcuts = { ...DEFAULTS.shortcuts, ...raw.shortcuts };
    if (raw.windowBounds) cache.windowBounds = { ...raw.windowBounds };
  } catch {
    cache = structuredClone(DEFAULTS);
  }
  return cache;
}

function get() {
  if (!cache) load();
  return cache;
}

function set(patch) {
  const next = { ...get(), ...patch };
  if (patch.shortcuts) next.shortcuts = { ...get().shortcuts, ...patch.shortcuts };
  if (patch.windowBounds) next.windowBounds = { ...patch.windowBounds };
  if (patch.modelRouting) {
    next.modelRouting = {
      default: { ...get().modelRouting.default, ...patch.modelRouting.default },
      vision: { ...get().modelRouting.vision, ...patch.modelRouting.vision },
      image: { ...get().modelRouting.image, ...patch.modelRouting.image },
      video: { ...get().modelRouting.video, ...patch.modelRouting.video },
    };
  }
  if (patch.uiCustom) next.uiCustom = { ...get().uiCustom, ...patch.uiCustom };
  if (patch.lan) next.lan = { ...get().lan, ...patch.lan };
  if (patch.summary) next.summary = { ...get().summary, ...patch.summary };
  if (patch.memoryAnchor) next.memoryAnchor = { ...get().memoryAnchor, ...patch.memoryAnchor };
  cache = next;
  persist();
  return cache;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[settings] persist failed:', err.message);
  }
}

module.exports = { DEFAULTS, load, get, set };
