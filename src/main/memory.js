// MemoryService：跨会话记忆库（~/.agents/memory/）
// 结构：index.md 索引 + notes/<id>.md 笔记（frontmatter: title/tags/updated）
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const YAML = require('yaml');

class MemoryService {
  constructor() {
    this.root = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '..', '.agents', 'memory');
  }

  memoryDir() {
    const agentsHome = process.env.DSH_AGENTS_HOME || path.join(os.homedir(), '.agents');
    return path.join(agentsHome, 'memory');
  }

  notesDir() {
    return path.join(this.memoryDir(), 'notes');
  }

  ensure() {
    fs.mkdirSync(this.notesDir(), { recursive: true });
  }

  list() {
    this.ensure();
    const out = [];
    try {
      const entries = fs.readdirSync(this.notesDir(), { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.md')) continue;
        const full = path.join(this.notesDir(), e.name);
        try {
          const stat = fs.statSync(full);
          const meta = this.parseMeta(fs.readFileSync(full, 'utf8'));
          out.push({
            id: e.name.slice(0, -3),
            title: meta.title || e.name.slice(0, -3),
            tags: meta.tags || [],
            path: full,
            size: stat.size,
            mtime: stat.mtimeMs,
          });
        } catch {}
      }
    } catch {}
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  parseMeta(raw) {
    try {
      const firstNl = raw.indexOf('\n');
      if (firstNl < 0 || raw.slice(0, firstNl).replace(/\r$/, '') !== '---') return {};
      const closing = raw.indexOf('\n---', firstNl);
      if (closing < 0) return {};
      const data = YAML.parse(raw.slice(firstNl + 1, closing)) || {};
      return { title: data.title, tags: data.tags };
    } catch {
      return {};
    }
  }

  read(id) {
    this.ensure();
    const full = path.join(this.notesDir(), `${id}.md`);
    if (!fs.existsSync(full)) return null;
    const raw = fs.readFileSync(full, 'utf8');
    return { id, raw, ...this.parseMeta(raw) };
  }

  write({ id, title, tags, body }) {
    this.ensure();
    const safeId = String(id || '').trim() || `note-${Date.now().toString(36)}`;
    const front = YAML.stringify({ title: title || safeId, tags: Array.isArray(tags) ? tags : [] }).trimEnd();
    const content = `---\n${front}\n---\n\n${(body || '').trim()}\n`;
    const full = path.join(this.notesDir(), `${safeId}.md`);
    fs.writeFileSync(full, content);
    return { id: safeId, path: full };
  }

  remove(id) {
    const full = path.join(this.notesDir(), `${id}.md`);
    if (fs.existsSync(full)) fs.rmSync(full, { force: true });
    return true;
  }

  search(q) {
    const items = this.list();
    if (!q) return items;
    const s = q.toLowerCase();
    return items.filter((i) => i.title.toLowerCase().includes(s) || (i.tags || []).some((t) => t.toLowerCase().includes(s)));
  }

  // ================= 锚点驱动的记忆沉淀（agnes 提炼） =================

  async agnesExtract(prompt) {
    // 空返回/失败自动重试一次
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const credPath = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.credentials.yaml');
        const cred = fs.existsSync(credPath) ? YAML.parse(fs.readFileSync(credPath, 'utf8')) || {} : {};
        const apiKey = cred.AGNES_API_KEY || process.env.AGNES_API_KEY;
        if (!apiKey) throw new Error('未找到 AGNES_API_KEY');
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 45000);
        let result = '';
        try {
          const res = await fetch('https://apihub.agnes-ai.com/v1/chat/completions', {
            method: 'POST',
            signal: ctrl.signal,
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model: 'agnes-2.5-flash',
              messages: [{ role: 'user', content: prompt }],
              temperature: 0.3,
              max_tokens: 300,
            }),
          });
          if (!res.ok) throw new Error(`agnes HTTP ${res.status}`);
          const j = await res.json();
          result = (j.choices?.[0]?.message?.content || '').trim().slice(0, 600);
        } finally {
          clearTimeout(timer);
        }
        if (result) return result;
      } catch {}
    }
    return '';
  }

  // 任务完成锚点：提炼值得长期记住的偏好/结论/事实并写入记忆库
  async taskAnchor(session, firstPrompt) {
    const info = {
      title: session.title || '未命名任务',
      goal: session.goal || '',
      firstPrompt: (firstPrompt || '').slice(0, 200),
      turns: session.stats?.turns || 0,
    };
    const prompt = `你是长期记忆助手。以下是刚完成的一个任务（Agent 会话）的信息。请提炼 2-5 条「值得长期记住」的内容，用于后续任务复用：可以是用户的偏好习惯、项目关键事实、已验证的结论或方法、需要避免的坑。只输出条目，每条一行，用「- 」开头，简洁具体。\n\n任务标题：${info.title}\n目标：${info.goal || '（无）'}\n首条指令：${info.firstPrompt || '（无）'}\n规模：${info.turns} turns\n\n如果信息不足以提炼，输出「暂无值得沉淀的长期记忆」。`;
    const text = await this.agnesExtract(prompt);
    if (!text || text.includes('暂无值得沉淀') || text.includes('数据不足')) return null;
    const body = `来源：任务「${info.title}」完成时沉淀\n时间：${new Date().toLocaleString('zh-CN')}\n\n${text}`;
    const result = this.write({
      title: `任务沉淀：${info.title.slice(0, 20)}`,
      tags: ['任务沉淀', '自动'],
      body,
    });
    return { note: result, text };
  }

  // 每 x 轮对话锚点：提炼会话中期形成的偏好
  async turnAnchor(session, turnCount) {
    const prompt = `你是长期记忆助手。当前会话已完成 ${turnCount} 轮对话（Agent 任务进行中）。请从会话进行中提炼最多 2 条「已明显形成」的偏好或事实（比如用户反复表达的习惯、刚确认的项目约束）。不要臆测，只提炼明确出现的。每行一条，用「- 」开头。如果没有明确的新偏好，输出「无」。`;
    const text = await this.agnesExtract(prompt);
    if (!text || text.includes('无') || text.includes('没有')) return null;
    return this.write({
      title: `中期记忆：${new Date().toLocaleDateString('zh-CN')}`,
      tags: ['自动', '中期'],
      body: `来源：会话第 ${turnCount} 轮锚点\n${text}`,
    });
  }

  // 定期总结：汇总全部记忆生成概览（供查看）
  async periodicSummary() {
    const notes = this.list();
    if (!notes.length) return null;
    const rows = notes.slice(0, 30).map((n) => `- ${n.title}${n.tags?.length ? '（' + n.tags.join('、') + '）' : ''}`).join('\n');
    const prompt = `你是长期记忆管理员。以下是记忆库中的全部笔记标题：\n${rows}\n\n请输出一份中文「记忆概览」（150字内）：1) 记忆的主题分类；2) 最值得坚持的 3 条关键记忆；3) 建议清理或合并的重复项。只输出内容。`;
    return this.agnesExtract(prompt);
  }
}

module.exports = { MemoryService };
