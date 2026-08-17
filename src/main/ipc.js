// IPC 注册表：渲染层（壳）与主进程的桥梁
'use strict';

const os = require('node:os');
const { ipcMain, shell, nativeTheme, dialog } = require('electron');
const { IPC, PUSH } = require('../shared/constants');

function registerIpc(ctx) {
  const { settings, harness, rpc, events, windows, tray, shortcuts } = ctx;

  ipcMain.handle(IPC.GetState, () => windows.snapshot());

  ipcMain.handle(IPC.OpenNewWindow, () => {
    const win = windows.createWindow();
    return { ok: true };
  });

  ipcMain.handle(IPC.ToggleDevTools, (e) => {
    e.sender.toggleDevTools();
  });

  ipcMain.handle(IPC.ReloadView, (e) => {
    e.sender.reload();
  });

  ipcMain.handle(IPC.OpenInBrowser, () => {
    if (harness.url) shell.openExternal(harness.url);
    return { ok: !!harness.url };
  });

  // ---- 命令面板 ----
  ipcMain.handle(IPC.ListSessions, () => events.sessionList);

  ipcMain.handle(IPC.RunCommand, async (e, { sessionId, line } = {}) => {
    try {
      if (!line || !line.trim()) return { ok: false, error: '命令为空' };
      let agentId = sessionId;
      if (!agentId) {
        const sessions = events.sessionList;
        agentId = sessions.find((s) => s.running)?.id || sessions[0]?.id;
      }
      if (!agentId) {
        return { ok: false, error: '没有可用会话。请先在 harness 页面打开/创建一个会话。' };
      }
      const result = await rpc.executeCommand(agentId, line.trim());
      windows.broadcast(PUSH.CommandResult, { sessionId: agentId, line: line.trim(), result });
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- 主题与外观 ----
  ipcMain.handle(IPC.SetThemeSource, (e, source) => {
    const s = ['system', 'light', 'dark'].includes(source) ? source : 'system';
    nativeTheme.themeSource = s;
    settings.set({ themeSource: s });
    return { ok: true };
  });

  ipcMain.handle(IPC.SetCustomCss, (e, css) => {
    const text = typeof css === 'string' ? css : '';
    settings.set({ customCss: text });
    windows.broadcast(PUSH.Settings, { customCss: text });
    return { ok: true };
  });

  // ---- 设置 ----
  ipcMain.handle(IPC.GetSettings, () => settings.get());

  ipcMain.handle(IPC.SetSettings, (e, patch) => {
    const prev = settings.get();
    const next = settings.set(patch || {});
    if (JSON.stringify(next.shortcuts) !== JSON.stringify(prev.shortcuts)) shortcuts.registerAll();
    if (next.closeBehavior !== prev.closeBehavior) windows.snapshot();
    if (next.themeSource !== prev.themeSource) nativeTheme.themeSource = next.themeSource;
    tray.refresh();
    return { ok: true, settings: next };
  });

  ipcMain.handle(IPC.SetCloseBehavior, (e, behavior) => {
    settings.set({ closeBehavior: behavior });
    return { ok: true };
  });

  // ---- harness 服务控制 ----
  ipcMain.handle(IPC.StartHarness, async () => {
    await harness.start();
    return { ok: true };
  });

  ipcMain.handle(IPC.StopHarness, async () => {
    await harness.stop();
    return { ok: true };
  });

  ipcMain.handle(IPC.RestartHarness, async () => {
    await harness.restart();
    return { ok: true };
  });

  // ---- 文件集成 ----
  ipcMain.handle(IPC.NotifyDroppedFiles, (e, paths) => {
    if (!Array.isArray(paths) || !paths.length) return { ok: false };
    windows.notifyDroppedFiles(windows.mainWindow, paths);
    return { ok: true };
  });

  // ---- 多模态模型路由 ----
  // 会话可用模型目录（provider 分组）
  ipcMain.handle(IPC.ListSessionModels, async (e, sessionId) => {
    if (!sessionId) return { ok: false, error: '缺少会话' };
    try {
      const value = await rpc.sessionModels(sessionId);
      return { ok: true, ...value };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // 直接给会话指定模型
  ipcMain.handle(IPC.SelectSessionModel, async (e, { sessionId, provider, model, reasoningEffort }) => {
    if (!sessionId || !provider || !model) return { ok: false, error: '会话/提供方/模型不能为空' };
    try {
      const value = await rpc.selectSessionModel(sessionId, provider, model, reasoningEffort);
      return { ok: true, selected: value?.selected };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // 保存四档模型路由配置
  ipcMain.handle(IPC.SaveModelRouting, (e, routing) => {
    const clean = { default: {}, vision: {}, image: {}, video: {} };
    for (const role of ['default', 'vision', 'image', 'video']) {
      const r = routing?.[role];
      if (r && typeof r === 'object') {
        clean[role] = {
          provider: String(r.provider || '').trim(),
          model: String(r.model || '').trim(),
        };
      }
    }
    settings.set({ modelRouting: clean });
    windows.broadcast(PUSH.Settings, { modelRouting: clean });
    return { ok: true, modelRouting: clean };
  });

  const ROUTE_LABELS = { default: '常规任务', vision: '图片理解', image: '图片生成', video: '视频生成' };

  // 把某档配置应用到指定会话（无会话时用最近活跃会话）
  ipcMain.handle(IPC.ApplyModelRouting, async (e, { role, sessionId } = {}) => {
    const cfg = settings.get().modelRouting?.[role];
    if (!cfg || !cfg.provider || !cfg.model) {
      return { ok: false, error: `「${ROUTE_LABELS[role] || role}」档尚未配置模型` };
    }
    let target = sessionId;
    if (!target) {
      const sessions = events.sessionList;
      target = sessions.find((s) => s.running)?.id || sessions[0]?.id;
    }
    if (!target) return { ok: false, error: '没有可用会话' };
    try {
      // 查询目标模型是否支持当前会话的 reasoningEffort：
      // 视觉/图片/视频生成模型通常不支持 reasoning，硬传会导致 model-unavailable
      let effort;
      try {
        const dir = await rpc.sessionModels(target);
        const cur = dir?.current?.reasoningEffort;
        if (cur) {
          const group = (dir?.groups || []).find((g) => g.id === cfg.provider);
          const model = group?.models?.find((m) => m.id === cfg.model);
          const supports = model?.reasoning?.efforts?.some((e) => e.id === cur);
          if (supports) effort = cur;
        }
      } catch {}
      const value = await rpc.selectSessionModel(target, cfg.provider, cfg.model, effort);
      return { ok: true, sessionId: target, selected: value?.selected };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- Skill 管理 ----
  ipcMain.handle(IPC.ListSkills, () => {
    try {
      return { ok: true, skills: ctx.skills.scanSkills() };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.ReadSkill, (e, skillPath) => {
    if (typeof skillPath !== 'string' || !skillPath) return { ok: false, error: '缺少路径' };
    try {
      const skill = ctx.skills.readSkill(skillPath);
      return { ok: true, ...skill };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.CreateSkill, (e, input) => {
    try {
      const created = ctx.skills.createSkill(input || {});
      return { ok: true, ...created };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.UpdateSkill, (e, { skillPath, ...input }) => {
    if (typeof skillPath !== 'string' || !skillPath) return { ok: false, error: '缺少路径' };
    try {
      const updated = ctx.skills.updateSkill(skillPath, input || {});
      return { ok: true, ...updated };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.DeleteSkill, (e, skillPath) => {
    if (typeof skillPath !== 'string' || !skillPath) return { ok: false, error: '缺少路径' };
    try {
      return ctx.skills.deleteSkill(skillPath);
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- 看板 ----
  ipcMain.handle(IPC.BoardSnapshot, async () => {
    try {
      const data = await ctx.board.snapshot();
      return { ok: true, ...data };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.BoardSessionDetail, async (e, sessionId) => {
    if (!sessionId) return { ok: false, error: '缺少会话' };
    try {
      const detail = await ctx.board.sessionDetail(sessionId);
      return { ok: true, sessionId, ...detail };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // 在 Finder 中显示 / 打开产出物
  ipcMain.handle(IPC.BoardOpenPath, (e, { path, reveal } = {}) => {
    if (typeof path !== 'string' || !path) return { ok: false, error: '缺少路径' };
    try {
      const abs = path.startsWith('/') || path.startsWith('~')
        ? path.replace(/^~/, os.homedir())
        : path;
      if (reveal) {
        shell.showItemInFolder(abs);
      } else {
        shell.openPath(abs);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- 自定义 UI：选择背景图片 ----
  ipcMain.handle(IPC.PickBackgroundImage, async (e) => {
    const win = windows.mainWindow;
    const res = await dialog.showOpenDialog(win, {
      title: '选择背景图片',
      properties: ['openFile'],
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: res.filePaths[0] };
  });

  // ---- 移动端联动 ----
  ipcMain.handle(IPC.LanStatus, () => ctx.lan.status());

  ipcMain.handle(IPC.LanStart, async () => {
    try {
      await ctx.lan.start();
      settings.set({ lan: { ...settings.get().lan, enabled: true } });
      return { ok: true, status: ctx.lan.status() };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.LanStop, () => {
    ctx.lan.stop();
    settings.set({ lan: { ...settings.get().lan, enabled: false } });
    return { ok: true, status: ctx.lan.status() };
  });

  ipcMain.handle(IPC.LanQr, async () => {
    try {
      const st = ctx.lan.status();
      const ips = st.ips || [];
      const url = ips.length ? `http://${ips[0].address}:${st.port}` : '';
      if (!url) return { ok: false, error: '未检测到局域网 IP' };
      const dataUrl = await ctx.lan.qrDataUrl(url);
      return { ok: true, dataUrl, url };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- 公网隧道（移动网访问） ----
  ipcMain.handle(IPC.TunnelStatus, () => ctx.lan.tunnelStatus());

  ipcMain.handle(IPC.TunnelStart, async () => {
    const res = await ctx.lan.tunnelStart();
    return { ...res, status: ctx.lan.tunnelStatus() };
  });

  ipcMain.handle(IPC.TunnelStop, () => {
    ctx.lan.tunnelStop();
    return { ok: true, status: ctx.lan.tunnelStatus() };
  });

  ipcMain.handle(IPC.TunnelQr, async () => {
    try {
      const st = ctx.lan.tunnelStatus();
      if (!st.url) return { ok: false, error: '隧道尚未建立' };
      const dataUrl = await ctx.lan.qrDataUrl(st.url);
      return { ok: true, dataUrl, url: st.url };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- 看板智能摘要（agnes 小模型 + 本地缓存） ----
  // 先返回缓存，再异步补生成缺失的
  ipcMain.handle(IPC.BoardSummaries, async (e, { sessions, projects } = {}) => {
    const cached = ctx.summaries.cachedSummaries();
    // 触发生成（不 await，异步补全后广播）
    ctx.summaries.ensureSummaries(sessions || [], projects || []).then(() => {}).catch(() => {});
    return { ok: true, summaries: cached };
  });

  // ---- 首次启动向导 ----
  ipcMain.handle(IPC.SetupStatus, async () => {
    const st = ctx.setup.status();
    if (!st.dshFound) {
      const d = await ctx.setup.detectDsh();
      st.dshFound = d.found;
      st.dshCommand = d.command;
    }
    return { ok: true, ...st };
  });

  ipcMain.handle(IPC.SetupDetectDsh, async () => {
    const d = await ctx.setup.detectDsh();
    return { ok: true, found: d.found, command: d.command };
  });

  // 保存 API Key + 默认模型（向导"完成"时调用）
  ipcMain.handle(IPC.SetupSaveKeys, async (e, { deepseekKey, agnesKey, provider, model } = {}) => {
    try {
      const keys = ctx.setup.saveKeys({ deepseekKey, agnesKey });
      let modelSaved = false;
      if (provider && model) {
        modelSaved = ctx.setup.saveDefaultModel({ provider, model, reasoningEffort: 'max' });
      }
      // 保存后若 harness 正在运行，尝试重启以加载新配置
      if (ctx.harness.state === 'running' && modelSaved) {
        ctx.harness.restart().catch(() => {});
      }
      return { ok: true, hasDeepseekKey: !!keys.deepseekKey, hasAgnesKey: !!keys.agnesKey, modelSaved };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.SetupFinish, () => {
    ctx.setup.finish();
    return { ok: true };
  });
}

module.exports = { registerIpc };
