// SetupService：首次启动向导 —— 检测 dsh、配置 API Key、设置默认模型
// 目标：用户下载安装后，按向导填一个 API Key 即可直接使用
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const YAML = require('yaml');

class SetupService {
  constructor(settings, harness) {
    this.settings = settings;
    this.harness = harness;
  }

  dshHome() {
    return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  }

  credentialsPath() {
    return path.join(this.dshHome(), '.credentials.yaml');
  }

  settingsPath() {
    return path.join(this.dshHome(), 'settings.yaml');
  }

  // ---- 状态 ----
  status() {
    return {
      onboardingDone: !!this.settings.get().onboardingDone,
      dshFound: !!this.harness._dshCommand,
      dshCommand: this.harness._dshCommand || '',
      hasDeepseekKey: this.readKeys().deepseekKey ? true : false,
      hasAgnesKey: this.readKeys().agnesKey ? true : false,
    };
  }

  async detectDsh() {
    const cmd = await this.harness.detectDshCommand();
    return { found: !!cmd, command: cmd };
  }

  // ---- 读取现有 API Key（不打印值） ----
  readKeys() {
    const out = { deepseekKey: '', agnesKey: '' };
    try {
      const cred = fs.existsSync(this.credentialsPath())
        ? YAML.parse(fs.readFileSync(this.credentialsPath(), 'utf8')) || {}
        : {};
      out.deepseekKey = typeof cred.DEEPSEEK_API_KEY === 'string' ? cred.DEEPSEEK_API_KEY : '';
      out.agnesKey = typeof cred.AGNES_API_KEY === 'string' ? cred.AGNES_API_KEY : '';
    } catch {}
    return out;
  }

  // ---- 写入 API Key（保留 credentials.yaml 其他字段） ----
  saveKeys({ deepseekKey, agnesKey }) {
    let cred = {};
    try {
      if (fs.existsSync(this.credentialsPath())) {
        cred = YAML.parse(fs.readFileSync(this.credentialsPath(), 'utf8')) || {};
      }
    } catch {}
    if (typeof cred !== 'object' || cred === null) cred = {};
    if (deepseekKey && deepseekKey.trim()) cred.DEEPSEEK_API_KEY = deepseekKey.trim();
    if (agnesKey && agnesKey.trim()) cred.AGNES_API_KEY = agnesKey.trim();
    fs.mkdirSync(this.dshHome(), { recursive: true });
    fs.writeFileSync(this.credentialsPath(), YAML.stringify(cred), { mode: 0o600 });
    return this.readKeys();
  }

  // ---- 设置默认模型（写入 harness settings.yaml 的 agent-default-model，保留其他配置） ----
  saveDefaultModel({ provider, model, reasoningEffort }) {
    if (!provider || !model) return false;
    let st = {};
    try {
      if (fs.existsSync(this.settingsPath())) {
        st = YAML.parse(fs.readFileSync(this.settingsPath(), 'utf8')) || {};
      }
    } catch {}
    if (typeof st !== 'object' || st === null) st = {};
    st['agent-default-model'] = {
      provider,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
    fs.mkdirSync(this.dshHome(), { recursive: true });
    fs.writeFileSync(this.settingsPath(), YAML.stringify(st));
    return true;
  }

  // ---- 完成向导 ----
  finish() {
    this.settings.set({ onboardingDone: true });
    return { ok: true };
  }
}

module.exports = { SetupService };
