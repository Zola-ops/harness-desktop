// IPC 注册表：渲染层（壳）与主进程的桥梁
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const { ipcMain, shell, nativeTheme, dialog } = require('electron');
const { IPC, PUSH } = require('../shared/constants');

function registerIpc(ctx) {
  const { settings, harness, rpc, events, windows, tray, shortcuts } = ctx;

  // ---- 诊断包装：捕获任何 undefined 参数（Electron 序列化层会报 conversion failure） ----
  const origHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => {
    origHandle(channel, async (event, ...args) => {
      try {
        if (args.some((a) => a === undefined)) {
          console.error(`[ipc-diag] ${channel} 收到 undefined 参数:`, JSON.stringify(args.map((a) => typeof a)));
        }
        return await handler(event, ...args);
      } catch (err) {
        console.error(`[ipc-diag] ${channel} handler 异常:`, err && err.stack ? err.stack.slice(0, 600) : String(err));
        throw err;
      }
    });
  };

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
  ipcMain.handle(IPC.AppVersion, () => {
    try { return { ok: true, version: require('../package.json').version || '' }; }
    catch { return { ok: false, version: '' }; }
  });

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
      const url = ctx.lan.publicUrl();
      if (!url) return { ok: false, error: '尚无公网地址' };
      const dataUrl = await ctx.lan.qrDataUrl(url);
      return { ok: true, dataUrl, url };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // 自定义公网地址（自有域名 + SSH 反向隧道/frp/CF named tunnel 映射）
  ipcMain.handle(IPC.TunnelCustomUrl, async (e, url) => {
    try {
      const r = ctx.lan.setCustomTunnelUrl(url);
      return { ...r, status: ctx.lan.tunnelStatus() };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.TailscaleStatus, async () => {
    try {
      const ts = await ctx.lan.tailscaleStatus();
      const lan = ctx.lan.status();
      return {
        ok: true,
        installed: ts.installed,
        ip: ts.ip,
        // Tailscale 组网内访问地址：LAN 代理端口（3180）
        url: ts.ip ? `http://${ts.ip}:${lan.port}` : '',
      };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- frp 内网穿透（自持服务器 + 自有域名） ----
  ipcMain.handle(IPC.FrpStatus, () => {
    try {
      return { ok: true, config: ctx.lan.frpConfig(), status: ctx.lan.frpStatus() };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.FrpSave, (e, cfg) => {
    try {
      const r = ctx.lan.frpSave(cfg || {});
      return { ...r, status: ctx.lan.frpStatus() };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.FrpStart, async () => {
    try {
      const r = await ctx.lan.frpStart();
      return { ...r, status: ctx.lan.frpStatus(), tunnel: ctx.lan.tunnelStatus() };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.FrpStop, () => {
    try {
      ctx.lan.frpStop();
      return { ok: true, status: ctx.lan.frpStatus(), tunnel: ctx.lan.tunnelStatus() };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- SSH 反向隧道（复用 22 端口，无需服务器开新端口） ----
  ipcMain.handle(IPC.SshStatus, () => {
    try {
      return { ok: true, config: ctx.lan.sshConfig(), status: ctx.lan.sshStatus() };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.SshSave, (e, cfg) => {
    try {
      const r = ctx.lan.sshSave(cfg || {});
      return { ...r, status: ctx.lan.sshStatus() };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.SshStart, async () => {
    try {
      const r = await ctx.lan.sshStart();
      return { ...r, status: ctx.lan.sshStatus(), tunnel: ctx.lan.tunnelStatus() };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.SshStop, () => {
    try {
      ctx.lan.sshStop();
      return { ok: true, status: ctx.lan.sshStatus(), tunnel: ctx.lan.tunnelStatus() };
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

  // ---- 审批快捷操作 ----
  ipcMain.handle(IPC.GetApprovals, () => {
    const { pendingApprovals } = ctx;
    return { ok: true, approvals: [...pendingApprovals.values()] };
  });

  // 允许或拒绝一个待审批请求（client-response → /api/respond）
  ipcMain.handle(IPC.ApprovalRespond, async (e, { approvalId, outcome }) => {
    const { pendingApprovals } = ctx;
    const item = pendingApprovals.get(approvalId);
    if (!item) return { ok: false, error: '该审批已处理或不存在' };
    try {
      const res = await rpc.approvalRespond({
        rpcId: item.rpcId,
        sessionId: item.sessionId,
        approvalId: item.approvalId,
        outcome: outcome === 'rejected' ? 'rejected' : 'allowed-once',
      });
      if (res.ok) {
        pendingApprovals.delete(approvalId);
        windows.broadcast(PUSH.Event, { kind: 'approvals', approvals: [...pendingApprovals.values()] });
        return { ok: true };
      }
      return { ok: false, error: `未接受（${res.reason || 'unknown'}）` };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- 全局搜索（跨会话） ----
  // 优先 session.search；该端点被部署禁用时回退到本地遍历会话历史
  ipcMain.handle(IPC.GlobalSearch, async (e, query) => {
    if (!query || !query.trim()) return { ok: true, items: [] };
    const q = query.trim().toLowerCase();
    try {
      const v = await rpc.searchSessions(q);
      const sessions = events.sessionList;
      const items = (v.items || []).map((it) => {
        const s = sessions.find((x) => x.id === it.sessionId);
        return { sessionId: it.sessionId, snippet: it.snippet, title: s?.title || s?.agentPreset || '', updatedAt: s?.updatedAt || 0 };
      });
      return { ok: true, items, hasMore: v.hasMore };
    } catch {
      // fallback：先匹配会话标题/目标（全量投影），再扫描最近会话历史
      let snap = { sessions: [] };
      try {
        snap = await ctx.board.snapshot();
      } catch {}
      const items = [];
      const seen = new Set();
      for (const s of snap.sessions) {
        const hay = [s.title, s.goal, s.cwd, s.agentPreset].filter(Boolean).join(' ');
        if (hay.toLowerCase().includes(q)) {
          items.push({
            sessionId: s.id,
            snippet: `标题：${s.title || ''} ${s.goal ? `｜目标：${s.goal}` : ''}`.slice(0, 200),
            title: s.title || s.agentPreset || '',
            updatedAt: s.updatedAt || 0,
          });
          seen.add(s.id);
        }
      }
      // 再扫描最近会话的历史文本（最多 6 个，取最近 60 条消息）
      const recent = [...snap.sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
      for (const s of recent) {
        if (seen.has(s.id)) continue;
        let hist = null;
        try {
          hist = await rpc.call('session.history', { sessionId: s.id, maxMessages: 60 });
        } catch {
          continue;
        }
        const texts = [];
        for (const item of hist?.events || []) {
          const ev = item?.event;
          const content = ev?.data?.message?.content;
          if (Array.isArray(content)) {
            for (const b of content) {
              if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
            }
          }
        }
        const joined = texts.join('\n');
        const idx = joined.toLowerCase().indexOf(q);
        if (idx >= 0) {
          const start = Math.max(0, idx - 50);
          items.push({
            sessionId: s.id,
            snippet: joined.slice(start, start + 180).replace(/\s+/g, ' ').trim(),
            title: s.title || s.agentPreset || '',
            updatedAt: s.updatedAt || 0,
          });
        }
      }
      items.sort((a, b) => b.updatedAt - a.updatedAt);
      return { ok: true, items: items.slice(0, 20), hasMore: false, fallback: true };
    }
  });

  // ---- 会话管理 ----
  ipcMain.handle(IPC.SessionCreate, async (e, { workspaceId, cwd, agentPreset } = {}) => {
    try {
      const v = await rpc.createSession({ workspaceId, cwd, agentPreset });
      return { ok: true, sessionId: v.sessionId };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.SessionRename, async (e, { sessionId, title }) => {
    if (!sessionId || !title?.trim()) return { ok: false, error: '参数缺失' };
    try {
      await rpc.renameSession(sessionId, title.trim());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.SessionCancel, async (e, sessionId) => {
    if (!sessionId) return { ok: false, error: '缺少会话' };
    try {
      await rpc.cancelSession(sessionId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.SessionFork, async (e, { sessionId, cwd } = {}) => {
    if (!sessionId) return { ok: false, error: '缺少会话' };
    try {
      const v = await rpc.forkSession(sessionId, { cwd });
      return { ok: true, sessionId: v.sessionId };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- Goal 管理 ----
  ipcMain.handle(IPC.GoalCreate, async (e, { sessionId, objective }) => {
    if (!sessionId || !objective?.trim()) return { ok: false, error: '参数缺失' };
    try {
      const v = await rpc.goalCreate(sessionId, objective.trim());
      return { ok: true, ref: v.ref };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.GoalComplete, async (e, { sessionId, id, revision }) => {
    if (!sessionId || !id) return { ok: false, error: '参数缺失' };
    try {
      await rpc.goalComplete(sessionId, id, revision);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- 会话导出 ZIP ----
  ipcMain.handle(IPC.SessionExport, async (e, sessionId) => {
    if (!sessionId) return { ok: false, error: '缺少会话' };
    try {
      const ctrl = new AbortController();
      const res = await rpc.sessionExport(sessionId, ctrl.signal);
      const buf = Buffer.from(await res.arrayBuffer());
      const win = windows.mainWindow;
      const save = await dialog.showSaveDialog(win, {
        title: '导出会话',
        defaultPath: `harness-session-${sessionId.slice(0, 8)}.zip`,
        filters: [{ name: 'ZIP 存档', extensions: ['zip'] }],
      });
      if (save.canceled || !save.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(save.filePath, buf);
      return { ok: true, path: save.filePath, size: buf.length };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- Subagent 协作树（递归构建） ----
  async function buildSubagentTree(sessionId, depth) {
    if (depth > 6) return null;
    let list;
    try {
      list = await rpc.subagentList(sessionId);
    } catch {
      return null;
    }
    const nodes = [];
    for (const entry of list.entries || []) {
      if (entry.kind === 'diagnostic') {
        nodes.push({ kind: 'diagnostic', id: entry.id, reason: entry.reason });
        continue;
      }
      const node = {
        kind: entry.kind,
        id: entry.id,
        mode: entry.mode,
        activity: entry.activity,
        label: entry.label,
        running: entry.activity === 'running',
      };
      if (entry.kind === 'child' && entry.hasChildren) {
        node.children = await buildSubagentTree(entry.id, depth + 1) || [];
      }
      nodes.push(node);
    }
    return nodes;
  }

  ipcMain.handle(IPC.SubagentTree, async (e, sessionId) => {
    if (!sessionId) return { ok: false, error: '缺少会话' };
    try {
      const tree = await buildSubagentTree(sessionId, 0);
      return { ok: true, tree: tree || [] };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.SubagentInterrupt, async (e, { parentSessionId, childSessionId }) => {
    if (!parentSessionId || !childSessionId) return { ok: false, error: '参数缺失' };
    try {
      await rpc.subagentInterrupt(parentSessionId, childSessionId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- 智能体预设 ----
  ipcMain.handle(IPC.AgentPresets, async () => {
    try {
      const v = await rpc.agentPresetList();
      return { ok: true, presets: v.presets || [], authorable: !!v.authorable };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.AgentPresetApply, async (e, { sessionId, agentPreset }) => {
    if (!sessionId || !agentPreset) return { ok: false, error: '参数缺失' };
    try {
      await rpc.agentPresetSelect(sessionId, agentPreset);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.AgentPresetRead, async (e, agentPreset) => {
    if (!agentPreset) return { ok: false, error: '缺少预设' };
    try {
      const v = await rpc.agentPresetRead(agentPreset);
      return { ok: true, content: v.content, name: v.name, description: v.description };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.AgentPresetCopy, async (e, { from, name }) => {
    if (!from) return { ok: false, error: '缺少源预设' };
    try {
      const newId = `${from}-copy-${Date.now().toString(36)}`;
      const v = await rpc.agentPresetCopy(from, newId, name);
      return { ok: true, agentPreset: v.agentPreset };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.AgentPresetRemove, async (e, agentPreset) => {
    if (!agentPreset) return { ok: false, error: '缺少预设' };
    try {
      await rpc.agentPresetRemove(agentPreset);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- 记忆模块 ----
  ipcMain.handle(IPC.MemoryList, (e, q) => {
    try {
      return { ok: true, notes: ctx.memory.search(q || '') };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.MemoryRead, (e, id) => {
    try {
      const n = ctx.memory.read(id);
      return n ? { ok: true, ...n } : { ok: false, error: '笔记不存在' };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.MemoryWrite, (e, input) => {
    try {
      const r = ctx.memory.write(input || {});
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.MemoryRemove, (e, id) => {
    try {
      ctx.memory.remove(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- 子代理委派 ----
  ipcMain.handle(IPC.SubagentPrompt, async (e, { parentSessionId, childSessionId, text }) => {
    if (!parentSessionId || !childSessionId || !text?.trim()) return { ok: false, error: '参数缺失' };
    try {
      const v = await rpc.subagentPrompt(parentSessionId, childSessionId, text.trim());
      return { ok: true, messageId: v.messageId };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- MCP 第三方服务 ----
  ipcMain.handle(IPC.McpList, () => {
    try {
      return { ok: true, servers: ctx.mcp.list() };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.McpUpsert, (e, input) => {
    try {
      const r = ctx.mcp.upsert(input || {});
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.McpRemove, (e, serverName) => {
    try {
      ctx.mcp.remove(serverName);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- 配置中心：模型/Provider 管理 ----
  ipcMain.handle(IPC.ConfigProviders, () => {
    try {
      return { ok: true, providers: ctx.mcp.providerList() };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.ConfigAddProvider, (e, input) => {
    try {
      const r = ctx.mcp.addProvider(input || {});
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.ConfigAddModel, (e, { providerId, modelId }) => {
    try {
      const r = ctx.mcp.addModel(providerId, modelId);
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.ConfigRemoveModel, (e, { providerId, modelId }) => {
    try {
      const r = ctx.mcp.removeModel(providerId, modelId);
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.McpApply, async () => {
    try {
      const r = await ctx.mcp.apply();
      return { ok: true, restarted: r.restarted };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- 看板摘要模型列表 ----
  ipcMain.handle(IPC.SummaryModels, async () => {
    try {
      const models = await ctx.summaries.modelList();
      return { ok: true, models, current: ctx.summaries.model };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- 目录选择器后端 ----
  ipcMain.handle(IPC.PickerBackend, () => ({ ok: true, backend: ctx.mcp.pickerBackend() }));

  ipcMain.handle(IPC.PickerSet, (e, kind) => {
    try {
      const r = ctx.mcp.setPickerBackend(kind);
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- 智能体自由创建 / 编辑 ----
  ipcMain.handle(IPC.AgentPresetCreate, (e, input) => {
    try {
      const r = ctx.agentPresetMgr.create(input || {});
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.AgentPresetEdit, (e, input) => {
    try {
      const r = ctx.agentPresetMgr.edit(input || {});
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- 记忆锚点立即总结 ----
  ipcMain.handle(IPC.MemorySummaryNow, async () => {
    try {
      const text = await ctx.memory.periodicSummary();
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- 看板 AI 智能扩展（agnes） ----
  ipcMain.handle(IPC.TaskSummary, async (e, { sessionId } = {}) => {
    if (!sessionId) return { ok: false, error: '缺少会话' };
    try {
      const snap = await ctx.board.snapshot();
      const session = snap.sessions.find((x) => x.id === sessionId);
      if (!session) return { ok: false, error: '会话不存在' };
      const r = await ctx.summaries.taskSummary(session);
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.PeriodSummary, async (e, { from, to } = {}) => {
    try {
      const snap = await ctx.board.snapshot();
      const fromT = from ? new Date(from).getTime() : 0;
      const toT = to ? new Date(to).getTime() + 86399999 : Date.now();
      const sessions = snap.sessions.filter((s) => s.updatedAt >= fromT && s.updatedAt <= toT);
      const r = await ctx.summaries.periodSummary(sessions, from || 'start', to || 'now');
      return { ok: true, count: sessions.length, ...r };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.RelatedSessions, async (e, sessionId) => {
    if (!sessionId) return { ok: false, error: '缺少会话' };
    try {
      const snap = await ctx.board.snapshot();
      const session = snap.sessions.find((x) => x.id === sessionId);
      if (!session) return { ok: false, error: '会话不存在' };
      const related = ctx.summaries.relatedSessions(session, snap.sessions);
      return { ok: true, related };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(IPC.Insight, async (e, sessionId) => {
    if (!sessionId) return { ok: false, error: '缺少会话' };
    try {
      const snap = await ctx.board.snapshot();
      const session = snap.sessions.find((x) => x.id === sessionId);
      if (!session) return { ok: false, error: '会话不存在' };
      const related = ctx.summaries.relatedSessions(session, snap.sessions);
      const text = await ctx.summaries.insight(session, related);
      return { ok: true, insight: text, related };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- 资产仓库（聚合全部会话的产出物） ----
  ipcMain.handle(IPC.AssetsList, async () => {
    try {
      const snap = await ctx.board.snapshot();
      const sessions = [...snap.sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
      const assets = [];
      for (const s of sessions) {
        try {
          const detail = await ctx.board.sessionDetail(s.id);
          for (const p of detail.produced || []) {
            assets.push({
              name: p.name,
              path: p.path,
              sessionId: s.id,
              sessionTitle: s.title || s.agentPreset || '',
              updatedAt: s.updatedAt || 0,
            });
          }
        } catch {}
      }
      // 按路径去重
      const seen = new Set();
      const unique = assets.filter((a) => {
        if (seen.has(a.path)) return false;
        seen.add(a.path);
        return true;
      });
      return { ok: true, assets: unique };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
}

module.exports = { registerIpc };
