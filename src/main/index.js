// DSH-Z 主进程入口
'use strict';

const fs = require('node:fs');
const path = require('node:path');
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
const { MemoryService } = require('./memory');
const { McpService } = require('./mcp');
const { AgentPresetManager } = require('./agent-preset');
const { registerIpc } = require('./ipc');
const { PUSH } = require('../shared/constants');

let windows = null;

// ---- 单实例：重复启动时聚焦已有窗口 ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => windows?.showMain());
}

// 应用更名后迁移旧 userData（harness-desktop → dsh-z）：只复制关键配置，避免阻塞（Cache/blob 等运行时目录不迁移）
function migrateUserData() {
  try {
    const old = path.join(app.getPath('home'), 'Library', 'Application Support', 'harness-desktop');
    const neu = app.getPath('userData');
    if (neu === old || fs.existsSync(neu) || !fs.existsSync(old)) return;
    fs.mkdirSync(neu, { recursive: true });
    const files = ['settings.json', 'board-summaries.json'];
    for (const f of files) {
      const src = path.join(old, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(neu, f));
    }
    const cf = path.join(old, 'cloudflared');
    if (fs.existsSync(cf)) fs.cpSync(cf, path.join(neu, 'cloudflared'), { recursive: true });
    console.log('[migrate] config migrated to', neu);
  } catch (err) {
    console.error('[migrate] failed:', err.message);
  }
}

process.on('uncaughtException', (e) => console.error('[crash] uncaught:', e && e.stack ? e.stack.slice(0, 500) : e));
process.on('unhandledRejection', (e) => console.error('[crash] rejection:', String(e && e.message || e)));

