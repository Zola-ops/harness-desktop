// NotifyManager：harness 事件 → macOS 系统通知
'use strict';

const { Notification } = require('electron');

function pickText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  for (const key of ['title', 'description', 'message', 'text', 'reason', 'prompt', 'line']) {
    const v = payload[key];
    if (typeof v === 'string' && v) return v;
  }
  if (Array.isArray(payload.questions) && payload.questions.length) {
    const q = payload.questions[0];
    if (typeof q?.question === 'string' && q.question) {
      const extra = payload.questions.length > 1 ? `（等 ${payload.questions.length} 个问题）` : '';
      return q.question.slice(0, 120) + extra;
    }
  }
  const s = JSON.stringify(payload);
  return s && s.length > 160 ? s.slice(0, 157) + '…' : s;
}

class NotifyManager {
  constructor(settings, windows) {
    this.settings = settings;
    this.windows = windows;
  }

  enabled() {
    return this.settings.get().notificationsEnabled && Notification.isSupported();
  }

  show(title, body) {
    if (!this.enabled()) return;
    const n = new Notification({ title, body: body || title, silent: false });
    n.on('click', () => this.windows.showMain());
    n.show();
  }

  // ---- 语义化事件入口（由 index.js 接线调用） ----
  onApprovalRequested({ toolName, reason, sessionId }) {
    const body = reason ? `${toolName || '工具'}：${reason}` : `工具 ${toolName || '未知'} 请求审批`;
    this.show('需要你的审批', body);
  }

  onQuestionRequested({ questions }) {
    const first = questions?.[0]?.question || '';
    const count = questions?.length || 0;
    this.show('有新的问题等待回答', count > 1 ? `${first}（等 ${count} 个问题）` : first);
  }

  onAgentError({ sessionId, message }) {
    this.show('Agent 出错', message || sessionId || '未知错误');
  }

  onAgentFinished({ sessionId, title }) {
    this.show('Agent 完成', title ? `「${title.slice(0, 60)}」的任务已结束` : `会话 ${String(sessionId).slice(0, 12)} 的任务已结束`);
  }
}

module.exports = { NotifyManager };
