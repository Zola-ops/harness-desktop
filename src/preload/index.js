// 预加载脚本：通过 contextBridge 向壳页面暴露受控的桌面 API
// 注意：webviewTag: true 会强制 preload 运行于 sandbox 环境，
// 只能 require('electron') 的内置子集，不能 require 其他本地文件 —— 常量内联于此。
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
  GetApprovals: 'desktop:get-approvals',
  ApprovalRespond: 'desktop:approval-respond',
  GlobalSearch: 'desktop:global-search',
  SessionCreate: 'desktop:session-create',
  SessionRename: 'desktop:session-rename',
  SessionCancel: 'desktop:session-cancel',
  SessionFork: 'desktop:session-fork',
  GoalCreate: 'desktop:goal-create',
  GoalEdit: 'desktop:goal-edit',
  GoalComplete: 'desktop:goal-complete',
  SessionExport: 'desktop:session-export',
  SubagentTree: 'desktop:subagent-tree',
  SubagentInterrupt: 'desktop:subagent-interrupt',
  AssetsList: 'desktop:assets-list',
  AgentPresets: 'desktop:agent-presets',
  AgentPresetApply: 'desktop:agent-preset-apply',
  AgentPresetRead: 'desktop:agent-preset-read',
  AgentPresetCopy: 'desktop:agent-preset-copy',
  AgentPresetRemove: 'desktop:agent-preset-remove',
  MemoryList: 'desktop:memory-list',
  MemoryRead: 'desktop:memory-read',
  MemoryWrite: 'desktop:memory-write',
  MemoryRemove: 'desktop:memory-remove',
  SubagentPrompt: 'desktop:subagent-prompt',
  McpList: 'desktop:mcp-list',
  McpUpsert: 'desktop:mcp-upsert',
  McpRemove: 'desktop:mcp-remove',
  McpApply: 'desktop:mcp-apply',
  SummaryModels: 'desktop:summary-models',
  ConfigProviders: 'desktop:config-providers',
  ConfigAddProvider: 'desktop:config-add-provider',
  ConfigAddModel: 'desktop:config-add-model',
  ConfigRemoveModel: 'desktop:config-remove-model',
  AgentPresetCreate: 'desktop:agent-preset-create',
  AgentPresetEdit: 'desktop:agent-preset-edit',
  PickerBackend: 'desktop:picker-backend',
  PickerSet: 'desktop:picker-set',
  MemorySummaryNow: 'desktop:memory-summary-now',
  TaskSummary: 'desktop:task-summary',
  PeriodSummary: 'desktop:period-summary',
  RelatedSessions: 'desktop:related-sessions',
  Insight: 'desktop:insight',
  AppVersion: 'desktop:app-version',
  TunnelCustomUrl: 'desktop:tunnel-custom-url',
  TailscaleStatus: 'desktop:tailscale-status',
  FrpStatus: 'desktop:frp-status',
  FrpSave: 'desktop:frp-save',
  FrpStart: 'desktop:frp-start',
  FrpStop: 'desktop:frp-stop',
  SshStatus: 'desktop:ssh-status',
  SshSave: 'desktop:ssh-save',
  SshStart: 'desktop:ssh-start',
  SshStop: 'desktop:ssh-stop',
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

// ---- 诊断：包装 ipcRenderer.invoke，记录每个调用与参数类型 ----
// 目标：定位 "conversion failure from undefined" 的确切调用点。
// 通过 console 输出，主进程 webContents 'console-message' 事件转发到终端。
const _origInvoke = ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke = (channel, ...args) => {
  const undefIdx = args.map((a, i) => (a === undefined ? i : -1)).filter((i) => i >= 0);
  if (undefIdx.length) {
    console.error(`[preload-diag] INVOKE ${channel} 参数含 undefined (索引 ${undefIdx.join(',')}), 参数数=${args.length}`);
  } else if (args.length) {
    console.log(`[preload-diag] INVOKE ${channel} args=${args.length}`);
  } else {
    console.log(`[preload-diag] INVOKE ${channel} (无参数)`);
  }
  return _origInvoke(channel, ...args);
};