async function bootstrap() {
  console.log('[boot] start');
  migrateUserData();
  settings.load();
  console.log('[boot] settings ok');

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
  lan.ensureSshDefaults();
  const summaries = new SummaryService(settings);
  summaries.setApp(app);
  const setup = new SetupService(settings, harness);
  const memory = new MemoryService();
  const mcp = new McpService(harness);
  const agentPresetMgr = new AgentPresetManager();

  // 隧道启动前自动修正目录选择器为 native（Mac 本机弹窗、结果回传远程）。
  // auto/browse 在远程 fallback 到 browse → /api/host.pickDirectory 返回 403。
  lan.setPickerEnsurer(async () => {
    try {
      if (mcp.pickerBackend() !== 'native') {
        mcp.setPickerBackend('native');
        console.log('[lan] 隧道启动：目录选择器已自动切为 native，重启 harness 生效');
        if (harness.state === 'running') {
          await harness.restart();
        }
      }
    } catch (err) {
      console.error('[lan] 目录选择器自动修正失败：', String(err.message || err));
    }
  });

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
  const pendingApprovals = new Map(); // approvalId -> {approvalId, sessionId, toolName, reason, rpcId, time}

  const broadcastApprovals = () => {
    windows.broadcast(PUSH.Event, { kind: 'approvals', approvals: [...pendingApprovals.values()] });
  };

  events.on('approval-requested', (info) => {
    if (events.shouldNotify(`approval:${info.sessionId}:${info.approvalId || info.toolName}`)) {
      notify.onApprovalRequested(info);
    }
    pendingApprovals.set(info.approvalId, { ...info, time: Date.now() });
    broadcastApprovals();
  });

  events.on('approval-resolved', ({ approvalId }) => {
    pendingApprovals.delete(approvalId);
    broadcastApprovals();
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

  // ---- 记忆锚点（事件驱动） ----
  const anchor = settings.get().memoryAnchor || {};
  const seenSessions = new Set();
  const turnCounts = new Map();

  // 1) 新会话：检索相关记忆并提示
  events.on('sessions-changed', async () => {
    if (!settings.get().memoryAnchor?.enabled) return;
    for (const s of events.sessionList) {
      if (seenSessions.has(s.id)) continue;
      seenSessions.add(s.id);
      // 回顾相关记忆
      try {
        const notes = memory.search(s.title || s.agentPreset || '');
        const hits = notes.filter((n) => n.title !== s.title).slice(0, 3);
        if (hits.length) {
          windows.broadcast(PUSH.Event, {
            kind: 'memory-recall',
            sessionId: s.id,
            notes: hits.map((n) => ({ id: n.id, title: n.title, tags: n.tags })),
          });
        }
      } catch {}
    }
  });

  // 2) 任务完成：沉淀长期记忆
  events.on('agent-finished', async ({ sessionId }) => {
    if (!settings.get().memoryAnchor?.enabled) return;
    try {
      const snap = await board.snapshot();
      const session = snap.sessions.find((x) => x.id === sessionId);
      if (!session) return;
      const detail = await board.sessionDetail(sessionId);
      const r = await memory.taskAnchor(session, detail?.firstPrompt);
      if (r) {
        windows.broadcast(PUSH.Event, { kind: 'memory-saved', note: r.note, text: r.text.slice(0, 80) });
      }
    } catch {}
  });

  // 3) 每 x 轮对话：中期沉淀
  events.on('frame', ({ type, payload }) => {
    const cfg = settings.get().memoryAnchor;
    if (!cfg?.enabled || type !== 'session/event') return;
    const ev = payload?.event;
    if (ev?.type !== 'turn/end') return;
    const sid = payload.sessionId;
    const count = (turnCounts.get(sid) || 0) + 1;
    turnCounts.set(sid, count);
    if (count % Math.max(2, cfg.turnInterval || 10) !== 0) return;
    (async () => {
      try {
        const snap = await board.snapshot();
        const session = snap.sessions.find((x) => x.id === sid);
        if (!session) return;
        const r = await memory.turnAnchor(session, count);
        if (r) windows.broadcast(PUSH.Event, { kind: 'memory-saved', note: r, text: '已沉淀中期记忆' });
      } catch {}
    })();
  });

  // 4) 定期总结（每日检查，按配置频率触发）
  let lastMemorySummary = 0;
  try {
    const f = fs.readFileSync(path.join(app.getPath('userData'), 'memory-summary.json'), 'utf8');
    lastMemorySummary = JSON.parse(f).at || 0;
  } catch {}
  setInterval(async () => {
    const cfg = settings.get().memoryAnchor;
    if (!cfg?.enabled || cfg.periodic === 'off') return;
    const hours = (Date.now() - lastMemorySummary) / 3600000;
    const due = cfg.periodic === 'daily' ? hours >= 24 : hours >= 24 * 7;
    if (!due) return;
    try {
      const text = await memory.periodicSummary();
      if (text) {
        lastMemorySummary = Date.now();
        fs.writeFileSync(path.join(app.getPath('userData'), 'memory-summary.json'), JSON.stringify({ at: lastMemorySummary, text }));
        windows.broadcast(PUSH.Event, { kind: 'memory-summary', text });
      }
    } catch {}
  }, 3600000).unref();

  registerIpc({ settings, harness, rpc, events, windows, tray, shortcuts, skills, board, lan, summaries, setup, pendingApprovals, memory, mcp, agentPresetMgr });

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
  console.log('[boot] theme ok');
  // DSH-Z 名称与 Dock 图标（开发运行时 Electron 默认显示 Electron/默认图标）
  app.setName('DSH-Z');
  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(path.join(__dirname, '..', '..', 'assets', 'icon.png'));
      console.log('[boot] dock icon ok');
    } catch (e) { console.error('[boot] dock icon fail:', e.message); }
  }
  tray.create();
  console.log('[boot] tray ok');
  shortcuts.registerAll();
  windows.createWindow();
  console.log('[boot] window ok');

  if (settings.get().autoStartHarness) {
    await harness.start();
  }
}

app.whenReady().then(bootstrap).catch((err) => {
  console.error('[desktop] bootstrap failed:', err);
  app.quit();
});
