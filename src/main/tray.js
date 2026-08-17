// TrayManager：菜单栏常驻图标 + 服务控制菜单
'use strict';

const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('node:path');

class TrayManager {
  constructor(settings, harness, windows) {
    this.settings = settings;
    this.harness = harness;
    this.windows = windows;
    this.tray = null;
  }

  create() {
    const image = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'trayTemplate.png'));
    image.setTemplateImage(true);
    this.tray = new Tray(image);
    this.tray.setToolTip('Harness Desktop');
    this.tray.on('click', () => this.windows.showMain());
    this.refresh();
  }

  refresh() {
    if (!this.tray) return;
    const h = this.harness;
    const statusText =
      h.state === 'running' ? `运行中 · ${h.url}` :
      h.state === 'starting' ? '启动中…' :
      h.state === 'error' ? `错误：${h.errorMessage}` : '已停止';

    const menu = Menu.buildFromTemplate([
      { label: `Harness ${statusText}`, enabled: false },
      { type: 'separator' },
      { label: '打开主窗口', click: () => this.windows.showMain() },
      { label: '新建窗口', accelerator: 'CmdOrCtrl+Shift+N', click: () => this.windows.createWindow() },
      { type: 'separator' },
      ...(h.state === 'running' || h.state === 'starting'
        ? [{ label: '停止 Harness 服务', click: () => this.harness.stop() }]
        : [{ label: '启动 Harness 服务', click: () => this.harness.start() }]),
      { label: '重启 Harness 服务', enabled: h.state === 'running', click: () => this.harness.restart() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]);
    this.tray.setContextMenu(menu);
  }
}

module.exports = { TrayManager };
