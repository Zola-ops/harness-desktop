// 预加载脚本：通过 contextBridge 向壳页面暴露受控的桌面 API
// 注意：webviewTag: true 会强制 preload 运行于 sandbox 环境，
// 只能 require('electron') 的内置子集，不能 require 其他本地文件 —— 常量内联于此。
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 与 src/shared/constants.js 保持一致的通道名（此处内联以兼容 sandbox）
const IPC = {
  GetState: 'desktop:get-state',
  OpenNewWindow: 'desktop:open-new-window',
  ToggleDevTools: 'desktop:toggle-devtools',
  ReloadView: 'desktop:reload-view',
  OpenInBrowser: 'desktop:open-in-browser',
  RunCommand: 'desktop:run-command',
  ListSessions: 'desktop:list-sessions',
  SetThemeSource: 'desktop:set-theme-source',
  SetCustomCss: 'desktop:set-custom-css',
  GetSettings: 'desktop:get-settings',
  SetSettings: 'desktop:set-settings',
  SetCloseBehavior: 'desktop:set-close-behavior',
  RestartHarness: 'desktop:restart-harness',
  StopHarness: 'desktop:stop-harness',
  StartHarness: 'desktop:start-harness',
  NotifyDroppedFiles: 'desktop:notify-dropped-files',
  ListSessionModels: 'desktop:list-session-models',
  SelectSessionModel: 'desktop:select-session-model',
  SaveModelRouting: 'desktop:save-model-routing',
  ApplyModelRouting: 'desktop:apply-model-routing',
  ListSkills: 'desktop:list-skills',
  ReadSkill: 'desktop:read-skill',
  CreateSkill: 'desktop:create-skill',
  UpdateSkill: 'desktop:update-skill',
  DeleteSkill: 'desktop:delete-skill',
  BoardSnapshot: 'desktop:board-snapshot',
  BoardSessionDetail: 'desktop:board-session-detail',
  BoardOpenPath: 'desktop:board-open-path',
  PickBackgroundImage: 'desktop:pick-background-image',
  LanStatus: 'desktop:lan-status',
  LanStart: 'desktop:lan-start',
  LanStop: 'desktop:lan-stop',
  LanQr: 'desktop:lan-qr',
  TunnelStatus: 'desktop:tunnel-status',
  TunnelStart: 'desktop:tunnel-start',
  TunnelStop: 'desktop:tunnel-stop',
  TunnelQr: 'desktop:tunnel-qr',
  BoardSummaries: 'desktop:board-summaries',
  SetupStatus: 'desktop:setup-status',
  SetupDetectDsh: 'desktop:setup-detect-dsh',
  SetupSaveKeys: 'desktop:setup-save-keys',
  SetupFinish: 'desktop:setup-finish',
};

const PUSH = {
  State: 'desktop:push:state',
  Event: 'desktop:push:event',
  CommandResult: 'desktop:push:command-result',
  Settings: 'desktop:push:settings',
};

function subscribe(channel, cb) {
  const listener = (_event, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('desktop', {
  // 状态与服务
  getState: () => ipcRenderer.invoke(IPC.GetState),
  openNewWindow: () => ipcRenderer.invoke(IPC.OpenNewWindow),
  toggleDevTools: () => ipcRenderer.invoke(IPC.ToggleDevTools),
  reloadView: () => ipcRenderer.invoke(IPC.ReloadView),
  openInBrowser: () => ipcRenderer.invoke(IPC.OpenInBrowser),

  // 命令面板
  listSessions: () => ipcRenderer.invoke(IPC.ListSessions),
  runCommand: (args) => ipcRenderer.invoke(IPC.RunCommand, args),

  // 主题与外观
  setThemeSource: (source) => ipcRenderer.invoke(IPC.SetThemeSource, source),
  setCustomCss: (css) => ipcRenderer.invoke(IPC.SetCustomCss, css),

  // 设置
  getSettings: () => ipcRenderer.invoke(IPC.GetSettings),
  setSettings: (patch) => ipcRenderer.invoke(IPC.SetSettings, patch),
  setCloseBehavior: (behavior) => ipcRenderer.invoke(IPC.SetCloseBehavior, behavior),

  // harness 服务控制
  startHarness: () => ipcRenderer.invoke(IPC.StartHarness),
  stopHarness: () => ipcRenderer.invoke(IPC.StopHarness),
  restartHarness: () => ipcRenderer.invoke(IPC.RestartHarness),

  // 文件集成
  notifyDroppedFiles: (paths) => ipcRenderer.invoke(IPC.NotifyDroppedFiles, paths),

  // 多模态模型路由
  listSessionModels: (sessionId) => ipcRenderer.invoke(IPC.ListSessionModels, sessionId),
  selectSessionModel: (args) => ipcRenderer.invoke(IPC.SelectSessionModel, args),
  saveModelRouting: (routing) => ipcRenderer.invoke(IPC.SaveModelRouting, routing),
  applyModelRouting: (args) => ipcRenderer.invoke(IPC.ApplyModelRouting, args),

  // Skill 管理
  listSkills: () => ipcRenderer.invoke(IPC.ListSkills),
  readSkill: (skillPath) => ipcRenderer.invoke(IPC.ReadSkill, skillPath),
  createSkill: (input) => ipcRenderer.invoke(IPC.CreateSkill, input),
  updateSkill: (args) => ipcRenderer.invoke(IPC.UpdateSkill, args),
  deleteSkill: (skillPath) => ipcRenderer.invoke(IPC.DeleteSkill, skillPath),

  // 看板
  boardSnapshot: () => ipcRenderer.invoke(IPC.BoardSnapshot),
  boardSessionDetail: (sessionId) => ipcRenderer.invoke(IPC.BoardSessionDetail, sessionId),
  boardOpenPath: (args) => ipcRenderer.invoke(IPC.BoardOpenPath, args),

  // 自定义 UI
  pickBackgroundImage: () => ipcRenderer.invoke(IPC.PickBackgroundImage),

  // 移动端联动
  lanStatus: () => ipcRenderer.invoke(IPC.LanStatus),
  lanStart: () => ipcRenderer.invoke(IPC.LanStart),
  lanStop: () => ipcRenderer.invoke(IPC.LanStop),
  lanQr: () => ipcRenderer.invoke(IPC.LanQr),

  // 公网隧道
  tunnelStatus: () => ipcRenderer.invoke(IPC.TunnelStatus),
  tunnelStart: () => ipcRenderer.invoke(IPC.TunnelStart),
  tunnelStop: () => ipcRenderer.invoke(IPC.TunnelStop),
  tunnelQr: () => ipcRenderer.invoke(IPC.TunnelQr),

  // 看板智能摘要
  boardSummaries: (args) => ipcRenderer.invoke(IPC.BoardSummaries, args),

  // 首次启动向导
  setupStatus: () => ipcRenderer.invoke(IPC.SetupStatus),
  setupDetectDsh: () => ipcRenderer.invoke(IPC.SetupDetectDsh),
  setupSaveKeys: (args) => ipcRenderer.invoke(IPC.SetupSaveKeys, args),
  setupFinish: () => ipcRenderer.invoke(IPC.SetupFinish),

  // 订阅（返回取消函数）
  onState: (cb) => subscribe(PUSH.State, cb),
  onEvent: (cb) => subscribe(PUSH.Event, cb),
  onCommandResult: (cb) => subscribe(PUSH.CommandResult, cb),
  onSettings: (cb) => subscribe(PUSH.Settings, cb),
});
