// EventBridge：双流订阅 harness 事件
//   mux 流（/api/events.mux）：会话级 —— 连接即推全部会话 baseline（session/subscribed），
//     随后推送 approval/requested、question/requested、session/event、session/jobs 等
//   host 流（/api/events.host）：宿主级 —— 会话生命周期（added/removed/status）、agent-error、remote-event
// 帧信封：{ type: 'server-request', rpcId, method, payload: { type: ..., ... } }
'use strict';

const { EventEmitter } = require('node:events');
const WebSocket = require('ws'); // Electron 主进程（Node 20）无全局 WebSocket，用 ws 包

class EventBridge extends EventEmitter {
  constructor(getBaseUrl) {
    super();
    this.getBaseUrl = getBaseUrl;
    this.sessions = new Map(); // sessionId -> { id, title?, running, blank?, agentPreset?, lastSeen, jobs? }
    this._sockets = new Map(); // 'mux' | 'host' -> WebSocket
    this._retryTimers = new Map();
    this._retryDelay = 1000;
    this._destroyed = false;
    this._dedupe = new Map();
  }

  get sessionList() {
    return [...this.sessions.values()]
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
      .map((s) => ({ ...s }));
  }

  getSession(id) {
    return this.sessions.get(id) || null;
  }

  async connect() {
    if (this._destroyed) return;
    const base = this.getBaseUrl();
    if (!base) return;
    const wsBase = base.replace(/^http/, 'ws');
    this.openStream('mux', `${wsBase}/api/events.mux`);
    this.openStream('host', `${wsBase}/api/events.host`);
  }

  openStream(name, url) {
    if (this._sockets.has(name)) return;
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      this.emit('error', `${name} WebSocket 创建失败：${err.message}`);
      this.scheduleReconnect(name);
      return;
    }
    this._sockets.set(name, socket);

    socket.on('open', () => {
      this._retryDelay = 1000;
      this.emit('status', { stream: name, connected: true });
    });

    socket.on('message', (data) => {
      const text = typeof data === 'string' ? data : data.toString();
      try {
        const full = JSON.parse(text);
        const payload = full?.payload;
        if (!payload || typeof payload !== 'object' || !payload.type) return;
        this.handleFrame(name, payload, full?.rpcId || '');
      } catch {
        // 丢帧不致命
      }
    });

    const onClose = () => {
      this._sockets.delete(name);
      this.emit('status', { stream: name, connected: false });
      this.scheduleReconnect(name);
    };
    socket.on('close', onClose);
    socket.on('error', () => {}); // close 随后触发，统一走重连
  }

  scheduleReconnect(name) {
    if (this._retryTimers.has(name) || this._destroyed) return;
    if (!this.getBaseUrl()) return;
    const timer = setTimeout(() => {
      this._retryTimers.delete(name);
      const base = this.getBaseUrl();
      if (!base) return;
      const wsBase = base.replace(/^http/, 'ws');
      this.openStream(name, name === 'mux' ? `${wsBase}/api/events.mux` : `${wsBase}/api/events.host`);
    }, this._retryDelay);
    this._retryTimers.set(name, timer);
    this._retryDelay = Math.min(this._retryDelay * 2, 30000);
  }

  // ---------- 帧处理 ----------
  handleFrame(stream, payload, rpcId) {
    const now = Date.now();
    const id = payload.sessionId;
    switch (payload.type) {
      // mux：会话 baseline + 会话内事件
      case 'session/subscribed': {
        if (!id) break;
        const prev = this.sessions.get(id) || {};
        this.sessions.set(id, { ...prev, id, running: prev.running || false, lastSeen: now });
        this.emit('sessions-changed');
        break;
      }
      case 'session/jobs': {
        if (!id) break;
        const prev = this.sessions.get(id);
        if (prev) {
          this.sessions.set(id, { ...prev, jobs: payload.jobs, lastSeen: now });
          this.emit('sessions-changed');
        }
        break;
      }
      case 'session/event': {
        const ev = payload.event;
        const prev = this.sessions.get(id);
        if (prev && ev?.type) {
          const running =
            ev.type === 'turn/start' || ev.type === 'step/start' || ev.type === 'tool/call'
              ? true
              : prev.running;
          this.sessions.set(id, { ...prev, running, lastSeen: now });
          if (ev.type === 'turn/start') this.emit('sessions-changed');
        }
        break;
      }
      case 'approval/requested':
        // 保留帧 rpcId —— 应答审批需要它
        this.emit('approval-requested', {
          sessionId: id,
          approvalId: payload.approvalId,
          toolName: payload.toolName,
          reason: payload.reason,
          rpcId,
        });
        break;
      case 'approval/resolved':
        this.emit('approval-resolved', { sessionId: id, approvalId: payload.approvalId, outcome: payload.outcome });
        break;
      case 'question/requested':
        this.emit('question-requested', { sessionId: id, questions: payload.questions || [] });
        break;

      // host：会话生命周期 + agent 状态
      case 'host/session-added': {
        if (!id) break;
        const prev = this.sessions.get(id) || {};
        this.sessions.set(id, {
          ...prev,
          id,
          running: false,
          blank: payload.blank,
          agentPreset: payload.agentPreset,
          origin: payload.origin,
          cwd: payload.cwd,
          lastSeen: now,
        });
        this.emit('sessions-changed');
        break;
      }
      case 'host/session-removed': {
        this.sessions.delete(id);
        this.emit('sessions-changed');
        break;
      }
      case 'host/session-status': {
        if (!id) break;
        const prev = this.sessions.get(id);
        this.sessions.set(id, { ...(prev || { id }), id, running: !!payload.running, lastSeen: now });
        if (prev?.running && !payload.running) {
          this.emit('agent-finished', { sessionId: id });
        }
        this.emit('sessions-changed');
        break;
      }
      case 'host/agent-error': {
        if (id) {
          const prev = this.sessions.get(id);
          if (prev) this.sessions.set(id, { ...prev, running: false, lastSeen: now });
        }
        this.emit('agent-error', { sessionId: id, message: payload.message });
        break;
      }
      case 'host/remote-event':
        this.emit('remote-event', { event: payload.event, args: payload.args || [] });
        break;
    }
    this.emit('frame', { stream, type: payload.type, payload });
  }

  // 通知去抖：同一 key 3 秒内只推一次
  shouldNotify(key) {
    const last = this._dedupe.get(key) || 0;
    if (Date.now() - last < 3000) return false;
    this._dedupe.set(key, Date.now());
    return true;
  }

  disconnect() {
    this._destroyed = true;
    for (const timer of this._retryTimers.values()) clearTimeout(timer);
    this._retryTimers.clear();
    for (const socket of this._sockets.values()) {
      try {
        socket.terminate();
      } catch {}
    }
    this._sockets.clear();
  }
}

module.exports = { EventBridge };
