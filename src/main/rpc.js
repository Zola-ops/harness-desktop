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
}

module.exports = { RpcClient };
