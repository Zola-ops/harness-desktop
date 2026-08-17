// SkillManager：查看 / 新建 / 编辑 / 删除 harness 技能（skill）
// 技能是 Markdown + YAML frontmatter 文件，支持两种布局：
//   directory-bundle: <root>/<name>/SKILL.md
//   flat:             <root>/<name>.md
// 根目录：~/.agents/skills、$DSH_HOME/skills、项目 .dsh/skills、.agents/skills
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const YAML = require('yaml');

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

class SkillManager {
  constructor() {
    this.roots = null;
  }

  // 用户可写的 skill 根目录（按优先级）
  skillRoots() {
    if (this.roots) return this.roots;
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const agentsHome = path.join(os.homedir(), '.agents');
    this.roots = [
      path.join(agentsHome, 'skills'),
      path.join(dshHome, 'skills'),
    ];
    return this.roots;
  }

  // 新建 skill 的目标目录（与现有用户技能一致：~/.agents/skills）
  get createRoot() {
    return this.skillRoots()[0];
  }

  isSkillName(name) {
    return typeof name === 'string' && SKILL_NAME_RE.test(name);
  }

  // ---- 扫描 ----
  scanSkills() {
    const out = [];
    const seen = new Set();
    for (const root of this.skillRoots()) {
      let entries = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue; // 目录不存在或不可读
      }
      for (const entry of entries) {
        const full = path.join(root, entry.name);
        let info = null;
        let skillPath = null;
        let kind = '';
        try {
          if (entry.isDirectory()) {
            skillPath = path.join(full, 'SKILL.md');
            if (!fs.existsSync(skillPath)) continue;
            kind = 'bundle';
          } else if (entry.isFile() && entry.name.endsWith('.md')) {
            skillPath = full;
            kind = 'flat';
          } else {
            continue;
          }
          info = fs.statSync(skillPath);
        } catch {
          continue;
        }
        const name = entry.name.endsWith('.md') ? entry.name.slice(0, -3) : entry.name;
        if (!this.isSkillName(name) || seen.has(name)) continue;
        seen.add(name);
        out.push({
          name,
          path: skillPath,
          root,
          kind,
          size: info.size,
          mtime: info.mtimeMs,
        });
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  // ---- 读取 ----
  readSkill(skillPath) {
    const raw = fs.readFileSync(skillPath, 'utf8');
    const parsed = this.parseSkillFile(raw);
    return {
      path: skillPath,
      name: parsed.name,
      description: parsed.description,
      whenToUse: parsed.whenToUse,
      disableModelInvocation: parsed.disableModelInvocation,
      userInvocable: parsed.userInvocable,
      metadata: parsed.metadata,
      body: parsed.body,
      extraFrontmatter: parsed.extraFrontmatter,
    };
  }

  parseSkillFile(raw) {
    // 首行必须是 ---
    const firstNl = raw.indexOf('\n');
    if (firstNl < 0 || raw.slice(0, firstNl).replace(/\r$/, '') !== '---') {
      throw new Error('无效的 skill 文件：缺少 YAML frontmatter');
    }
    const start = firstNl + 1;
    const closing = this.findClosing(raw, start);
    if (closing === -1) throw new Error('无效的 skill 文件：frontmatter 未闭合');
    const frontText = raw.slice(start, closing);
    const body = raw.slice(closing + 3).replace(/^\n+/, '').trimEnd();
    let data = {};
    try {
      data = YAML.parse(frontText) || {};
    } catch (err) {
      throw new Error(`frontmatter 解析失败：${err.message}`);
    }
    if (typeof data !== 'object' || Array.isArray(data)) throw new Error('frontmatter 必须是对象');
    const name = typeof data.name === 'string' ? data.name : '';
    const description = typeof data.description === 'string' ? data.description : '';
    if (!name || !description) throw new Error('frontmatter 必须包含 name 和 description');
    if (!this.isSkillName(name)) throw new Error(`skill 名称不合法（需小写字母数字连字符）：${name}`);

    const known = new Set(['name', 'description', 'whenToUse', 'disable-model-invocation', 'user-invocable', 'metadata']);
    const extraFrontmatter = {};
    for (const [k, v] of Object.entries(data)) {
      if (!known.has(k)) extraFrontmatter[k] = v;
    }

    return {
      name,
      description,
      whenToUse: typeof data.whenToUse === 'string' ? data.whenToUse : undefined,
      disableModelInvocation: data['disable-model-invocation'] === true,
      userInvocable: data['user-invocable'] === false ? false : true,
      metadata: data.metadata,
      body,
      extraFrontmatter,
    };
  }

  findClosing(raw, start) {
    const idx = raw.indexOf('\n---', start);
    return idx === -1 ? -1 : idx;
  }

  // ---- 序列化 ----
  buildSkillFile({ name, description, whenToUse, disableModelInvocation, userInvocable, metadata, extraFrontmatter, body }) {
    const data = { name, description };
    if (whenToUse) data.whenToUse = whenToUse;
    if (disableModelInvocation) data['disable-model-invocation'] = true;
    if (userInvocable === false) data['user-invocable'] = false;
    if (metadata && typeof metadata === 'object' && Object.keys(metadata).length) data.metadata = metadata;
    for (const [k, v] of Object.entries(extraFrontmatter || {})) {
      if (!(k in data)) data[k] = v;
    }
    const front = YAML.stringify(data).trimEnd();
    const bodyText = (body || '').trim();
    return `---\n${front}\n---\n\n${bodyText}\n`;
  }

  // ---- 新建 ----
  createSkill(input) {
    const name = String(input.name || '').trim();
    if (!this.isSkillName(name)) throw new Error(`名称不合法：需小写字母数字连字符（如 my-skill）`);
    const description = String(input.description || '').trim();
    if (!description) throw new Error('description 必填');
    const dir = path.join(this.createRoot, name);
    const skillPath = path.join(dir, 'SKILL.md');
    if (fs.existsSync(skillPath)) throw new Error(`skill「${name}」已存在`);
    fs.mkdirSync(dir, { recursive: true });
    const file = this.buildSkillFile({ name, description, whenToUse: input.whenToUse, disableModelInvocation: input.disableModelInvocation, userInvocable: input.userInvocable, metadata: input.metadata, body: input.body });
    fs.writeFileSync(skillPath, file);
    return { name, path: skillPath };
  }

  // ---- 更新（整体重写，保留未知 frontmatter 字段） ----
  updateSkill(skillPath, input) {
    if (!fs.existsSync(skillPath)) throw new Error(`skill 文件不存在：${skillPath}`);
    const prev = this.readSkill(skillPath);
    const name = String(input.name || prev.name || '').trim();
    const description = String(input.description ?? prev.description ?? '').trim();
    if (!this.isSkillName(name)) throw new Error(`名称不合法：${name}`);
    if (!description) throw new Error('description 必填');
    const file = this.buildSkillFile({
      name,
      description,
      whenToUse: input.whenToUse !== undefined ? input.whenToUse : prev.whenToUse,
      disableModelInvocation: input.disableModelInvocation !== undefined ? input.disableModelInvocation : prev.disableModelInvocation,
      userInvocable: input.userInvocable !== undefined ? input.userInvocable : prev.userInvocable,
      metadata: input.metadata !== undefined ? input.metadata : prev.metadata,
      extraFrontmatter: prev.extraFrontmatter,
      body: input.body !== undefined ? input.body : prev.body,
    });
    fs.writeFileSync(skillPath, file);
    return { name, path: skillPath };
  }

  // ---- 删除 ----
  deleteSkill(skillPath) {
    if (!fs.existsSync(skillPath)) return { ok: false, error: '文件不存在' };
    const dir = path.dirname(skillPath);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message) };
    }
  }
}

module.exports = { SkillManager };
