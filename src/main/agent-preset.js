// AgentPresetManager：自由创建 / 编辑智能体预设
// 用户预设存储：~/.dsh/.agent-presets/<id>/
//   preset.yml        name + description
//   agent.cordis.yml  composition（persona 行的 config.text = system prompt）
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

class AgentPresetManager {
  presetsDir() {
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    return path.join(dshHome, '.agent-presets');
  }

  presetDir(id) {
    return path.join(this.presetsDir(), id);
  }

  isValidId(id) {
    return typeof id === 'string' && ID_RE.test(id);
  }

  // ---- 创建新智能体（最小 composition：persona = system prompt） ----
  create({ id, name, description, systemPrompt }) {
    id = String(id || '').trim();
    if (!this.isValidId(id)) throw new Error('智能体 ID 需为小写字母数字连字符（如 my-agent）');
    if (!name || !name.trim()) throw new Error('名称必填');
    const dir = this.presetDir(id);
    if (fs.existsSync(dir)) throw new Error(`智能体「${id}」已存在`);
    fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(path.join(dir, 'preset.yml'),
      `name: ${String(name).trim()}\ndescription: ${String(description || name).trim()}\n`);

    const persona = (systemPrompt || '').trim() || `You are a helpful AI agent powered by {{model}}. Your working directory is {{cwd}}.`;
    const yml = `# ${name} — 由 DSH-Z 创建的自定义智能体
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      ${persona.replace(/\n/g, '\n      ')}

- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536
`;
    fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), yml);
    return { id, path: dir };
  }

  // ---- 编辑智能体（保留其他内容，仅替换 persona 的 system prompt / name / description） ----
  edit({ id, name, description, systemPrompt }) {
    if (!this.isValidId(id)) throw new Error('无效的智能体 ID');
    const dir = this.presetDir(id);
    const compPath = path.join(dir, 'agent.cordis.yml');
    const presetPath = path.join(dir, 'preset.yml');
    if (!fs.existsSync(compPath)) throw new Error(`智能体「${id}」不存在`);

    // 1) 更新 preset.yml（name/description）
    if (fs.existsSync(presetPath)) {
      let meta = fs.readFileSync(presetPath, 'utf8');
      if (name !== undefined) meta = meta.replace(/^name:.*$/m, `name: ${String(name).trim()}`);
      if (description !== undefined) meta = meta.replace(/^description:.*$/m, `description: ${String(description).trim()}`);
      fs.writeFileSync(presetPath, meta);
    }

    // 2) 替换 persona 的 text 块（保留文件其余部分与注释）
    if (systemPrompt !== undefined && systemPrompt.trim()) {
      let comp = fs.readFileSync(compPath, 'utf8');
      const personaBlock = /(- id: persona\n  name: '@deepseek-ai\/dsh-persona'\n  config:\n)(?:[ \t]+text: [^\n]*\n(?:[ \t]+[^\n]*\n)*?)(?=\n?[ \t]*- id:|\s*$)/;
      const text = (systemPrompt.trim() + '\n').replace(/\n/g, '\n      ');
      const replacement = `$1    text: >-\n      ${text}`;
      if (personaBlock.test(comp)) {
        comp = comp.replace(personaBlock, replacement);
      } else {
        // 无 persona 块：追加
        comp += `\n- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: >-\n      ${text}`;
      }
      fs.writeFileSync(compPath, comp);
    }
    return { id, path: dir };
  }
}

module.exports = { AgentPresetManager };
