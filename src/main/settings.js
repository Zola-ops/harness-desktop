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
    accent: '#4cc2ff',
    accent2: '#8b5cf6',
    radius: 10,                // 圆角 4-20
    titlebarOpacity: 0.94,     // 顶栏不透明度 0.3-1
    panelOpacity: 0.92,        // 面板（命令面板/抽屉/看板）不透明度 0.3-1
  },
  // 移动端联动
  lan: {
    enabled: false,
    port: 3180,
  },
  // 看板智能摘要（agnes 小模型，本地缓存）
  summary: {
    enabled: true,
    model: 'agnes-2.5-flash',
  },
  // 首次启动向导是否已完成
  onboardingDone: false,
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
