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

  // ---- 调用 agnes ----
  async summarizeText(prompt) {
    const cfg = this.loadAgnesConfig();
    if (!cfg) throw new Error('未找到 AGNES_API_KEY 凭证');
    const model = this.model;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const res = await fetch(`${cfg.baseURL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 160,
        }),
      });
      if (!res.ok) throw new Error(`agnes HTTP ${res.status}`);
      const j = await res.json();
      const text = j.choices?.[0]?.message?.content || '';
      return text.trim().replace(/^[\n\s"“”']+|[\n\s"“”']+$/g, '').slice(0, 80);
    } finally {
      clearTimeout(timer);
    }
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

  // 立即读取缓存摘要（不触发生成）
  cachedSummaries() {
    const cache = this.loadCache();
    const out = {};
    for (const [k, v] of Object.entries(cache.items)) {
      if (v.summary) out[k] = v.summary;
    }
    return out;
  }
}

module.exports = { SummaryService };