contextBridge.exposeInMainWorld('desktop', {
  // 状态与服务
  getState: () => ipcRenderer.invoke(IPC.GetState),
  openNewWindow: () => ipcRenderer.invoke(IPC.OpenNewWindow),
  toggleDevTools: () => ipcRenderer.invoke(IPC.ToggleDevTools),
  reloadView: () => ipcRenderer.invoke(IPC.ReloadView),
  openInBrowser: () => ipcRenderer.invoke(IPC.OpenInBrowser),

  // 命令面板
  listSessions: () => ipcRenderer.invoke(IPC.ListSessions),
  runCommand: (args) => ipcRenderer.invoke(IPC.RunCommand, args ?? null),

  // 主题与外观
  setThemeSource: (source) => ipcRenderer.invoke(IPC.SetThemeSource, source ?? null),
  setCustomCss: (css) => ipcRenderer.invoke(IPC.SetCustomCss, css ?? null),

  // 设置
  getSettings: () => ipcRenderer.invoke(IPC.GetSettings),
  setSettings: (patch) => ipcRenderer.invoke(IPC.SetSettings, patch ?? null),
  setCloseBehavior: (behavior) => ipcRenderer.invoke(IPC.SetCloseBehavior, behavior ?? null),

  // harness 服务控制
  startHarness: () => ipcRenderer.invoke(IPC.StartHarness),
  stopHarness: () => ipcRenderer.invoke(IPC.StopHarness),
  restartHarness: () => ipcRenderer.invoke(IPC.RestartHarness),

  // 文件集成
  // Electron 32 起移除了非标准的 File.path，取真实路径必须走 webUtils。
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
  },
  notifyDroppedFiles: (paths) => ipcRenderer.invoke(IPC.NotifyDroppedFiles, paths ?? null),

  // 多模态模型路由
  listSessionModels: (sessionId) => ipcRenderer.invoke(IPC.ListSessionModels, sessionId ?? null),
  selectSessionModel: (args) => ipcRenderer.invoke(IPC.SelectSessionModel, args ?? null),
  saveModelRouting: (routing) => ipcRenderer.invoke(IPC.SaveModelRouting, routing ?? null),
  applyModelRouting: (args) => ipcRenderer.invoke(IPC.ApplyModelRouting, args ?? null),

  // Skill 管理
  listSkills: () => ipcRenderer.invoke(IPC.ListSkills),
  readSkill: (skillPath) => ipcRenderer.invoke(IPC.ReadSkill, skillPath ?? null),
  createSkill: (input) => ipcRenderer.invoke(IPC.CreateSkill, input ?? null),
  updateSkill: (args) => ipcRenderer.invoke(IPC.UpdateSkill, args ?? null),
  deleteSkill: (skillPath) => ipcRenderer.invoke(IPC.DeleteSkill, skillPath ?? null),

  // 看板
  boardSnapshot: () => ipcRenderer.invoke(IPC.BoardSnapshot),
  boardSessionDetail: (sessionId) => ipcRenderer.invoke(IPC.BoardSessionDetail, sessionId ?? null),
  boardOpenPath: (args) => ipcRenderer.invoke(IPC.BoardOpenPath, args ?? null),

  // 自定义 UI
  pickBackgroundImage: () => ipcRenderer.invoke(IPC.PickBackgroundImage),

  // 应用版本
  appVersion: () => ipcRenderer.invoke(IPC.AppVersion),

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
  tunnelCustomUrl: (url) => ipcRenderer.invoke(IPC.TunnelCustomUrl, url ?? null),
  tailscaleStatus: () => ipcRenderer.invoke(IPC.TailscaleStatus),

  // frp 内网穿透
  frpStatus: () => ipcRenderer.invoke(IPC.FrpStatus),
  frpSave: (cfg) => ipcRenderer.invoke(IPC.FrpSave, cfg ?? null),
  frpStart: () => ipcRenderer.invoke(IPC.FrpStart),
  frpStop: () => ipcRenderer.invoke(IPC.FrpStop),

  // SSH 反向隧道
  sshStatus: () => ipcRenderer.invoke(IPC.SshStatus),
  sshSave: (cfg) => ipcRenderer.invoke(IPC.SshSave, cfg ?? null),
  sshStart: () => ipcRenderer.invoke(IPC.SshStart),
  sshStop: () => ipcRenderer.invoke(IPC.SshStop),

  // 看板智能摘要
  boardSummaries: (args) => ipcRenderer.invoke(IPC.BoardSummaries, args ?? null),

  // 首次启动向导
  setupStatus: () => ipcRenderer.invoke(IPC.SetupStatus),
  setupDetectDsh: () => ipcRenderer.invoke(IPC.SetupDetectDsh),
  setupSaveKeys: (args) => ipcRenderer.invoke(IPC.SetupSaveKeys, args ?? null),
  setupFinish: () => ipcRenderer.invoke(IPC.SetupFinish),

  // 审批快捷操作
  getApprovals: () => ipcRenderer.invoke(IPC.GetApprovals),
  approvalRespond: (args) => ipcRenderer.invoke(IPC.ApprovalRespond, args ?? null),

  // 全局搜索
  globalSearch: (query) => ipcRenderer.invoke(IPC.GlobalSearch, query ?? null),

  // 会话管理
  sessionCreate: (args) => ipcRenderer.invoke(IPC.SessionCreate, args ?? null),
  sessionRename: (args) => ipcRenderer.invoke(IPC.SessionRename, args ?? null),
  sessionCancel: (sessionId) => ipcRenderer.invoke(IPC.SessionCancel, sessionId ?? null),
  sessionFork: (args) => ipcRenderer.invoke(IPC.SessionFork, args ?? null),

  // Goal 管理
  goalCreate: (args) => ipcRenderer.invoke(IPC.GoalCreate, args ?? null),
  goalComplete: (args) => ipcRenderer.invoke(IPC.GoalComplete, args ?? null),

  // 会话导出 ZIP / Subagent 树 / 资产仓库
  sessionExport: (sessionId) => ipcRenderer.invoke(IPC.SessionExport, sessionId ?? null),
  subagentTree: (sessionId) => ipcRenderer.invoke(IPC.SubagentTree, sessionId ?? null),
  subagentInterrupt: (args) => ipcRenderer.invoke(IPC.SubagentInterrupt, args ?? null),
  assetsList: () => ipcRenderer.invoke(IPC.AssetsList),
  agentPresets: () => ipcRenderer.invoke(IPC.AgentPresets),
  agentPresetApply: (args) => ipcRenderer.invoke(IPC.AgentPresetApply, args ?? null),
  agentPresetRead: (name) => ipcRenderer.invoke(IPC.AgentPresetRead, name ?? null),
  agentPresetCopy: (args) => ipcRenderer.invoke(IPC.AgentPresetCopy, args ?? null),
  agentPresetRemove: (name) => ipcRenderer.invoke(IPC.AgentPresetRemove, name ?? null),
  memoryList: (q) => ipcRenderer.invoke(IPC.MemoryList, q ?? null),
  memoryRead: (id) => ipcRenderer.invoke(IPC.MemoryRead, id ?? null),
  memoryWrite: (args) => ipcRenderer.invoke(IPC.MemoryWrite, args ?? null),
  memoryRemove: (id) => ipcRenderer.invoke(IPC.MemoryRemove, id ?? null),
  subagentPrompt: (args) => ipcRenderer.invoke(IPC.SubagentPrompt, args ?? null),
  mcpList: () => ipcRenderer.invoke(IPC.McpList),
  mcpUpsert: (args) => ipcRenderer.invoke(IPC.McpUpsert, args ?? null),
  mcpRemove: (name) => ipcRenderer.invoke(IPC.McpRemove, name ?? null),
  mcpApply: () => ipcRenderer.invoke(IPC.McpApply),
  summaryModels: () => ipcRenderer.invoke(IPC.SummaryModels),
  configProviders: () => ipcRenderer.invoke(IPC.ConfigProviders),
  configAddProvider: (args) => ipcRenderer.invoke(IPC.ConfigAddProvider, args ?? null),
  configAddModel: (args) => ipcRenderer.invoke(IPC.ConfigAddModel, args ?? null),
  configRemoveModel: (args) => ipcRenderer.invoke(IPC.ConfigRemoveModel, args ?? null),
  agentPresetCreate: (args) => ipcRenderer.invoke(IPC.AgentPresetCreate, args ?? null),
  agentPresetEdit: (args) => ipcRenderer.invoke(IPC.AgentPresetEdit, args ?? null),
  pickerBackend: () => ipcRenderer.invoke(IPC.PickerBackend),
  pickerSet: (kind) => ipcRenderer.invoke(IPC.PickerSet, kind ?? null),
  periodicSummaryNow: () => ipcRenderer.invoke(IPC.MemorySummaryNow),
  taskSummary: (args) => ipcRenderer.invoke(IPC.TaskSummary, args ?? null),
  periodSummary: (args) => ipcRenderer.invoke(IPC.PeriodSummary, args ?? null),
  relatedSessions: (sessionId) => ipcRenderer.invoke(IPC.RelatedSessions, sessionId ?? null),
  insight: (sessionId) => ipcRenderer.invoke(IPC.Insight, sessionId ?? null),

  // 订阅（返回取消函数）
  onState: (cb) => subscribe(PUSH.State, cb),
  onEvent: (cb) => subscribe(PUSH.Event, cb),
  onCommandResult: (cb) => subscribe(PUSH.CommandResult, cb),
  onSettings: (cb) => subscribe(PUSH.Settings, cb),
});
