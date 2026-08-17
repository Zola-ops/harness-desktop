// RpcClient：通过 HTTP POST /api/<method> 调用 harness 的远程方法
// 实测发现两类端点协议不同：
//   1) host-apiproxy 直接注册（session.* 等）：路径用点号（/api/session.models），payload 即参数对象
//   2) Typert Remote（commands.* 等）：路径用斜杠（/api/commands/list），payload 需 { args: {...} } 包装
'use strict';

const { randomUUID } = require('node:crypto');

// 需要 { args } 包装的 Typert 端点（点号/斜杠路径均按注册表原样）
const ARGS_WRAPPED = new Set(['commands/list', 'commands/execute']);

class RpcClient {
  constructor(getBaseUrl) {
    this.getBaseUrl = getBaseUrl; // () => 'http://127.0.0.1:<port>'
  }

  async call(method, payload, { timeoutMs = 30000 } = {}) {
    const base = this.getBaseUrl();
    if (!base) throw new Error('harness 服务未运行');
    const rpcId = randomUUID();
    const wrap = ARGS_WRAPPED.has(method);
    const envelope = wrap
      ? { type: 'client-request', rpcId, method, payload: { args: payload ?? {} } }
      : { type: 'client-request', rpcId, method, payload: payload ?? {} };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}/api/${method}`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`RPC ${method} HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const body = await res.json();
      if (body.rpcId !== rpcId) throw new Error(`RPC ${method}: rpcId 不匹配`);
      if (!body.result || body.result.ok !== true) {
        const err = body.result?.error || {};
        throw new Error(`RPC ${method} 失败: ${err.code || 'unknown'} ${err.message || ''}`);
      }
      return body.result.value;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`RPC ${method} 超时`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- 命令面板 ----
  async listCommands(agentId) {
    return this.call('commands/list', { agentId });
  }

  async executeCommand(agentId, line) {
    return this.call('commands/execute', { agentId, line });
  }

  // ---- 模型 ----
  async sessionModels(sessionId) {
    return this.call('session.models', { sessionId });
  }

  async selectSessionModel(sessionId, provider, model, reasoningEffort) {
    const payload = { sessionId, provider, model };
    if (reasoningEffort) payload.reasoningEffort = reasoningEffort;
    return this.call('session.selectModel', payload);
  }

  // ---- 会话管理 ----
  async searchSessions(query) {
    return this.call('session.search', { query });
  }

  async createSession({ workspaceId, cwd, agentPreset } = {}) {
    const payload = {};
    if (workspaceId) payload.workspaceId = workspaceId;
    if (cwd) payload.cwd = cwd;
    if (agentPreset) payload.agentPreset = agentPreset;
    return this.call('session.create', payload);
  }

  async renameSession(sessionId, title) {
    return this.call('session.rename', { sessionId, title });
  }

  async cancelSession(sessionId) {
    return this.call('session.cancel', { sessionId });
  }

  async forkSession(sessionId, { cwd } = {}) {
    return this.call('session.fork', { sessionId, ...(cwd ? { cwd } : {}) });
  }

  // ---- Goal ----
  async goalCreate(sessionId, objective) {
    return this.call('goal.create', { sessionId, objective });
  }

  async goalEdit(sessionId, id, revision, objective) {
    return this.call('goal.edit', { sessionId, id, revision, objective });
  }

  async goalComplete(sessionId, id, revision) {
    return this.call('goal.complete', { sessionId, id, revision });
  }

  // ---- 审批应答（POST /api/respond，client-response 信封） ----
  async approvalRespond({ rpcId, sessionId, approvalId, outcome }) {
    const base = this.getBaseUrl();
    if (!base) throw new Error('harness 服务未运行');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(`${base}/api/respond`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-response',
          rpcId,
          result: { ok: true, value: { sessionId, approvalId, outcome } },
        }),
      });
      const j = await res.json().catch(() => ({}));
      return { ok: j.accepted === true, reason: j.reason || '' };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- 会话导出 ZIP（GET /api/session.export?sessionId=xxx → zip 流） ----
  async sessionExport(sessionId, signal) {
    const base = this.getBaseUrl();
    if (!base) throw new Error('harness 服务未运行');
    const url = `${base}/api/session.export?sessionId=${encodeURIComponent(sessionId)}`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`导出失败（HTTP ${res.status}）`);
    return res;
  }

  // ---- Subagent 协作树 ----
  async subagentList(parentSessionId) {
    return this.call('subagent.list', { parentSessionId });
  }

  async subagentInterrupt(parentSessionId, childSessionId) {
    return this.call('subagent.interrupt', { parentSessionId, childSessionId, mode: 'continuable' });
  }

  async subagentPrompt(parentSessionId, childSessionId, text) {
    return this.call('subagent.prompt', {
      parentSessionId,
      childSessionId,
      mode: 'continuable',
      content: [{ type: 'text', text }],
    });
  }

  // ---- 智能体预设 ----
  async agentPresetList() {
    return this.call('agentPreset.list', {});
  }

  async agentPresetSelect(sessionId, agentPreset) {
    return this.call('agentPreset.select', { sessionId, agentPreset });
  }

  async agentPresetRead(agentPreset) {
    return this.call('agentPreset.read', { agentPreset });
  }

  async agentPresetCopy(from, agentPreset, name) {
    return this.call('agentPreset.copy', { from, agentPreset, ...(name ? { name } : {}) });
  }

  async agentPresetRemove(agentPreset) {
    return this.call('agentPreset.remove', { agentPreset });
  }
}

module.exports = { RpcClient };
