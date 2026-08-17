// McpService：第三方服务接入 —— 管理 profile 里的 MCP server 配置
// 通过编辑 $DSH_HOME/profiles/web/cordis.patch.yml 添加/移除 @deepseek-ai/dsh-mcp-client 实例
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const YAML = require('yaml');

const MCP_PLUGIN = '@deepseek-ai/dsh-mcp-client';

class McpService {
  constructor(harness) {
    this.harness = harness;
  }

  profilePatchPath() {
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    return path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
  }

  // 读取 patch 中的 MCP 行
  list() {
    const file = this.profilePatchPath();
    let rows = [];
    try {
      if (fs.existsSync(file)) {
        const parsed = YAML.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(parsed)) rows = parsed;
      }
    } catch {}
    return rows
      .filter((r) => r && String(r.id || '').startsWith(MCP_PLUGIN))
      .map((r) => {
        const cfg = r.config || {};
        return {
          id: r.id,
          serverName: cfg.serverName || String(r.id).split(':').pop() || '',
          transport: cfg.transport || 'streamable-http',
          url: cfg.url || '',
          command: cfg.command || '',
          args: cfg.args || [],
          disabled: !!r.disabled,
        };
      });
  }

  // 添加/更新一个 MCP server；返回需重启提示
  upsert({ serverName, transport, url, command, args }) {
    if (!serverName || !/^[a-z0-9-]+$/i.test(serverName)) throw new Error('serverName 需为字母数字连字符');
    const file = this.profilePatchPath();
    let rows = [];
    try {
      if (fs.existsSync(file)) {
        const parsed = YAML.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(parsed)) rows = parsed;
      }
    } catch {}
    const id = `${MCP_PLUGIN}:${serverName}`;
    const config = { serverName, transport };
    if (transport === 'stdio') {
      config.command = command || '';
      config.args = args || [];
    } else {
      config.url = url || '';
    }
    const idx = rows.findIndex((r) => r && String(r.id || '') === id);
    const entry = { id, config };
    if (idx >= 0) rows[idx] = entry;
    else rows.push(entry);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, YAML.stringify(rows));
    return { id };
  }

  remove(serverName) {
    const file = this.profilePatchPath();
    if (!fs.existsSync(file)) return;
    let rows = [];
    try {
      const parsed = YAML.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) rows = parsed;
    } catch {}
    const id = `${MCP_PLUGIN}:${serverName}`;
    rows = rows.filter((r) => !(r && String(r.id || '') === id));
    fs.writeFileSync(file, YAML.stringify(rows));
  }

  // ---- 目录选择器后端（native/browse/auto） ----
  setPickerBackend(kind) {
    if (!['auto', 'native', 'browse'].includes(kind)) throw new Error('无效的选择器类型');
    const file = this.profilePatchPath();
    let rows = [];
    try {
      if (fs.existsSync(file)) {
        const parsed = YAML.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(parsed)) rows = parsed;
      }
    } catch {}
    const idx = rows.findIndex((r) => r && String(r.id || '') === 'directory-picker');
    const mapping = { auto: '@deepseek-ai/dsh-host-directory-picker-auto', native: '@deepseek-ai/dsh-host-directory-picker-native', browse: '@deepseek-ai/dsh-host-directory-picker-browse' };
    if (idx >= 0) rows[idx] = { id: 'directory-picker', name: mapping[kind] };
    else rows.push({ id: 'directory-picker', name: mapping[kind] });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, YAML.stringify(rows));
    return { kind, name: mapping[kind] };
  }

  pickerBackend() {
    const file = this.profilePatchPath();
    try {
      if (fs.existsSync(file)) {
        const rows = YAML.parse(fs.readFileSync(file, 'utf8')) || [];
        const row = (Array.isArray(rows) ? rows : []).find((r) => r && String(r.id || '') === 'directory-picker');
        if (row && row.name) {
          if (row.name.includes('native')) return 'native';
          if (row.name.includes('browse')) return 'browse';
        }
      }
    } catch {}
    return 'auto';
  }

  // 应用配置：重启 harness 使 MCP 生效
  async apply() {
    if (this.harness.state === 'running') {
      await this.harness.restart();
      return { restarted: true };
    }
    return { restarted: false };
  }

  // ================= 模型管理（读写 harness settings.yaml 的 llm-pi-ai.providers） =================
  settingsPath() {
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    return path.join(dshHome, 'settings.yaml');
  }

  readSettings() {
    try {
      if (fs.existsSync(this.settingsPath())) {
        const parsed = YAML.parse(fs.readFileSync(this.settingsPath(), 'utf8'));
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch {}
    return {};
  }

  writeSettings(st) {
    fs.writeFileSync(this.settingsPath(), YAML.stringify(st));
  }

  // provider 列表（llm-pi-ai.providers.*）
  providerList() {
    const st = this.readSettings();
    const providers = st['llm-pi-ai']?.providers || {};
    return Object.entries(providers).map(([id, cfg]) => ({
      id,
      displayName: cfg.displayName || id,
      baseURL: cfg.baseURL || '',
      apiKeyEnv: cfg.apiKeyEnv || '',
      models: Array.isArray(cfg.models) ? cfg.models.map((m) => m.id || m) : [],
    }));
  }

  // 给指定 provider 添加模型（写 settings.yaml，需重启生效）
  addModel(providerId, modelId) {
    if (!providerId || !modelId) throw new Error('provider/model 必填');
    const st = this.readSettings();
    const providers = (st['llm-pi-ai'] = st['llm-pi-ai'] || {});
    const prov = (providers.providers = providers.providers || {});
    const cfg = (prov[providerId] = prov[providerId] || { models: [] });
    if (!Array.isArray(cfg.models)) cfg.models = [];
    if (cfg.models.some((m) => (m.id || m) === modelId)) throw new Error(`模型 ${modelId} 已存在`);
    cfg.models.push({ id: modelId, name: modelId });
    this.writeSettings(st);
    return { providerId, modelId };
  }

  removeModel(providerId, modelId) {
    const st = this.readSettings();
    const cfg = st['llm-pi-ai']?.providers?.[providerId];
    if (cfg && Array.isArray(cfg.models)) {
      cfg.models = cfg.models.filter((m) => (m.id || m) !== modelId);
      this.writeSettings(st);
    }
    return { providerId, modelId };
  }

  // 添加自定义 provider：填 ID/Base URL/API Key → 写入配置 + 自动检测可用模型
  async addProvider({ id, displayName, baseURL, apiKey }) {
    if (!id || !baseURL) throw new Error('id/baseURL 必填');
    const envName = `${String(id).toUpperCase()}_API_KEY`;
    // 1) 写入 API Key 到 credentials.yaml
    if (apiKey && apiKey.trim()) {
      const credPath = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.credentials.yaml');
      let cred = {};
      try {
        if (fs.existsSync(credPath)) cred = YAML.parse(fs.readFileSync(credPath, 'utf8')) || {};
      } catch {}
      cred[envName] = apiKey.trim();
      fs.mkdirSync(path.dirname(credPath), { recursive: true });
      fs.writeFileSync(credPath, YAML.stringify(cred), { mode: 0o600 });
    }
    // 2) 写入 settings.yaml provider 行
    const st = this.readSettings();
    const providers = (st['llm-pi-ai'] = st['llm-pi-ai'] || {});
    providers.providers = providers.providers || {};
    providers.providers[id] = {
      displayName: displayName || id,
      apiKeyEnv: envName,
      api: 'openai-completions',
      baseURL,
      models: [],
    };
    this.writeSettings(st);
    // 3) 自动检测该 key 可用的模型（/v1/models）
    let detected = [];
    if (apiKey && apiKey.trim()) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        try {
          const res = await fetch(`${baseURL.replace(/\/$/, '')}/models`, {
            signal: ctrl.signal,
            headers: { authorization: `Bearer ${apiKey.trim()}` },
          });
          if (res.ok) {
            const j = await res.json();
            detected = (j.data || []).map((m) => m.id).filter(Boolean);
          }
        } finally {
          clearTimeout(timer);
        }
        if (detected.length) {
          providers.providers[id].models = detected.map((m) => ({ id: m, name: m }));
          this.writeSettings(st);
        }
      } catch {}
    }
    return { id, modelsDetected: detected };
  }
}

module.exports = { McpService };
