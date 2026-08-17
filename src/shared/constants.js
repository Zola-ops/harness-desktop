// 主进程与渲染层共享的常量（IPC 通道名、默认值）
'use strict';

const DEFAULT_PORT = 3080;
const PORT_RANGE_MAX = 3095;

// IPC 通道名（renderer -> main invoke）
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
  // 多模态模型路由
  ListSessionModels: 'desktop:list-session-models',
  SelectSessionModel: 'desktop:select-session-model',
  SaveModelRouting: 'desktop:save-model-routing',
  ApplyModelRouting: 'desktop:apply-model-routing',
  // Skill 管理
  ListSkills: 'desktop:list-skills',
  ReadSkill: 'desktop:read-skill',
  CreateSkill: 'desktop:create-skill',
  UpdateSkill: 'desktop:update-skill',
  DeleteSkill: 'desktop:delete-skill',
  // 看板
  BoardSnapshot: 'desktop:board-snapshot',
  BoardSessionDetail: 'desktop:board-session-detail',
  BoardOpenPath: 'desktop:board-open-path',
  // 自定义 UI
  PickBackgroundImage: 'desktop:pick-background-image',
  // 移动端联动
  LanStatus: 'desktop:lan-status',
  LanStart: 'desktop:lan-start',
  LanStop: 'desktop:lan-stop',
  LanQr: 'desktop:lan-qr',
  TunnelStatus: 'desktop:tunnel-status',
  TunnelStart: 'desktop:tunnel-start',
  TunnelStop: 'desktop:tunnel-stop',
  TunnelQr: 'desktop:tunnel-qr',
  // 看板智能摘要
  BoardSummaries: 'desktop:board-summaries',
  // 首次启动向导
  SetupStatus: 'desktop:setup-status',
  SetupDetectDsh: 'desktop:setup-detect-dsh',
  SetupSaveKeys: 'desktop:setup-save-keys',
  SetupFinish: 'desktop:setup-finish',
};

// main -> renderer 推送通道
const PUSH = {
  State: 'desktop:push:state',
  Event: 'desktop:push:event',
  CommandResult: 'desktop:push:command-result',
  Settings: 'desktop:push:settings',
};

// 事件流中我们关注的事件名（用于通知 / 会话跟踪）
const NOTIFY_EVENTS = new Set([
  'approval/requested',
  'approval/asked',
  'question/requested',
  'agent/status',
  'agent/error',
  'steering/message',
]);

module.exports = { DEFAULT_PORT, PORT_RANGE_MAX, IPC, PUSH, NOTIFY_EVENTS };
