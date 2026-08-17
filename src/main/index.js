// Harness Desktop 主进程入口
'use strict';

const { app, nativeTheme } = require('electron');

const settings = require('./settings');
const { HarnessManager } = require('./harness');
const { RpcClient } = require('./rpc');
const { EventBridge } = require('./events');
const { WindowManager } = require('./windows');
const { TrayManager } = require('./tray');
const { ShortcutManager } = require('./shortcuts');
const { NotifyManager } = require('./notify');
const { SkillManager } = require('./skill');
const { BoardService } = require('./board');
const { LanService } = require('./lan');
const { SummaryService } = require('./summary');
const { SetupService } = require('./setup');
const { registerIpc } = require('./ipc');
const { PUSH } = require('../shared/constants');

let windows = null;

// ---- 单实例：重复启动时聚焦已有窗口 ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => windows?.showMain());
}

async function bootstrap() {
  settings.load();

  const harness = new HarnessManager(settings);
  const rpc = new RpcClient(() => harness.url);
  const events = new EventBridge(() => harness.url);
  windows = new WindowManager(settings, harness);
  const notify = new NotifyManager(settings, windows);
  const tray = new TrayManager(settings, harness, windows);
  const shortcuts = new ShortcutManager(settings, windows, harness);
  const skills = new SkillManager();
  const board = new BoardService(rpc);
  const lan = new LanService(settings, harness, app);
  const summaries = new SummaryService(settings);
  summaries.setApp(app);
  const setup = new SetupService(settings, harness);

  // ---- harness 状态变更：广播 + 刷新托盘 + 管理事件流连接 ----
  harness.on('state', () => {
    windows.broadcast(PUSH.State, windows.snapshot());
    tray.refresh();
    if (harness.state === 'running') {
      events.connect();
      // 移动端联动：若开启则自动拉起代理
      if (settings.get().lan.enabled) {
        lan.start().catch(() => {});
      }
    } else if (harness.state === 'stopped' || harness.state === 'error') {
      events.disconnect();
      lan.stop();
    }
  });

  harness.on('log', ({ level, text }) => {
    console[level === 'error' ? 'error' : 'log'](`[harness] ${text}`);
  });

  // ---- 事件流：审批/问题/Agent 状态 → 系统通知；会话变化推给壳层 ----
  events.on('approval-requested', (info) => {
    if (events.shouldNotify(`approval:${info.sessionId}:${info.approvalId || info.toolName}`)) {
      notify.onApprovalRequested(info);
    }
  });

  events.on('question-requested', (info) => {
    if (events.shouldNotify(`question:${info.sessionId}`)) {
      notify.onQuestionRequested(info);
    }
  });

  events.on('agent-error', (info) => {
    if (events.shouldNotify(`agent-error:${info.sessionId}`)) {
      notify.onAgentError(info);
    }
  });

  events.on('agent-finished', ({ sessionId }) => {
    const s = events.getSession(sessionId);
    if (events.shouldNotify(`agent-finished:${sessionId}`)) {
      notify.onAgentFinished({ sessionId, title: s?.title || s?.agentPreset });
    }
  });

  events.on('sessions-changed', () => {
    windows.broadcast(PUSH.Event, { kind: 'sessions', sessions: events.sessionList });
  });

  // 看板摘要生成完成 → 推给渲染层更新节点
  summaries.on('summary', ({ key, summary }) => {
    windows.broadcast(PUSH.Event, { kind: 'board-summary', key, summary });
  });

  registerIpc({ settings, harness, rpc, events, windows, tray, shortcuts, skills, board, lan, summaries, setup });

  // ---- 应用生命周期 ----
  app.on('activate', () => windows?.showMain());

  app.on('window-all-closed', () => {
    if (settings.get().closeBehavior === 'quit') app.quit();
  });

  let quitting = false;
  app.on('before-quit', () => {
    if (quitting) return;
    quitting = true;
    windows?.setQuitting();
    shortcuts.unregisterAll();
    lan.stop();
    lan.tunnelStop();
    if (settings.get().stopHarnessOnQuit) harness.stop();
  });

  app.on('will-quit', () => events.disconnect());

  // ---- 启动 ----
  nativeTheme.themeSource = settings.get().themeSource || 'system';
  tray.create();
  shortcuts.registerAll();
  windows.createWindow();

  if (settings.get().autoStartHarness) {
    await harness.start();
  }
}

app.whenReady().then(bootstrap).catch((err) => {
  console.error('[desktop] bootstrap failed:', err);
  app.quit();
});
