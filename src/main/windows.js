// WindowManager：壳窗口（本地 UI + 内嵌 harness webview）与多窗口管理
'use strict';

const { BrowserWindow, shell } = require('electron');
const path = require('node:path');
const { IPC, PUSH } = require('../shared/constants');

class WindowManager {
  constructor(settings, harness) {
    this.settings = settings;
    this.harness = harness;
    this.windows = new Set();
    this._boundsTimer = null;
  }

  get mainWindow() {
    return [...this.windows].find((w) => !w.isDestroyed()) || null;
  }

  setQuitting() {
    this._quitting = true;
  }

  createWindow() {
    const saved = this.settings.get().windowBounds;
    const win = new BrowserWindow({
      width: saved?.width || 1360,
      height: saved?.height || 880,
      x: saved?.x,
      y: saved?.y,
      minWidth: 940,
      minHeight: 600,
      title: 'DSH-Z',
      backgroundColor: '#111418',
      titleBarStyle: 'hiddenInset', // macOS 原生红绿灯 + 内容区自定义顶栏
      trafficLightPosition: { x: 14, y: 14 },
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: true,
        spellcheck: false,
      },
    });

    this.windows.add(win);
    win.loadFile(path.join(__dirname, '..', 'renderer', 'shell.html'));

    // 转发渲染进程 console 到终端（诊断 preload/renderer 内部调用）
    win.webContents.on('console-message', (e, level, message, line, sourceId) => {
      if (level >= 2) {
        console.error(`[renderer:${level}] ${message} (${sourceId || ''}:${line})`);
      } else if (String(message).includes('[preload-diag]')) {
        console.log(`[renderer] ${message}`);
      }
    });

    // bounds 记忆（防抖）
    const saveBounds = () => {
      clearTimeout(this._boundsTimer);
      this._boundsTimer = setTimeout(() => {
        if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
        this.settings.set({ windowBounds: win.getBounds() });
      }, 600);
    };
    win.on('resize', saveBounds);
    win.on('move', saveBounds);

    win.on('close', (e) => {
      if (this._quitting) return; // 应用退出：允许关闭
      const behavior = this.settings.get().closeBehavior;
      if (behavior === 'tray') {
        e.preventDefault();
        win.hide();
        return;
      }
      if (behavior === 'keep') {
        e.preventDefault();
        if (this.windows.size <= 1) {
          win.hide(); // 最后一个窗口最小化到托盘，服务继续
        } else {
          this.windows.delete(win);
          win.destroy();
        }
        return;
      }
      // 'quit'：直接关闭；最后一个窗口关闭后 window-all-closed 触发退出
      this.windows.delete(win);
    });

    win.on('closed', () => {
      this.windows.delete(win);
    });

    win.on('focus', () => {
      win.webContents.send(PUSH.State, this.snapshot());
    });

    // 外部链接用系统浏览器打开
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http')) shell.openExternal(url);
      return { action: 'deny' };
    });

    return win;
  }

  snapshot() {
    const h = this.harness;
    return {
      service: {
        state: h.state,
        port: h.port,
        url: h.url,
        errorMessage: h.errorMessage,
        adopted: h.state === 'running' && !h.child,
      },
      settings: this.settings.get(),
    };
  }

  broadcast(channel, data) {
    for (const win of this.windows) {
      if (!win.isDestroyed()) win.webContents.send(channel, data);
    }
  }

  showMain() {
    const win = this.mainWindow;
    if (!win) return this.createWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return win;
  }

  // 把文件路径复制进剪贴板并聚焦输入框（v1 的文件集成）
  notifyDroppedFiles(win, paths) {
    const text = paths.join('\n');
    const { clipboard } = require('electron');
    clipboard.writeText(text);
    win.webContents.send(PUSH.Event, {
      kind: 'files-dropped',
      files: paths,
      message: `已复制 ${paths.length} 个文件路径到剪贴板，在会话输入框 ⌘V 粘贴即可引用`,
    });
  }
}

module.exports = { WindowManager };
