// BoardService：Obsidian 式看板的数据层
// 聚合 harness 的会话 / 工作区 / 标题 / 目标 / 统计 / 产出物
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 产出物候选扩展名（从会话消息/工具输出里提取文件引用）
const PRODUCED_EXT = /\.(md|markdown|py|js|ts|jsx|tsx|html|css|scss|json|yaml|yml|csv|xlsx|xls|docx|pptx|pdf|png|jpg|jpeg|webp|gif|svg|zip|tar|gz|txt|sh|sql|db|sqlite)$/i;
// 宽松 token：带路径或裸文件名（含扩展名）
const PATH_TOKEN = /(?:~\/|\/?\.?\/|\.\/|[\w.-]+\/)?[\w@.-]+\.(?:md|markdown|py|js|ts|jsx|tsx|html|css|scss|json|yaml|yml|csv|xlsx|xls|docx|pptx|pdf|png|jpg|jpeg|webp|gif|svg|zip|tar|gz|txt|sh|sql|db|sqlite)(?=["'\s,)\]}>]|$)/gi;
// 查找深度与扫描缓存
const FIND_MAX_DEPTH = 3;
const findCache = new Map(); // cwd -> { at: number, files: Map<basename, fullpath> }

class BoardService {
  constructor(rpc) {
    this.rpc = rpc;
    this.cwdById = new Map(); // snapshot 时记录的 sessionId -> cwd
  }

  // ---- 聚合快照：会话 + 项目（一次拉取全部数据） ----
  async snapshot() {
    const [sessionsRes, workspacesRes] = await Promise.allSettled([
      this.rpc.call('session.list', {}),
      this.rpc.call('workspace.list', {}),
    ]);
    const sessions = sessionsRes.status === 'fulfilled' ? sessionsRes.value?.items || [] : [];
    const workspaces = workspacesRes.status === 'fulfilled' ? workspacesRes.value?.items || [] : [];

    // 会话节点
    const sessionNodes = sessions.map((s) => {
      const proj = s.projections?.values || {};
      this.cwdById.set(s.sessionId, s.cwd || '');
      return {
        id: s.sessionId,
        type: 'session',
        title: proj.title || null,
        goal: proj.goal?.objective || null,
        goalId: proj.goal?.id || null,
        cwd: s.cwd || '',
        agentPreset: s.agentPreset || '',
        parentSessionId: s.parentSessionId || null,
        origin: s.origin || 'root',
        updatedAt: Number(s.updatedAt) || 0,
        running: !!s.running,
        blank: !!s.blank,
        stats: proj.sessionStats || null,
        todos: proj.todos || null,
        plan: proj.plan || null,
      };
    });

    // 项目节点（workspace + 未归档会话按 cwd 目录虚拟分组）
    const wsNodes = workspaces.map((w) => ({
      id: `ws:${w.workspaceId}`,
      type: 'project',
      title: w.title,
      path: w.path,
      sessionIds: w.sessionIds || [],
      createdAt: w.createdAt,
    }));

    // 未归档会话：按 cwd 目录名聚合为虚拟项目
    const wsSessionIds = new Set(wsNodes.flatMap((w) => w.sessionIds));
    const orphanByDir = new Map();
    for (const s of sessionNodes) {
      if (wsSessionIds.has(s.id) || !s.cwd) continue;
      const dir = s.cwd.split('/').filter(Boolean).pop() || s.cwd;
      if (!orphanByDir.has(dir)) orphanByDir.set(dir, { dir, cwd: s.cwd, ids: [] });
      orphanByDir.get(dir).ids.push(s.id);
    }
    for (const [dir, g] of orphanByDir) {
      wsNodes.push({
        id: `dir:${dir}`,
        type: 'project',
        title: dir,
        path: g.cwd,
        sessionIds: g.ids,
        virtual: true,
      });
    }

    // 边：项目→会话、会话→父会话
    const links = [];
    for (const w of wsNodes) {
      for (const sid of w.sessionIds) {
        links.push({ source: w.id, target: sid, kind: 'owns' });
      }
    }
    for (const s of sessionNodes) {
      if (s.parentSessionId) {
        links.push({ source: s.parentSessionId, target: s.id, kind: 'subagent' });
      }
    }

    // 主题维度：每个会话的标题/目标关键词
    const themes = [];
    for (const s of sessionNodes) {
      const label = s.goal || s.title;
      if (label) themes.push({ sessionId: s.id, label: String(label).slice(0, 40) });
    }

    return {
      sessions: sessionNodes,
      projects: wsNodes,
      links,
      themes,
      asOf: Date.now(),
    };
  }

  // ---- 会话详情：首条消息 + 产出物提取（懒加载） ----
  async sessionDetail(sessionId) {
    const cwd = this.cwdById.get(sessionId) || '';
    let history = null;
    try {
      history = await this.rpc.call('session.history', { sessionId, maxMessages: 80 });
    } catch {
      history = null;
    }
    const events = history?.events || [];
    const out = { firstPrompt: null, produced: [], messageCount: events.length };

    // 事件包在 { event: {...} } 里；遍历找首条用户消息 + 文件引用
    const texts = [];
    for (const item of events) {
      const ev = item?.event;
      if (!ev) continue;
      const data = ev.data || {};
      if (ev.type === 'user/message') {
        const content = data.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'text' && block.text) texts.push({ kind: 'user', text: block.text });
          }
        } else if (typeof content === 'string') {
          texts.push({ kind: 'user', text: content });
        }
      } else if (ev.type === 'assistant/message' || ev.type === 'assistant/chunk' || ev.type === 'tool/result') {
        const content = data.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string') texts.push({ kind: 'assistant', text: block.text });
          }
        }
      }
    }

    // 首条用户消息（用于主题确认）
    const firstUser = texts.find((t) => t.kind === 'user');
    if (firstUser) out.firstPrompt = firstUser.text.replace(/\s+/g, ' ').trim().slice(0, 200);

    // 产出物：提取文件引用（带路径直接用；裸文件名尝试在 cwd 下定位）
    const index = this.buildFileIndex(cwd);
    const seen = new Set();
    const produced = [];
    const push = (p) => {
      if (!p || seen.has(p)) return;
      if (/node_modules|\.git\/|\.dsh\/|\.npm\/|Library\/|\.venv|__pycache__|\.cache/i.test(p)) return;
      if (p.length > 200) return;
      seen.add(p);
      produced.push({ path: p, name: p.split('/').pop() });
    };
    for (const t of texts) {
      for (const m of t.text.matchAll(PATH_TOKEN)) {
        let raw = m[0].trim().replace(/^\.\//, '');
        if (raw.startsWith('~/')) raw = raw.slice(2);
        if (!PRODUCED_EXT.test(raw)) continue;
        if (raw.includes('/')) {
          push(raw);
        } else if (index) {
          const hit = index.get(raw);
          if (hit) push(hit);
        }
      }
    }
    out.produced = produced.slice(0, 60);
    return out;
  }

  // 在 cwd 下建立 文件名 -> 完整路径 索引（有限深度，带 5 分钟缓存）
  buildFileIndex(cwd) {
    if (!cwd || !fs.existsSync(cwd)) return null;
    const cached = findCache.get(cwd);
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.files;
    const files = new Map();
    const skip = new Set(['node_modules', '.git', '.dsh', '.npm', '.venv', '__pycache__', '.cache', 'Library', '.next', 'dist', 'build', '.pytest_cache', '.idea', '.vscode']);
    const walk = (dir, depth) => {
      if (depth > FIND_MAX_DEPTH) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (skip.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        try {
          if (entry.isDirectory()) {
            walk(full, depth + 1);
          } else if (entry.isFile() && PRODUCED_EXT.test(entry.name) && !files.has(entry.name)) {
            files.set(entry.name, full);
          }
        } catch {}
      }
    };
    walk(cwd, 0);
    findCache.set(cwd, { at: Date.now(), files });
    return files;
  }
}

module.exports = { BoardService };
