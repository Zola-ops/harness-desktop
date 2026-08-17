// SummaryService：用轻量模型（默认 agnes）为看板会话/项目生成一句话摘要，
// 缓存到本地（userData/board-summaries.json），二次查看直接读缓存，避免重复调用
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const YAML = require('yaml');

const CACHE_FILE = 'board-summaries.json';
const SUMMARY_MODEL = 'agnes-2.5-flash';

class SummaryService extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.app = null; // index.js 注入
    this.cache = null;
    this.agnes = null; // { baseURL, apiKey, models }
    this.busy = false;
  }

  setApp(app) {
    this.app = app;
  }

  cachePath() {
    return path.join(this.app.getPath('userData'), CACHE_FILE);
  }

  loadCache() {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(fs.readFileSync(this.cachePath(), 'utf8'));
    } catch {
      this.cache = { items: {} };
    }
    if (!this.cache.items) this.cache.items = {};
    return this.cache;
  }

  saveCache() {
    if (!this.app) return;
    try {
      fs.writeFileSync(this.cachePath(), JSON.stringify(this.cache, null, 2));
    } catch {}
  }

  // 解析 agnes 配置（凭证 + baseURL + 模型清单），读不到则返回 null
  loadAgnesConfig() {
    if (this.agnes) return this.agnes;
    try {
      const credPath = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.credentials.yaml');
      const cred = fs.existsSync(credPath) ? YAML.parse(fs.readFileSync(credPath, 'utf8')) || {} : {};
      const apiKey = cred.AGNES_API_KEY || process.env.AGNES_API_KEY;
      if (!apiKey) return null;
      // baseURL 与模型清单优先从 harness settings 读取，缺省用默认值
      let baseURL = 'https://apihub.agnes-ai.com/v1';
      let models = ['agnes-2.5-flash', 'agnes-2.0-flash', 'agnes-2.5-pro'];
      try {
        const setPath = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'settings.yaml');
        if (fs.existsSync(setPath)) {
          const st = YAML.parse(fs.readFileSync(setPath, 'utf8')) || {};
          const p = st['llm-pi-ai']?.providers?.agnes;
          if (p) {
            if (typeof p.baseURL === 'string' && p.baseURL) baseURL = p.baseURL;
            if (Array.isArray(p.models)) models = p.models.map((m) => m.id || m).filter(Boolean);
          }
        }
      } catch {}
      this.agnes = { baseURL, apiKey, models };
      return this.agnes;
    } catch {
      return null;
    }
  }

  get enabled() {
    return this.settings.get().summary?.enabled !== false;
  }

  get model() {
    return this.settings.get().summary?.model || SUMMARY_MODEL;
  }

  // ---- 调用 agnes（空返回/失败自动重试一次） ----
  async summarizeText(prompt) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const cfg = this.loadAgnesConfig();
        if (!cfg) throw new Error('未找到 AGNES_API_KEY 凭证');
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 45000);
        let result;
        try {
          const res = await fetch(`${cfg.baseURL.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            signal: ctrl.signal,
            headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
            body: JSON.stringify({
              model: this.model,
              messages: [{ role: 'user', content: prompt }],
              temperature: 0.3,
              max_tokens: 200,
            }),
          });
          if (!res.ok) throw new Error(`agnes HTTP ${res.status}`);
          const j = await res.json();
          const text = j.choices?.[0]?.message?.content || '';
          result = text.trim().replace(/^[\n\s"“”']+|[\n\s"“”']+$/g, '');
        } finally {
          clearTimeout(timer);
        }
        if (result) return result.slice(0, 300);
        // 空内容 → 重试
      } catch {
        if (attempt === 1) throw new Error('agnes 调用失败（已重试）');
      }
    }
    return '';
  }

  // ---- 摘要生成（带缓存） ----
  buildPrompt(kind, info) {
    if (kind === 'session') {
      return `你是知识看板摘要助手。根据以下会话信息，用一句中文（不超过30字）概括这个会话正在做什么。只输出摘要本身，不要前缀、引号或解释。\n\n标题：${info.title || '（无标题）'}\n目标：${info.goal || '（无）'}\n工作目录：${info.cwd || '（无）'}\nAgent 预设：${info.agentPreset || '（无）'}\n规模：${info.turns ?? '?'} turns · ${info.steps ?? '?'} steps`;
    }
    return `你是知识看板摘要助手。根据项目信息和其中的会话标题，用一句中文（不超过30字）概括这个项目/目录是做什么的。只输出摘要本身。\n\n项目名：${info.title || '（无）'}\n路径：${info.path || '（无）'}\n会话：${(info.sessionTitles || []).slice(0, 6).join('、') || '（空）'}`;
  }

  // 确保一批会话/项目的摘要可用：有缓存且会话未更新 → 复用；否则排队生成
  async ensureSummaries(sessions, projects) {
    if (!this.enabled) return {};
    const cache = this.loadCache();
    const todo = [];

    for (const s of sessions || []) {
      const key = `session:${s.id}`;
      const hit = cache.items[key];
      if (hit && hit.updatedAt === s.updatedAt && hit.summary) continue;
      todo.push({ key, kind: 'session', info: { id: s.id, title: s.title, goal: s.goal, cwd: s.cwd, agentPreset: s.agentPreset, turns: s.stats?.turns, steps: s.stats?.steps }, updatedAt: s.updatedAt });
    }
    for (const p of projects || []) {
      const key = `project:${p.id}`;
      const hit = cache.items[key];
      const sessionTitles = (p.sessionIds || []).map((sid) => {
        const s = (sessions || []).find((x) => x.id === sid);
        return s?.title || s?.agentPreset || sid.slice(0, 10);
      }).join('、');
      if (hit && hit.summary && hit.sig === sessionTitles.slice(0, 200)) continue;
      todo.push({ key, kind: 'project', info: { title: p.title, path: p.path, sessionTitles: sessionTitles.split('、') }, sig: sessionTitles.slice(0, 200) });
    }

    // 串行生成（避免并发轰炸小模型）
    const results = {};
    for (const item of todo) {
      try {
        const summary = await this.summarizeText(this.buildPrompt(item.kind, item.info));
        if (summary) {
          cache.items[item.key] = {
            summary,
            model: this.model,
            generatedAt: Date.now(),
            ...(item.kind === 'session' ? { updatedAt: item.updatedAt } : { sig: item.sig }),
          };
          results[item.key] = summary;
          this.emit('summary', { key: item.key, summary, kind: item.kind, id: item.info.id });
        }
      } catch (err) {
        this.emit('summary-error', { key: item.key, error: String(err.message || err) });
        // 失败不阻塞；稍后重试
      }
    }
    if (todo.length) this.saveCache();
    // 返回当前全部缓存（含新生成的）
    const out = {};
    for (const [k, v] of Object.entries(cache.items)) {
      if (v.summary) out[k] = v.summary;
    }
    return out;
  }

  // 当前 API key 可用的模型列表（实时查询 /v1/models，失败时回退配置文件列表）
  async modelList() {
    const cfg = this.loadAgnesConfig();
    if (!cfg) return [];
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      let ids = [];
      try {
        const res = await fetch(`${cfg.baseURL.replace(/\/$/, '')}/models`, {
          signal: ctrl.signal,
          headers: { authorization: `Bearer ${cfg.apiKey}` },
        });
        if (res.ok) {
          const j = await res.json();
          ids = (j.data || []).map((m) => m.id).filter(Boolean);
        }
      } finally {
        clearTimeout(timer);
      }
      if (ids.length) {
        const current = this.model;
        if (!ids.includes(current)) ids.unshift(current);
        return ids;
      }
    } catch {}
    return cfg.models || [];
  }

  // 立即读取缓存摘要（不触发生成）
  cachedSummaries() {
    const cache = this.loadCache();
    const out = {};
    for (const [k, v] of Object.entries(cache.items)) {
      if (v.summary) out[k] = v.summary;
    }
    return out;
  }

  // ================= AI 智能扩展（agnes）：任务总结 / 时间段总结 / 相似关联 / 决策 insight =================

  // 任务总结：做了什么 / 怎么做的 / 踩了哪些坑（结果缓存）
  async taskSummary(session) {
    const key = `task:${session.id}`;
    const cache = this.loadCache();
    const hit = cache.items[key];
    if (hit && hit.updatedAt === session.updatedAt && hit.summary) return { summary: hit.summary, cached: true };
    const info = {
      title: session.title || '',
      goal: session.goal || '',
      cwd: session.cwd || '',
      preset: session.agentPreset || '',
      turns: session.stats?.turns || 0,
      steps: session.stats?.steps || 0,
      tokens: session.tokenUsage?.outputTokens || session.stats?.decodeTokens || 0,
      elapsedMs: session.stats?.llmMs || 0,
    };
    const prompt = `你是 AI 工作记录分析师。根据以下会话数据，输出一段简洁的中文任务总结（200字内），分三部分：
【做了什么】用2-3句话概括任务内容和目标。
【怎么做的】列出关键步骤/方法（若数据不足则基于目标合理推断，注明"推断"）。
【踩坑与经验】列出可能遇到的坑与值得复用的经验（若无信息则写"数据不足"）。

会话标题：${info.title || '（无）'}
目标：${info.goal || '（无）'}
工作目录：${info.cwd || '（无）'}
Agent 预设：${info.preset || '（无）'}
规模：${info.turns} turns · ${info.steps} steps · ${Math.round(info.tokens / 1000)}k 输出 token · ${(info.elapsedMs / 60000).toFixed(0)} 分钟模型耗时

只输出总结内容，不要解释。`;
    const summary = await this.summarizeText(prompt);
    if (summary) {
      cache.items[key] = { summary, model: this.model, generatedAt: Date.now(), updatedAt: session.updatedAt };
      this.saveCache();
    }
    return { summary, cached: false };
  }

  // 时间段总结：该时间段做了什么 / 怎么做的 / 踩坑 / 趋势
  async periodSummary(sessions, from, to) {
    const key = `period:${from}:${to}`;
    const cache = this.loadCache();
    const hit = cache.items[key];
    if (hit && hit.summary) return { summary: hit.summary, cached: true };
    const rows = (sessions || []).map((s) => `- ${s.title || s.agentPreset || s.id.slice(0, 10)}（${s.goal || ''}，${s.stats?.turns || 0} turns，${Math.round((s.tokenUsage?.outputTokens || 0) / 1000)}k 输出）`).join('\n');
    const totalTurns = sessions.reduce((a, s) => a + (s.stats?.turns || 0), 0);
    const totalTokens = sessions.reduce((a, s) => a + (s.tokenUsage?.outputTokens || s.stats?.decodeTokens || 0), 0);
    const prompt = `你是 AI 工作记录分析师。以下是某个时间段内的全部任务（${sessions.length} 个会话，共 ${totalTurns} turns，${Math.round(totalTokens / 1000)}k 输出 token）：
${rows || '（空）'}

请输出一份中文时间段总结（250字内），包含：
1. 【整体进展】这段时间主要做了什么、产出方向；
2. 【重点任务】1-2 个最重要的任务及做法；
3. 【踩坑与经验】从任务目标/标题中可推断的共性坑点与经验（若无则写"数据不足"）；
4. 【趋势】工作重心/节奏的走向。

只输出总结，不要解释。`;
    const summary = await this.summarizeText(prompt);
    if (summary) {
      cache.items[key] = { summary, model: this.model, generatedAt: Date.now() };
      this.saveCache();
    }
    return { summary, cached: false };
  }

  // 相似关联：基于 目标/标题/目录/预设 的关键词重叠 + 共享产出物 计算相似度
  relatedSessions(session, sessions) {
    const tokenize = (s) => {
      const set = new Set();
      for (const t of [s.title, s.goal, s.agentPreset, (s.cwd || '').split('/').filter(Boolean).pop()]) {
        if (t) for (const seg of String(t).split(/[\s,，。；;：:、\/\-_]+/)) if (seg.length >= 2) set.add(seg.toLowerCase());
      }
      return set;
    };
    const base = tokenize(session);
    const scored = (sessions || [])
      .filter((s) => s.id !== session.id)
      .map((s) => {
        const other = tokenize(s);
        let inter = 0;
        for (const t of base) if (other.has(t)) inter++;
        let score = inter / Math.max(1, Math.min(base.size, other.size));
        // 同目录加分
        if (s.cwd && session.cwd && s.cwd === session.cwd) score += 0.2;
        return { id: s.id, title: s.title || s.agentPreset || '', updatedAt: s.updatedAt || 0, score: Math.min(1, score) };
      })
      .filter((s) => s.score > 0.1)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, 5);
  }

  // 决策 insight：基于任务数据 + 总结给出后续建议（不缓存，按需）
  async insight(session, related) {
    const info = {
      title: session.title || '',
      goal: session.goal || '',
      turns: session.stats?.turns || 0,
      tokens: (session.tokenUsage?.outputTokens || session.stats?.decodeTokens || 0) / 1000,
      elapsedMin: Math.round((session.stats?.llmMs || 0) / 60000),
    };
    const relatedText = (related || []).map((r) => `- ${r.title}（相似度 ${Math.round(r.score * 100)}%）`).join('\n');
    const prompt = `你是 AI 决策顾问。基于以下单个任务的数据与相关任务，给出 3 条简洁的中文决策建议（每条一句话，共100字内），用于后续类似工作：改进效率、规避风险、值得延续的做法。

任务：${info.title || '（无）'} / 目标：${info.goal || '（无）'}
规模：${info.turns} turns · ${Math.round(info.tokens)}k 输出 · ${info.elapsedMin} 分钟模型耗时
相关任务：${relatedText || '（无）'}

只输出3条建议，每行一条，不要编号以外的格式。`;
    return this.summarizeText(prompt);
  }
}

module.exports = { SummaryService };
