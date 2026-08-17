// ShortcutManager：全局快捷键（可配置，设置变更后重注册）
'use strict';

const { globalShortcut } = require('electron');
const { PUSH } = require('../shared/constants');

class ShortcutManager {
  constructor(settings, windows, harness) {
    this.settings = settings;
    this.windows = windows;
    this.harness = harness;
  }

  registerAll() {
    const { shortcuts } = this.settings.get();
    globalShortcut.unregisterAll();

    if (shortcuts.quickInput) {
      globalShortcut.register(shortcuts.quickInput, () => {
        const win = this.windows.showMain();
        // 通知壳层打开快速输入（命令面板）
        win.webContents.send(PUSH.Event, { kind: 'quick-input' });
      });
    }
    if (shortcuts.newWindow) {
      globalShortcut.register(shortcuts.newWindow, () => this.windows.createWindow());
    }
  }

  unregisterAll() {
    globalShortcut.unregisterAll();
  }
}

module.exports = { ShortcutManager };
