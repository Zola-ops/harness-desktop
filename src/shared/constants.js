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
  AppVersion: 'desktop:app-version',
  LanStatus: 'desktop:lan-status',
  LanStart: 'desktop:lan-start',
  LanStop: 'desktop:lan-stop',
  LanQr: 'desktop:lan-qr',
  TunnelStatus: 'desktop:tunnel-status',
  TunnelStart: 'desktop:tunnel-start',
  TunnelStop: 'desktop:tunnel-stop',
  TunnelQr: 'desktop:tunnel-qr',
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
  // 看板智能摘要
  BoardSummaries: 'desktop:board-summaries',
  // 首次启动向导
  SetupStatus: 'desktop:setup-status',
  SetupDetectDsh: 'desktop:setup-detect-dsh',
  SetupSaveKeys: 'desktop:setup-save-keys',
  SetupFinish: 'desktop:setup-finish',
  // 审批快捷操作
  GetApprovals: 'desktop:get-approvals',
  ApprovalRespond: 'desktop:approval-respond',
  // 全局搜索
  GlobalSearch: 'desktop:global-search',
  // 会话管理
  SessionCreate: 'desktop:session-create',
  SessionRename: 'desktop:session-rename',
  SessionCancel: 'desktop:session-cancel',
  SessionFork: 'desktop:session-fork',
  // Goal 管理
  GoalCreate: 'desktop:goal-create',
  GoalEdit: 'desktop:goal-edit',
  GoalComplete: 'desktop:goal-complete',
  // 附件 / 导出 ZIP
  SessionExport: 'desktop:session-export',
  // Subagent 协作树
  SubagentTree: 'desktop:subagent-tree',
  SubagentInterrupt: 'desktop:subagent-interrupt',
  // 资产仓库
  AssetsList: 'desktop:assets-list',
  // 智能体预设
  AgentPresets: 'desktop:agent-presets',
  AgentPresetApply: 'desktop:agent-preset-apply',
  AgentPresetRead: 'desktop:agent-preset-read',
  AgentPresetCopy: 'desktop:agent-preset-copy',
  AgentPresetRemove: 'desktop:agent-preset-remove',
  // 记忆模块
  MemoryList: 'desktop:memory-list',
  MemoryRead: 'desktop:memory-read',
  MemoryWrite: 'desktop:memory-write',
  MemoryRemove: 'desktop:memory-remove',
  // 子代理委派
  SubagentPrompt: 'desktop:subagent-prompt',
  // MCP 第三方服务
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
  // 记忆锚点立即总结
  MemorySummaryNow: 'desktop:memory-summary-now',
  // 看板 AI 智能扩展
  TaskSummary: 'desktop:task-summary',
  PeriodSummary: 'desktop:period-summary',
  RelatedSessions: 'desktop:related-sessions',
  Insight: 'desktop:insight',
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
