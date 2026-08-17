// Harness Desktop 壳逻辑：状态渲染、webview 管理、命令面板、设置抽屉、
// 主题动效、多模态模型路由、文件拖放
'use strict';

const $ = (id) => document.getElementById(id);
const view = $('view');

let state = null;
let settings = null;
let history = [];
let cssInjected = false;
let lastUrl = '';
let pickerRole = null;

try {
  history = JSON.parse(localStorage.getItem('cmd-history') || '[]');
} catch {}

// ---------------- toast ----------------
function toast(text, kind = '') {
  const wrap = $('toast-wrap');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 320);
  }, 3600);
}

// ---------------- 状态渲染 ----------------
function renderState(next) {
  state = next;
  const status = $('tb-status');
  const svc = state?.service || {};
  const map = {
    running: `运行中 · ${svc.url || ''}`,
    starting: '服务启动中…',
    stopped: '服务已停止',
    error: `错误：${svc.errorMessage || '未知错误'}`,
  };
  status.textContent = map[svc.state] || '未知状态';
  status.dataset.state = svc.state || 'stopped';
  $('titlebar').dataset.service = svc.state || 'stopped';

  const url = svc.url || '';
  if (url !== lastUrl) {
    lastUrl = url;
    if (url) {
      view.src = url;
    } else {
      showError(svc.errorMessage || '服务未运行');
    }
  } else if (svc.state === 'running' && !cssInjected) {
    ensureCss();
  }
}

function showError(detail) {
  $('view-error').classList.remove('hidden');
  $('error-detail').textContent = detail || '';
}

function hideError() {
  $('view-error').classList.add('hidden');
}

function updateSessions(sessions) {
  const sel = $('palette-session');
  const prev = sel.value;
  const list = Array.isArray(sessions) ? sessions : [];
  sel.innerHTML = '';
  const sorted = [...list].sort((a, b) => (b.running - a.running) || ((b.lastSeen || 0) - (a.lastSeen || 0)));
  if (!sorted.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '（暂无会话，先在 harness 页面创建）';
    sel.appendChild(opt);
    return;
  }
  for (const s of sorted) {
    const opt = document.createElement('option');
    opt.value = s.id;
    const title = (s.title || s.agentPreset || '会话').slice(0, 26);
    opt.textContent = `${s.running ? '● ' : '○ '}${title} ${s.id.slice(0, 8)}`;
    sel.appendChild(opt);
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

// ---------------- webview ----------------
function ensureCss() {
  if (cssInjected || !settings?.customCss) return;
  try {
    view.insertCSS(settings.customCss);
    cssInjected = true;
  } catch {}
}

view.addEventListener('dom-ready', () => {
  hideError();
  if (settings?.customCss) {
    try {
      view.insertCSS(settings.customCss);
      cssInjected = true;
    } catch {}
  }
});

view.addEventListener('did-fail-load', (e) => {
  if (e.errorCode === -3) return; // ERR_ABORTED（重载/切换 URL 时的正常中断）
  const svc = state?.service || {};
  if (svc.state !== 'running') {
    showError(svc.errorMessage || 'Harness 服务未运行');
  } else {
    showError(`页面加载失败（${e.errorDescription || e.errorCode}）`);
  }
});

view.addEventListener('did-stop-loading', () => {
  if (state?.service?.state === 'running') hideError();
});

// ---------------- 命令面板 ----------------
function openPalette() {
  $('palette-mask').classList.remove('hidden');
  // 强制重排后加 visible 以触发过渡
  void $('palette-mask').offsetWidth;
  $('palette-mask').classList.add('visible');
  $('palette-input').value = '';
  renderHistory();
  setTimeout(() => $('palette-input').focus(), 40);
  window.desktop.listSessions().then(updateSessions).catch(() => {});
}

function closePalette() {
  $('palette-mask').classList.remove('visible');
  setTimeout(() => $('palette-mask').classList.add('hidden'), 200);
}

function renderHistory() {
  const box = $('palette-history');
  box.innerHTML = '';
  if (!history.length) {
    box.innerHTML = '<div class="history-item" style="color:var(--text-dim);cursor:default">最近执行过的命令会显示在这里 · 输入 model:vision 可切换视觉模型</div>';
    return;
  }
  for (const item of [...history].reverse().slice(0, 12)) {
    const row = document.createElement('div');
    row.className = 'history-item';
    const ok = item.error === undefined;
    row.innerHTML = `<div class="history-line"><span class="${ok ? 'ok' : 'err'}">${ok ? '✓' : '✗'}</span> <code>${escapeHtml(item.line)}</code></div>` +
      `<div class="history-text">${escapeHtml(ok ? (item.text || '执行成功') : item.error)}</div>`;
    row.addEventListener('click', () => {
      $('palette-input').value = item.line;
      $('palette-input').focus();
    });
    box.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const LOCAL_COMMANDS = {
  'model:default': { label: '切换会话模型 → 常规任务模型', run: () => applyRouting('default') },
  'model:vision': { label: '切换会话模型 → 图片理解模型', run: () => applyRouting('vision') },
  'model:image': { label: '切换会话模型 → 图片生成模型', run: () => applyRouting('image') },
  'model:video': { label: '切换会话模型 → 视频生成模型', run: () => applyRouting('video') },
};

function currentSessionId() {
  return $('palette-session').value || undefined;
}

async function applyRouting(role) {
  const res = await window.desktop.applyModelRouting({ role, sessionId: currentSessionId() });
  if (res.ok) {
    const sel = res.selected;
    toast(`已切换会话模型 → ${sel?.provider}/${sel?.model}`, 'ok');
  } else {
    toast(`切换失败：${res.error}`, 'err');
  }
}

async function runCommand() {
  const input = $('palette-input');
  const line = input.value.trim();
  if (!line) return;

  // 桌面端本地命令（model: 前缀）
  const local = LOCAL_COMMANDS[line.toLowerCase()];
  if (local) {
    history.push({ line, text: local.label, at: Date.now() });
    localStorage.setItem('cmd-history', JSON.stringify(history));
    renderHistory();
    input.value = '';
    await local.run();
    return;
  }

  const sessionId = currentSessionId();
  const res = await window.desktop.runCommand({ sessionId, line });
  if (res.ok) {
    const text = res.result?.text || '执行成功';
    history.push({ line, text, at: Date.now() });
    if (history.length > 50) history.shift();
    localStorage.setItem('cmd-history', JSON.stringify(history));
    toast(`命令已执行：${line}`, 'ok');
    renderHistory();
    input.value = '';
    setTimeout(() => { try { view.reload(); } catch {} }, 300);
  } else {
    history.push({ line, error: res.error, at: Date.now() });
    localStorage.setItem('cmd-history', JSON.stringify(history));
    toast(`命令失败：${res.error}`, 'err');
    renderHistory();
  }
}

// ---------------- 自定义 UI 应用 ----------------
function hexToRgb(hex) {
  const h = String(hex || '#000000').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0');
  return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) };
}

function applyUiCustom(u) {
  const isLight = document.documentElement.dataset.theme === 'light';
  const root = document.documentElement.style;
  // 强调色 + 圆角
  if (u.accent) root.setProperty('--accent', u.accent);
  if (u.accent2) root.setProperty('--accent-2', u.accent2);
  root.setProperty('--radius', `${u.radius ?? 10}px`);
  // 组件透明度（基于当前主题基础色计算 rgba）
  const panelBase = isLight ? '#ffffff' : '#1a1e24';
  const titlebarBase = panelBase;
  const pb = hexToRgb(panelBase), tb = hexToRgb(titlebarBase);
  const panelAlpha = u.panelOpacity ?? 0.92;
  const titlebarAlpha = u.titlebarOpacity ?? 0.94;
  root.setProperty('--bg-panel', `rgba(${pb.r},${pb.g},${pb.b},${panelAlpha})`);
  root.setProperty('--bg-elev', `rgba(${tb.r},${tb.g},${tb.b},${titlebarAlpha})`);
  // 低透明度时叠加 scrim 保障可读性（深色主题加深、浅色主题提亮）
  const scrimAlpha = panelAlpha < 0.75 || titlebarAlpha < 0.75 ? (isLight ? 0.35 : 0.3) : 0;
  const scrim = scrimAlpha
    ? (isLight ? `rgba(255,255,255,${scrimAlpha})` : `rgba(0,0,0,${scrimAlpha})`)
    : 'rgba(0,0,0,0)';
  root.setProperty('--panel-scrim', scrim);
  for (const id of ['titlebar', 'palette', 'drawer', 'skill-panel', 'board-panel']) {
    $(id).classList.toggle('low-alpha', scrimAlpha > 0);
  }
  // 背景
  root.setProperty('--bg-blur', `${u.backgroundBlur ?? 12}px`);
  root.setProperty('--bg-dim', String(u.backgroundDim ?? 0.35));
  if (u.backgroundType === 'image' && u.backgroundImage) {
    const url = 'file://' + String(u.backgroundImage).replace(/^file:\/\//, '').split('/').map(encodeURIComponent).join('/');
    root.setProperty('--bg-image', `url("${url}")`);
    document.body.dataset.bgImage = '1';
  } else {
    root.removeProperty('--bg-image');
    delete document.body.dataset.bgImage;
    root.setProperty('--bg', u.background || (isLight ? '#f2f4f7' : '#111418'));
  }
}

function fillUiCustom(u) {
  $('ui-bg-type').value = u.backgroundType || 'color';
  $('ui-bg-color').value = u.background || '#111418';
  $('ui-bg-image').value = u.backgroundImage || '';
  $('ui-bg-blur').value = u.backgroundBlur ?? 12;
  $('ui-blur-val').textContent = u.backgroundBlur ?? 12;
  $('ui-bg-dim').value = Math.round((u.backgroundDim ?? 0.35) * 100);
  $('ui-dim-val').textContent = (u.backgroundDim ?? 0.35).toFixed(2);
  $('ui-accent').value = u.accent || '#4cc2ff';
  $('ui-accent2').value = u.accent2 || '#8b5cf6';
  $('ui-radius').value = u.radius ?? 10;
  $('ui-radius-val').textContent = u.radius ?? 10;
  $('ui-titlebar-op').value = Math.round((u.titlebarOpacity ?? 0.94) * 100);
  $('ui-titlebar-val').textContent = `${Math.round((u.titlebarOpacity ?? 0.94) * 100)}%`;
  $('ui-panel-op').value = Math.round((u.panelOpacity ?? 0.92) * 100);
  $('ui-panel-val').textContent = `${Math.round((u.panelOpacity ?? 0.92) * 100)}%`;
  syncBgTypeControls(u.backgroundType || 'color');
}

function syncBgTypeControls(type) {
  $('ui-bg-color-wrap').classList.toggle('hidden', type !== 'color');
  $('ui-bg-image-wrap').classList.toggle('hidden', type !== 'image');
}

function collectUiCustom() {
  return {
    backgroundType: $('ui-bg-type').value,
    background: $('ui-bg-color').value,
    backgroundImage: $('ui-bg-image').value,
    backgroundBlur: Number($('ui-bg-blur').value),
    backgroundDim: Number($('ui-bg-dim').value) / 100,
    accent: $('ui-accent').value,
    accent2: $('ui-accent2').value,
    radius: Number($('ui-radius').value),
    titlebarOpacity: Number($('ui-titlebar-op').value) / 100,
    panelOpacity: Number($('ui-panel-op').value) / 100,
  };
}

function bindUiCustomEvents() {
  const live = () => applyUiCustom(collectUiCustom());
  $('ui-bg-type').addEventListener('change', () => {
    syncBgTypeControls($('ui-bg-type').value);
    live();
  });
  $('ui-bg-color').addEventListener('input', live);
  $('ui-bg-blur').addEventListener('input', (e) => { $('ui-blur-val').textContent = e.target.value; live(); });
  $('ui-bg-dim').addEventListener('input', (e) => { $('ui-dim-val').textContent = (Number(e.target.value) / 100).toFixed(2); live(); });
  $('ui-accent').addEventListener('input', live);
  $('ui-accent2').addEventListener('input', live);
  $('ui-radius').addEventListener('input', (e) => { $('ui-radius-val').textContent = e.target.value; live(); });
  $('ui-titlebar-op').addEventListener('input', (e) => { $('ui-titlebar-val').textContent = `${e.target.value}%`; live(); });
  $('ui-panel-op').addEventListener('input', (e) => { $('ui-panel-val').textContent = `${e.target.value}%`; live(); });
  $('btn-pick-bg').addEventListener('click', async () => {
    const res = await window.desktop.pickBackgroundImage();
    if (res.ok) {
      $('ui-bg-image').value = res.path;
      $('ui-bg-type').value = 'image';
      syncBgTypeControls('image');
      live();
    }
  });
  $('btn-ui-reset').addEventListener('click', () => {
    const d = { backgroundType: 'color', background: document.documentElement.dataset.theme === 'light' ? '#f2f4f7' : '#111418', backgroundImage: '', backgroundBlur: 12, backgroundDim: 0.35, accent: '#4cc2ff', accent2: '#8b5cf6', radius: 10, titlebarOpacity: 0.94, panelOpacity: 0.92 };
    fillUiCustom(d);
    applyUiCustom(d);
    toast('外观已重置（点击保存设置持久化）');
  });
}

// ---------------- 移动端联动 ----------------
async function refreshLanStatus() {
  const st = await window.desktop.lanStatus();
  $('lan-enabled').checked = !!st.running;
  const box = $('lan-status-box');
  if (!st.running || !st.ips?.length) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  $('lan-ips').innerHTML = st.ips.map((i) => `<span class="lan-row">📶 ${escapeHtml(i.name)}</span>`).join('');
  const url = `http://${st.ips[0].address}:${st.port}`;
  $('lan-url').textContent = url;
  const qr = await window.desktop.lanQr();
  if (qr.ok) $('lan-qr').src = qr.dataUrl;
}

// ---------------- 设置抽屉 ----------------
function openDrawer() {
  window.desktop.getSettings().then((s) => {
    settings = s;
    $('set-dsh-command').value = s.dshCommand || '';
    $('set-port').value = s.port;
    $('set-auto-start').checked = !!s.autoStartHarness;
    $('set-stop-on-quit').checked = !!s.stopHarnessOnQuit;
    $('set-close-behavior').value = s.closeBehavior || 'tray';
    $('set-shortcut-quick').value = s.shortcuts?.quickInput || '';
    $('set-shortcut-new').value = s.shortcuts?.newWindow || '';
    $('set-notifications').checked = s.notificationsEnabled !== false;
    $('set-theme-source').value = s.themeSource || 'system';
    $('set-custom-css').value = s.customCss || '';
    fillModelRouting(s.modelRouting);
    fillUiCustom(s.uiCustom || {});
    $('lan-port').value = s.lan?.port || 3180;
    $('set-summary-enabled').checked = s.summary?.enabled !== false;
    $('set-summary-model').value = s.summary?.model || 'agnes-2.5-flash';
    refreshLanStatus();
    refreshTunnel();
  });
  $('drawer-mask').classList.remove('hidden');
  void $('drawer-mask').offsetWidth;
  $('drawer-mask').classList.add('visible');
}

function closeDrawer() {
  $('drawer-mask').classList.remove('visible');
  setTimeout(() => $('drawer-mask').classList.add('hidden'), 300);
}

function fillModelRouting(routing = {}) {
  for (const role of ['default', 'vision', 'image', 'video']) {
    const r = routing[role] || {};
    const route = document.querySelector(`.model-route[data-role="${role}"]`);
    if (!route) continue;
    route.querySelector('.route-provider').value = r.provider || '';
    route.querySelector('.route-model').value = r.model || '';
  }
}

function collectModelRouting() {
  const out = {};
  for (const role of ['default', 'vision', 'image', 'video']) {
    const route = document.querySelector(`.model-route[data-role="${role}"]`);
    out[role] = {
      provider: route.querySelector('.route-provider').value.trim(),
      model: route.querySelector('.route-model').value.trim(),
    };
  }
  return out;
}

async function saveSettings() {
  const patch = {
    dshCommand: $('set-dsh-command').value.trim(),
    port: Math.max(1, Math.min(65535, Number($('set-port').value) || 3080)),
    autoStartHarness: $('set-auto-start').checked,
    stopHarnessOnQuit: $('set-stop-on-quit').checked,
    closeBehavior: $('set-close-behavior').value,
    notificationsEnabled: $('set-notifications').checked,
    themeSource: $('set-theme-source').value,
    shortcuts: {
      quickInput: $('set-shortcut-quick').value.trim(),
      newWindow: $('set-shortcut-new').value.trim(),
    },
    uiCustom: collectUiCustom(),
    lan: { ...(settings?.lan || {}), port: Math.max(1024, Math.min(65535, Number($('lan-port').value) || 3180)) },
    summary: {
      enabled: $('set-summary-enabled').checked,
      model: $('set-summary-model').value.trim() || 'agnes-2.5-flash',
    },
  };
  const routing = collectModelRouting();
  const [res, routeRes] = await Promise.all([
    window.desktop.setSettings(patch),
    window.desktop.saveModelRouting(routing),
  ]);
  if (res.ok && routeRes.ok) {
    settings = { ...res.settings, modelRouting: routeRes.modelRouting };
    applyThemeSource(res.settings.themeSource);
    applyUiCustom(res.settings.uiCustom);
    toast('设置已保存');
    closeDrawer();
  } else {
    toast('保存失败', 'err');
  }
}

// ---------------- 模型选择器 ----------------
async function openModelPicker(role) {
  pickerRole = role;
  const list = $('model-picker-list');
  list.innerHTML = '<div class="picker-empty">加载中…</div>';
  $('model-picker').classList.remove('hidden');
  const sessionId = currentSessionId();
  const res = await window.desktop.listSessionModels(sessionId);
  if (!res.ok) {
    list.innerHTML = `<div class="picker-empty">${escapeHtml(res.error || '无法读取模型目录')}</div>`;
    return;
  }
  if (!res.groups?.length) {
    list.innerHTML = '<div class="picker-empty">没有可用模型，请先在 harness 设置中配置模型提供方</div>';
    return;
  }
  list.innerHTML = '';
  for (const group of res.groups) {
    const g = document.createElement('div');
    g.className = 'picker-group-title';
    g.textContent = group.name || group.id;
    list.appendChild(g);
    for (const m of group.models || []) {
      const item = document.createElement('div');
      item.className = 'picker-item';
      item.innerHTML = `<span>${escapeHtml(m.name || m.id)}</span><span class="pick-id">${escapeHtml(m.id)}</span>`;
      item.addEventListener('click', () => {
        const route = document.querySelector(`.model-route[data-role="${pickerRole}"]`);
        if (route) {
          route.querySelector('.route-provider').value = group.id;
          route.querySelector('.route-model').value = m.id;
        }
        closeModelPicker();
        toast(`已填入 ${group.id}/${m.id}，点击「保存设置」生效`);
      });
      list.appendChild(item);
    }
  }
}

function closeModelPicker() {
  $('model-picker').classList.add('hidden');
  pickerRole = null;
}

// ---------------- 主题（带动效） ----------------
function applyThemeSource(source) {
  document.documentElement.dataset.theme = source === 'system' ? 'system' : source;
  // 主题变化影响透明度基础色，重算 UI 定制
  if (settings?.uiCustom) applyUiCustom(settings.uiCustom);
}

function playThemeRipple(x, y) {
  const ripple = $('theme-ripple');
  ripple.style.setProperty('--rx', `${x}px`);
  ripple.style.setProperty('--ry', `${y}px`);
  ripple.classList.remove('playing');
  void ripple.offsetWidth;
  ripple.classList.add('playing');
  setTimeout(() => ripple.classList.remove('playing'), 750);
}

function cycleTheme() {
  const order = ['system', 'light', 'dark'];
  const cur = settings?.themeSource || 'system';
  const next = order[(order.indexOf(cur) + 1) % order.length];
  const btn = $('btn-theme');
  const rect = btn.getBoundingClientRect();
  window.desktop.setThemeSource(next).then(() => {
    settings = { ...settings, themeSource: next };
    applyThemeSource(next);
    playThemeRipple(rect.left + rect.width / 2, rect.top + rect.height / 2);
    toast(`主题：${next === 'system' ? '跟随系统' : next === 'light' ? '浅色' : '深色'}`);
  });
}

// ---------------- 文件拖放 ----------------
let dragDepth = 0;
const stage = $('stage');
stage.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  stage.style.outline = '2px dashed var(--accent)';
  stage.style.outlineOffset = '-6px';
  stage.style.transition = 'outline-color 0.2s ease';
});
stage.addEventListener('dragover', (e) => e.preventDefault());
stage.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; stage.style.outline = ''; }
});
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  stage.style.outline = '';
  const files = [...(e.dataTransfer?.files || [])].map((f) => f.path).filter(Boolean);
  if (files.length) {
    window.desktop.notifyDroppedFiles(files);
  }
});

// ---------------- 事件订阅 ----------------
window.desktop.onState(renderState);
window.desktop.onEvent((ev) => {
  if (ev.kind === 'sessions') updateSessions(ev.sessions);
  if (ev.kind === 'quick-input') openPalette();
  if (ev.kind === 'files-dropped') toast(ev.message, 'ok');
  if (ev.kind === 'board-summary') {
    boardSummariesMap[ev.key] = ev.summary;
    const node = boardNodes.find((n) =>
      (n.type === 'session' && `session:${n.id}` === ev.key) ||
      (n.type === 'project' && `project:${n.id}` === ev.key)
    );
    if (node) {
      node.sub = String(ev.summary).slice(0, 16);
      if (boardHover === node.id) {
        const r = $('board-canvas').getBoundingClientRect();
        updateBoardTooltip(node, r.left + 120, r.top + 120);
      }
    }
  }
});
window.desktop.onCommandResult(({ result, line }) => {
  if (!result?.ok) toast(`命令失败：${result?.error || line}`, 'err');
});
window.desktop.onSettings(({ customCss, modelRouting }) => {
  settings = { ...settings, ...(customCss !== undefined ? { customCss } : {}), ...(modelRouting ? { modelRouting } : {}) };
  if (customCss !== undefined) {
    cssInjected = false;
    if (customCss && view.getURL()) {
      setTimeout(() => {
        try { view.insertCSS(customCss); cssInjected = true; } catch {}
      }, 200);
    }
  }
});

// ---------------- Skill 管理面板 ----------------
let skillListCache = [];
let editingSkillPath = null;
let editingSkillIsNew = false;

function openSkillPanel() {
  $('skill-mask').classList.remove('hidden');
  void $('skill-mask').offsetWidth;
  $('skill-mask').classList.add('visible');
  refreshSkillList();
}

function closeSkillPanel() {
  $('skill-mask').classList.remove('visible');
  setTimeout(() => $('skill-mask').classList.add('hidden'), 260);
}

async function refreshSkillList() {
  const res = await window.desktop.listSkills();
  const list = $('skill-list');
  if (!res.ok) {
    list.innerHTML = `<div class="skill-editor-empty">加载失败：${escapeHtml(res.error)}</div>`;
    return;
  }
  skillListCache = res.skills || [];
  $('skill-count').textContent = `${skillListCache.length} 个技能`;
  if (!skillListCache.length) {
    list.innerHTML = '<div class="skill-editor-empty">还没有用户 Skill，点击「新建 Skill」创建第一个</div>';
    return;
  }
  list.innerHTML = '';
  for (const s of skillListCache) {
    const item = document.createElement('div');
    item.className = 'skill-item';
    if (s.path === editingSkillPath) item.classList.add('active');
    const kb = (s.size / 1024).toFixed(1);
    item.innerHTML = `
      <div class="skill-item-name">${escapeHtml(s.name)}<span class="tag">${s.kind === 'bundle' ? '目录' : '单文件'}</span></div>
      <div class="skill-item-desc"></div>
      <div class="skill-item-meta">${kb} KB · ${new Date(s.mtime).toLocaleDateString()}</div>`;
    item.addEventListener('click', () => loadSkill(s.path));
    list.appendChild(item);
    // 异步加载描述
    window.desktop.readSkill(s.path).then((r) => {
      if (r.ok) item.querySelector('.skill-item-desc').textContent = r.description || '';
    }).catch(() => {});
  }
}

async function loadSkill(skillPath) {
  editingSkillPath = skillPath;
  editingSkillIsNew = false;
  refreshSkillListActive();
  const res = await window.desktop.readSkill(skillPath);
  const form = $('skill-form');
  const empty = $('skill-editor-empty');
  if (!res.ok) {
    empty.textContent = `读取失败：${res.error}`;
    empty.classList.remove('hidden');
    form.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  form.classList.remove('hidden');
  $('skill-name').value = res.name;
  $('skill-name').disabled = true; // 已存在 skill 不允许改文件名
  $('skill-desc').value = res.description || '';
  $('skill-when').value = res.whenToUse || '';
  $('skill-no-model').checked = !!res.disableModelInvocation;
  $('skill-not-user').checked = res.userInvocable === false;
  $('skill-body').value = res.body || '';
  $('skill-form-tip').textContent = '保存后 harness 自动发现变化，刷新会话页面即可使用';
  $('btn-skill-delete').classList.remove('hidden');
}

function refreshSkillListActive() {
  for (const item of document.querySelectorAll('.skill-item')) {
    item.classList.toggle('active', false);
  }
  const idx = skillListCache.findIndex((s) => s.path === editingSkillPath);
  if (idx >= 0) {
    const items = document.querySelectorAll('.skill-item');
    items[idx]?.classList.add('active');
  }
}

function newSkillForm() {
  editingSkillPath = null;
  editingSkillIsNew = true;
  refreshSkillListActive();
  const form = $('skill-form');
  $('skill-editor-empty').classList.add('hidden');
  form.classList.remove('hidden');
  $('skill-name').value = '';
  $('skill-name').disabled = false;
  $('skill-desc').value = '';
  $('skill-when').value = '';
  $('skill-no-model').checked = false;
  $('skill-not-user').checked = false;
  $('skill-body').value = '';
  $('skill-form-tip').textContent = '将创建到 ~/.agents/skills/<名称>/SKILL.md';
  $('btn-skill-delete').classList.add('hidden');
  $('skill-name').focus();
}

async function saveSkill() {
  const input = {
    name: $('skill-name').value.trim(),
    description: $('skill-desc').value.trim(),
    whenToUse: $('skill-when').value.trim(),
    disableModelInvocation: $('skill-no-model').checked,
    userInvocable: !$('skill-not-user').checked,
    body: $('skill-body').value,
  };
  let res;
  if (editingSkillIsNew) {
    res = await window.desktop.createSkill(input);
  } else if (editingSkillPath) {
    res = await window.desktop.updateSkill({ skillPath: editingSkillPath, ...input });
  } else {
    return;
  }
  if (res.ok) {
    toast(`Skill「${res.name}」已保存`, 'ok');
    await refreshSkillList();
  } else {
    toast(`保存失败：${res.error}`, 'err');
  }
}

async function deleteSkill() {
  if (!editingSkillPath) return;
  const name = $('skill-name').value || '此';
  if (!confirm(`确定删除 Skill「${name}」？文件将被移除，无法恢复。`)) return;
  const res = await window.desktop.deleteSkill(editingSkillPath);
  if (res.ok) {
    toast(`Skill「${name}」已删除`);
    editingSkillPath = null;
    editingSkillIsNew = false;
    $('skill-form').classList.add('hidden');
    $('skill-editor-empty').classList.remove('hidden');
    $('skill-editor-empty').textContent = '从左侧选择一个 Skill 查看详情，或点击「新建 Skill」开始编写';
    await refreshSkillList();
  } else {
    toast(`删除失败：${res.error}`, 'err');
  }
}

// ---------------- 知识看板（Obsidian 式力导向图） ----------------
let boardData = null;
let boardDim = 'project';
let boardNodes = [];
let boardLinks = [];
let boardSelected = null;
let boardSearchTerm = '';
let boardAnim = null;
let boardZoom = 1;
let boardPanX = 0;
let boardPanY = 0;
let boardDragNode = null;
let boardDragging = false;
let boardHover = null;
let producedCache = new Map();
let boardW = 0;
let boardH = 0;
let boardClusterColor = [];
let boardDateFilter = { mode: 'all', from: null, to: null };
let boardSummariesMap = {}; // session:<id> / project:<id> -> 摘要

const PALETTE = ['#4cc2ff', '#8b5cf6', '#34d399', '#fbbf24', '#f87171', '#f472b6', '#38bdf8', '#a3e635', '#fb923c', '#2dd4bf'];

function openBoard() {
  $('board-mask').classList.remove('hidden');
  void $('board-mask').offsetWidth;
  $('board-mask').classList.add('visible');
  updateBoardFilterVisibility();
  loadBoard();
}

// 日期筛选器只在「日期」维度显示
function updateBoardFilterVisibility() {
  $('board-filter').style.display = boardDim === 'date' ? '' : 'none';
}

function closeBoard() {
  $('board-mask').classList.remove('visible');
  stopBoardAnim();
  setTimeout(() => $('board-mask').classList.add('hidden'), 260);
}

async function loadBoard() {
  $('board-loading').classList.remove('hidden');
  $('board-empty').classList.add('hidden');
  const res = await window.desktop.boardSnapshot();
  $('board-loading').classList.add('hidden');
  if (!res.ok) {
    $('board-empty').classList.remove('hidden');
    $('board-empty').textContent = `加载失败：${res.error}`;
    return;
  }
  boardData = res;
  if (!res.sessions.length) {
    $('board-empty').classList.remove('hidden');
    $('board-empty').textContent = '暂无数据 —— 先在 harness 里开始一个会话';
    return;
  }
  // 拉取智能摘要（缓存优先，缺失的异步生成后广播更新）
  window.desktop.boardSummaries({ sessions: res.sessions, projects: res.projects }).then((r) => {
    if (r.ok) boardSummariesMap = { ...boardSummariesMap, ...r.summaries };
  }).catch(() => {});
  buildGraph();
  startBoardAnim();
}

// ---- 日期筛选 ----
function filterSessionsByDate(sessions) {
  const f = boardDateFilter;
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today0 = startOfDay(now);
  let from = 0, to = Infinity;
  switch (f.mode) {
    case 'today': from = today0; break;
    case 'yesterday': from = today0 - 86400000; to = today0; break;
    case '7d': from = now.getTime() - 7 * 86400000; break;
    case '30d': from = now.getTime() - 30 * 86400000; break;
    case 'month': from = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1)); break;
    case 'custom': {
      if (f.from) from = new Date(f.from + 'T00:00:00').getTime();
      if (f.to) to = new Date(f.to + 'T23:59:59').getTime();
      break;
    }
  }
  return sessions.filter((s) => s.updatedAt >= from && s.updatedAt <= to);
}

// ---- 分组与图构建 ----
function buildGraph() {
  const { sessions: allSessions, projects, links } = boardData;
  const sessions = filterSessionsByDate(allSessions);
  boardNodes = [];
  boardLinks = [];
  boardClusterColor = [];

  if (boardDim === 'project') {
    // 项目锚点：圆周排列
    const projNodes = projects.map((p, i) => ({
      id: p.id, type: 'project', label: p.title, sub: p.path || '',
      x: 0, y: 0, vx: 0, vy: 0, r: 30,
      color: PALETTE[i % PALETTE.length],
      anchor: polarAnchor(i, projects.length, 250),
      data: p,
    }));
    boardNodes.push(...projNodes);
    const byProject = new Map();
    for (const p of projects) byProject.set(p.id, { x: 0, y: 0, color: PALETTE[projNodes.findIndex((n) => n.id === p.id) % PALETTE.length] });
    const orphans = [];
    for (const s of sessions) {
      const owner = projects.find((p) => p.sessionIds.includes(s.id));
      if (owner) {
        boardNodes.push(sessionNode(s, byProject.get(owner.id).color, owner.id));
        boardLinks.push({ source: owner.id, target: s.id, kind: 'owns' });
      } else {
        orphans.push(s);
      }
    }
    // 无项目会话：中心散落
    for (const s of orphans) {
      boardNodes.push(sessionNode(s, '#9aa4b0', null));
    }
  } else if (boardDim === 'date') {
    // 按具体日期分组（8月17日 等），今天加标注
    const dayLabel = (t) => {
      const d = new Date(t);
      const label = `${d.getMonth() + 1}月${d.getDate()}日`;
      const today = new Date();
      return (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate())
        ? `今天 · ${label}` : label;
    };
    const byDay = new Map();
    for (const s of sessions) {
      const key = new Date(s.updatedAt).toDateString();
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(s);
    }
    const dayKeys = [...byDay.keys()].sort();
    const spacing = dayKeys.length > 1 ? Math.min(210, 480 / (dayKeys.length - 1)) : 0;
    dayKeys.forEach((key, i) => {
      const x = dayKeys.length === 1 ? 0 : -240 + i * spacing;
      const label = dayLabel(byDay.get(key)[0].updatedAt);
      const color = PALETTE[i % PALETTE.length];
      const gid = `date:${key}`;
      boardNodes.push({
        id: gid, type: 'group', label, sub: `${byDay.get(key).length} 个会话`,
        x, y: 0, vx: 0, vy: 0, r: 22, color,
        anchor: { x, y: 0 }, data: { label, count: byDay.get(key).length },
      });
      for (const s of byDay.get(key)) {
        boardNodes.push(sessionNode(s, color, gid));
        boardLinks.push({ source: gid, target: s.id, kind: 'owns' });
      }
    });
    boardClusterColor = dayKeys.map((k) => PALETTE[dayKeys.indexOf(k) % PALETTE.length]);
  } else {
    // theme：按 goal/title 分组
    const groups = [];
    const groupOf = new Map();
    for (const s of sessions) {
      const key = (s.goal || s.title || '未分类').slice(0, 14);
      if (!groupOf.has(key)) {
        groupOf.set(key, groups.length);
        groups.push(key);
      }
    }
    groups.forEach((g, i) => {
      boardNodes.push({
        id: `th:${i}`, type: 'group', label: g, sub: '',
        x: 0, y: 0, vx: 0, vy: 0, r: 22,
        color: PALETTE[i % PALETTE.length],
        anchor: polarAnchor(i, groups.length, 250),
        data: { label: g },
      });
    });
    boardClusterColor = groups.map((_, i) => PALETTE[i % PALETTE.length]);
    for (const s of sessions) {
      const key = (s.goal || s.title || '未分类').slice(0, 14);
      const gi = groupOf.get(key);
      boardNodes.push(sessionNode(s, PALETTE[gi % PALETTE.length], `th:${gi}`));
      boardLinks.push({ source: `th:${gi}`, target: s.id, kind: 'owns' });
    }
  }

  // subagent 边
  for (const l of links) {
    if (l.kind === 'subagent' && boardNodes.some((n) => n.id === l.source) && boardNodes.some((n) => n.id === l.target)) {
      boardLinks.push({ source: l.source, target: l.target, kind: 'subagent' });
    }
  }

  // 搜索过滤
  if (boardSearchTerm) {
    const q = boardSearchTerm.toLowerCase();
    const keep = new Set();
    for (const n of boardNodes) {
      if ((n.label || '').toLowerCase().includes(q) || (n.sub || '').toLowerCase().includes(q) || String(n.id).toLowerCase().includes(q)) keep.add(n.id);
    }
    boardNodes = boardNodes.filter((n) => keep.has(n.id) || n.type === 'group' || n.type === 'project');
    boardLinks = boardLinks.filter((l) => boardNodes.some((n) => n.id === l.source) && boardNodes.some((n) => n.id === l.target));
    // 搜索命中会话时显示其产出物
    for (const n of boardNodes) {
      if (n.type === 'session' && keep.has(n.id)) attachProduced(n, true);
    }
  }

  initPhysics();
  renderLegend();

  // 筛选/搜索后无会话：显示空提示
  const empty = $('board-empty');
  const hasSession = boardNodes.some((n) => n.type === 'session');
  if (!hasSession && boardData.sessions.length) {
    empty.classList.remove('hidden');
    empty.textContent = '当前筛选条件下没有匹配的会话 —— 调整日期筛选或清除搜索';
  } else {
    empty.classList.add('hidden');
  }
}

function sessionNode(s, color, clusterId) {
  // 副标签摘要：模型摘要优先，其次目标 / Agent 预设
  const sub = (boardSummariesMap[`session:${s.id}`] || s.goal || s.agentPreset || s.title || '').slice(0, 16);
  return {
    id: s.id, type: 'session', label: s.title || s.agentPreset || s.id.slice(0, 12),
    sub, x: 0, y: 0, vx: 0, vy: 0, r: 12, color,
    cluster: clusterId, running: s.running, data: s,
  };
}

function polarAnchor(i, total, radius) {
  const a = (i / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2;
  return { x: Math.cos(a) * radius, y: Math.sin(a) * radius };
}

// ---- 力导向模拟 ----
function initPhysics() {
  const anchors = [];
  for (const n of boardNodes) {
    if (n.anchor) anchors.push(n.anchor);
    else if (n.type === 'project' || n.type === 'group') {
      n.anchor = { x: n.x, y: n.y };
      anchors.push(n.anchor);
    }
  }
  // 初始位置：锚点附近随机（非锚点节点）
  for (const n of boardNodes) {
    if (n.anchor) {
      n.x = n.anchor.x;
      n.y = n.anchor.y;
      continue;
    }
    const anchor = n.cluster ? boardNodes.find((b) => b.id === n.cluster) : null;
    const ax = anchor?.anchor?.x ?? (Math.random() - 0.5) * 120;
    const ay = anchor?.anchor?.y ?? (Math.random() - 0.5) * 120;
    n.x = ax + (Math.random() - 0.5) * 90;
    n.y = ay + (Math.random() - 0.5) * 90;
    n.vx = 0;
    n.vy = 0;
  }
  boardIterations = 0;
}

let boardIterations = 0;

function stepSimulation() {
  const N = boardNodes;
  const repulse = 9000;
  const springK = 0.02;
  const damping = 0.85;
  // 斥力
  for (let i = 0; i < N.length; i++) {
    for (let j = i + 1; j < N.length; j++) {
      const a = N[i], b = N[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) { dx = (Math.random() - 0.5); dy = (Math.random() - 0.5); d2 = 1; }
      const d = Math.sqrt(d2);
      const f = repulse / d2;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      const wa = a.type === 'produced' ? 0.4 : 1;
      const wb = b.type === 'produced' ? 0.4 : 1;
      if (!a.anchor) { a.vx += fx * wa; a.vy += fy * wa; }
      if (!b.anchor) { b.vx -= fx * wb; b.vy -= fy * wb; }
    }
  }
  // 弹簧：集群锚点
  for (const n of N) {
    if (n.anchor) continue;
    const anchor = n.cluster ? N.find((b) => b.id === n.cluster)?.anchor : null;
    if (anchor) {
      n.vx += (anchor.x - n.x) * springK;
      n.vy += (anchor.y - n.y) * springK;
    }
  }
  // 弹簧：项目→会话 链接 + subagent + produced
  for (const l of boardLinks) {
    const a = N.find((n) => n.id === l.source);
    const b = N.find((n) => n.id === l.target);
    if (!a || !b) continue;
    if (l.kind === 'owns') {
      if (!b.anchor) {
        const t = l.source.startsWith('date:') || l.source.startsWith('th:') ? 0.012 : 0.03;
        b.vx += (a.x - b.x) * t;
        b.vy += (a.y - b.y) * t;
      }
    } else if (l.kind === 'subagent') {
      if (!b.anchor) { b.vx += (a.x - b.x) * 0.02; b.vy += (a.y - b.y) * 0.02; }
    } else if (l.kind === 'produced') {
      if (!b.anchor) { b.vx += (a.x - b.x) * 0.045; b.vy += (a.y - b.y) * 0.045; }
    }
  }
  // 积分 + 阻尼
  for (const n of N) {
    if (n.anchor || n === boardDragNode) continue;
    n.vx *= damping;
    n.vy *= damping;
    n.x += n.vx;
    n.y += n.vy;
  }
  boardIterations++;
}

function startBoardAnim() {
  stopBoardAnim();
  const tick = () => {
    for (let i = 0; i < 3 && boardIterations < 500; i++) stepSimulation();
    drawBoard();
    boardAnim = requestAnimationFrame(tick);
  };
  boardAnim = requestAnimationFrame(tick);
}

function stopBoardAnim() {
  if (boardAnim) cancelAnimationFrame(boardAnim);
  boardAnim = null;
}

// ---- 绘制 ----
function drawBoard() {
  const canvas = $('board-canvas');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (rect.width !== boardW || rect.height !== boardH) {
    boardW = rect.width;
    boardH = rect.height;
    canvas.width = boardW * dpr;
    canvas.height = boardH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  ctx.clearRect(0, 0, boardW, boardH);
  // 看板画布：白底黑字
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, boardW, boardH);
  const cx = boardW / 2 + boardPanX;
  const cy = boardH / 2 + boardPanY;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(boardZoom, boardZoom);

  // 边
  for (const l of boardLinks) {
    const a = boardNodes.find((n) => n.id === l.source);
    const b = boardNodes.find((n) => n.id === l.target);
    if (!a || !b) continue;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    if (l.kind === 'subagent') {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(139, 92, 246, 0.55)';
    } else if (l.kind === 'produced') {
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(244, 114, 182, 0.45)';
    } else {
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.16)';
    }
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 节点
  const labelColor = '#1f2937';
  const labelShadow = 'rgba(255,255,255,0.95)';
  for (const n of boardNodes) {
    const selected = boardSelected === n.id;
    const hovered = boardHover === n.id;
    if (n.type === 'project' || n.type === 'group') {
      // 母节点：大实心圆 + 内点 + 外圈
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r + (hovered ? 3 : 0), 0, Math.PI * 2);
      ctx.fillStyle = n.color;
      ctx.fill();
      ctx.strokeStyle = selected ? '#111827' : 'rgba(0,0,0,0.35)';
      ctx.lineWidth = selected ? 3 : 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.type === 'project' ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fill();
    } else if (n.type === 'produced') {
      ctx.fillStyle = n.color || '#f472b6';
      ctx.fillRect(n.x - 5, n.y - 5, 10, 10);
      if (selected) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.strokeRect(n.x - 8, n.y - 8, 16, 16);
      }
    } else {
      // 子节点（会话）：实心圆，运行中带光环
      if (n.running) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 6, 0, Math.PI * 2);
        ctx.fillStyle = n.color + '40';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r + (hovered ? 2 : 0), 0, Math.PI * 2);
      ctx.fillStyle = n.color;
      ctx.fill();
      ctx.strokeStyle = selected ? '#111827' : 'rgba(0,0,0,0.35)';
      ctx.lineWidth = selected ? 2.5 : 1.2;
      ctx.stroke();
    }
  }

  // 标签（加深 + 阴影提升可读性）
  ctx.font = '600 11.5px -apple-system, "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.shadowColor = labelShadow;
  ctx.shadowBlur = 4;
  for (const n of boardNodes) {
    const label = String(n.label || '').slice(0, 16);
    if (!label) continue;
    ctx.fillStyle = labelColor;
    ctx.fillText(label, n.x, n.y + n.r + 14);
  }
  // 副标签摘要（第二行小字）
  ctx.font = '10.5px -apple-system, "PingFang SC", sans-serif';
  for (const n of boardNodes) {
    const sub = String(n.sub || '');
    if (!sub) continue;
    const short = sub.length > 12 ? sub.slice(0, 11) + '…' : sub;
    ctx.fillStyle = labelColor;
    ctx.globalAlpha = 0.75;
    ctx.fillText(short, n.x, n.y + n.r + 27);
    ctx.globalAlpha = 1;
  }
  ctx.shadowBlur = 0;
  ctx.restore();

  // 搜索态提示
  if (boardSearchTerm) {
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    const w = ctx.measureText(boardSearchTerm).width + 24;
    // 简单提示条
  }
}

// ---- 节点摘要 tooltip ----
function tooltipFor(node) {
  const esc = escapeHtml;
  if (!node) return '';
  const date = new Date(node.data?.updatedAt || Date.now()).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  if (node.type === 'project') {
    const p = node.data || {};
    const summary = boardSummariesMap[`project:${node.id}`];
    return `<div class="tt-title">${esc(node.label)}<span class="tt-kind">${p.virtual ? '目录' : '项目'}</span></div>
      ${summary ? `<div class="tt-goal">💡 ${esc(summary)}</div>` : ''}
      <div class="tt-line"><b>路径：</b>${esc(p.path || '—')}</div>
      <div class="tt-line"><b>会话：</b>${(p.sessionIds || []).length} 个</div>
      ${p.createdAt ? `<div class="tt-line"><b>创建：</b>${esc(String(p.createdAt).slice(0, 10))}</div>` : ''}`;
  }
  if (node.type === 'group') {
    return `<div class="tt-title">${esc(node.label)}<span class="tt-kind">分组</span></div>
      <div class="tt-line">${node.sub || ''}</div>`;
  }
  if (node.type === 'session') {
    const s = node.data || {};
    const summary = boardSummariesMap[`session:${node.id}`];
    return `<div class="tt-title">${esc(node.label || '会话')}<span class="tt-kind">会话</span></div>
      ${s.running ? '<div class="tt-status running">● 运行中</div>' : '<div class="tt-status idle">○ 空闲</div>'}
      ${summary ? `<div class="tt-goal">💡 ${esc(summary)}</div>` : s.goal ? `<div class="tt-goal">🎯 ${esc(String(s.goal).slice(0, 60))}</div>` : ''}
      <div class="tt-line"><b>预设：</b>${esc(s.agentPreset || '—')} · <b>更新：</b>${date}</div>
      <div class="tt-line"><b>目录：</b>${esc(s.cwd || '—')}</div>`;
  }
  if (node.type === 'produced') {
    return `<div class="tt-title">${esc(node.label)}<span class="tt-kind">产出物</span></div>
      <div class="tt-line"><b>路径：</b>${esc(node.data?.path || '')}</div>
      <div class="tt-line">点击查看或打开文件</div>`;
  }
  return '';
}

function updateBoardTooltip(node, clientX, clientY) {
  const tip = $('board-tooltip');
  if (!node) {
    tip.classList.add('hidden');
    return;
  }
  const wrap = $('board-canvas-wrap').getBoundingClientRect();
  tip.innerHTML = tooltipFor(node);
  tip.classList.remove('hidden');
  tip.style.left = '';
  tip.style.top = '';
  // 位置：跟随鼠标，避免出界
  const rect = tip.getBoundingClientRect();
  let left = clientX - wrap.left + 16;
  let top = clientY - wrap.top + 16;
  if (left + rect.width > wrap.width - 8) left = clientX - wrap.left - rect.width - 12;
  if (top + rect.height > wrap.height - 8) top = clientY - wrap.top - rect.height - 12;
  tip.style.left = `${Math.max(4, left)}px`;
  tip.style.top = `${Math.max(4, top)}px`;
}

// ---- 交互 ----
function setupBoardInteractions() {
  const canvas = $('board-canvas');
  let downX = 0, downY = 0, moved = false, panning = false;

  canvas.addEventListener('mousedown', (e) => {
    const { x, y } = toWorld(e);
    const node = nodeAt(x, y);
    downX = e.clientX; downY = e.clientY; moved = false;
    if (node && !node.anchor) {
      boardDragNode = node;
      panning = false;
    } else {
      panning = true;
    }
  });

  window.addEventListener('mousemove', (e) => {
    const dx = e.clientX - downX, dy = e.clientY - downY;
    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    if (boardDragNode) {
      const w = toWorld(e.clientX, e.clientY);
      boardDragNode.x = w.x;
      boardDragNode.y = w.y;
    } else if (panning && moved) {
      boardPanX += dx;
      boardPanY += dy;
      downX = e.clientX; downY = e.clientY;
    } else if (!panning) {
      const w = toWorld(e.clientX, e.clientY);
      const node = nodeAt(w.x, w.y);
      boardHover = node?.id ?? null;
      updateBoardTooltip(node, e.clientX, e.clientY);
    }
  });

  canvas.addEventListener('mouseleave', () => {
    boardHover = null;
    updateBoardTooltip(null);
  });

  window.addEventListener('mouseup', (e) => {
    if (boardDragNode) boardDragNode = null;
    panning = false;
    if (!moved) {
      const w = toWorld(e.clientX, e.clientY);
      const node = nodeAt(w.x, w.y);
      selectBoardNode(node?.id ?? null);
    }
    moved = false;
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const before = toWorld(e.clientX, e.clientY);
    boardZoom = Math.min(2.5, Math.max(0.35, boardZoom * factor));
    const after = toWorld(e.clientX, e.clientY);
    boardPanX += (after.x - before.x) * boardZoom;
    boardPanY += (after.y - before.y) * boardZoom;
  }, { passive: false });

  canvas.addEventListener('dblclick', (e) => {
    const w = toWorld(e.clientX, e.clientY);
    const node = nodeAt(w.x, w.y);
    if (node) {
      // 聚焦：把节点移到中心
      const cx = boardW / 2 + boardPanX, cy = boardH / 2 + boardPanY;
      boardPanX += node.x - cx;
      boardPanY += node.y - cy;
    }
  });

  function toWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - boardW / 2 - boardPanX) / boardZoom,
      y: (clientY - rect.top - boardH / 2 - boardPanY) / boardZoom,
    };
  }

  function nodeAt(wx, wy) {
    let best = null, bestD = Infinity;
    for (const n of boardNodes) {
      const hit = n.type === 'produced' ? 8 : n.r + 8;
      const d = Math.hypot(n.x - wx, n.y - wy);
      if (d < hit && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }
}

// ---- 选中与详情 ----
async function selectBoardNode(id) {
  boardSelected = id;
  const node = boardNodes.find((n) => n.id === id) || null;
  const detail = $('board-detail');
  if (!node) {
    detail.innerHTML = '<div class="board-detail-empty">点击画布中的节点查看详情</div>';
    return;
  }
  if (node.type === 'session') {
    await renderSessionDetail(node);
    // 挂载产出物节点
    await attachProduced(node, false);
  } else if (node.type === 'project') {
    renderProjectDetail(node);
  } else if (node.type === 'group') {
    detail.innerHTML = `<div class="detail-card"><h4>${escapeHtml(node.label)}</h4><div class="detail-row">分组 · ${boardNodes.filter((n) => n.cluster === node.id).length} 个会话</div></div>`;
  } else if (node.type === 'produced') {
    renderProducedDetail(node);
  }
}

async function attachProduced(node, silent) {
  if (node.type !== 'session' || !node.id) return;
  let produced = producedCache.get(node.id);
  if (!produced) {
    const res = await window.desktop.boardSessionDetail(node.id);
    if (res.ok) {
      produced = res.produced || [];
      producedCache.set(node.id, produced);
    }
  }
  const existing = boardNodes.filter((n) => n.type === 'produced' && n.cluster === node.id);
  if (existing.length && !silent) return; // 已挂载
  for (const e of existing) {
    boardNodes = boardNodes.filter((n) => n.id !== e.id);
    boardLinks = boardLinks.filter((l) => l.target !== e.id);
  }
  if (produced && produced.length) {
    for (const p of produced.slice(0, 12)) {
      const pid = `prod:${node.id}:${p.path}`;
      boardNodes.push({
        id: pid, type: 'produced', label: p.name, sub: p.path,
        x: node.x + (Math.random() - 0.5) * 40, y: node.y + (Math.random() - 0.5) * 40,
        vx: 0, vy: 0, r: 5, color: '#f472b6', cluster: node.id, data: p,
      });
      boardLinks.push({ source: node.id, target: pid, kind: 'produced' });
    }
    boardIterations = Math.max(boardIterations - 60, 0); // 重新驰豫
  }
  // 选中会话时也更新详情里的产出物列表
  if (!silent && boardSelected === node.id) {
    const list = $('board-produced-list');
    if (list) renderProducedList(list, produced || []);
  }
}

async function renderSessionDetail(node) {
  const s = node.data;
  const res = await window.desktop.boardSessionDetail(node.id);
  const produced = res.ok ? res.produced : [];
  const firstPrompt = res.ok ? res.firstPrompt : null;
  const detail = $('board-detail');
  const date = new Date(s.updatedAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const stats = s.stats || {};
  detail.innerHTML = `
    <div class="detail-card">
      <h4>${escapeHtml(s.title || node.label)}<span class="detail-kind">会话</span></h4>
      ${s.running ? '<span class="detail-status running">● 运行中</span>' : '<span class="detail-status idle">○ 空闲</span>'}
      ${s.goal ? `<div class="detail-goal">🎯 ${escapeHtml(s.goal)}</div>` : ''}
      <div class="detail-row">Agent 预设：<b>${escapeHtml(s.agentPreset || '—')}</b></div>
      <div class="detail-row">工作目录：<b>${escapeHtml(s.cwd || '—')}</b></div>
      <div class="detail-row">更新时间：<b>${date}</b></div>
      ${s.parentSessionId ? `<div class="detail-row">父会话：<b>${escapeHtml(s.parentSessionId.slice(0, 20))}…</b></div>` : ''}
      ${stats.turns !== undefined ? `<div class="detail-row">规模：<b>${stats.turns} turns · ${stats.steps ?? 0} steps</b></div>` : ''}
      ${stats.decodeTokens ? `<div class="detail-row">Token：<b>${(stats.decodeTokens / 1000).toFixed(1)}k 输出</b></div>` : ''}
      ${firstPrompt ? `<div class="detail-section"><h5>首条消息</h5><div class="detail-goal" style="color:var(--text-dim)">${escapeHtml(firstPrompt)}</div></div>` : ''}
      <div class="detail-section"><h5>产出物（${produced.length}）</h5><div id="board-produced-list"></div></div>
      <div class="detail-actions">
        <button class="btn link mini-btn" id="btn-copy-sid">复制会话 ID</button>
      </div>
    </div>`;
  renderProducedList($('board-produced-list'), produced);
  $('btn-copy-sid').addEventListener('click', () => {
    navigator.clipboard.writeText(node.id);
    toast('会话 ID 已复制');
  });
}

function renderProducedList(listEl, produced) {
  if (!produced.length) {
    listEl.innerHTML = '<div class="detail-row">该会话暂无识别到产出文件</div>';
    return;
  }
  listEl.innerHTML = '';
  for (const p of produced) {
    const item = document.createElement('div');
    item.className = 'produced-item';
    item.innerHTML = `
      <div style="min-width:0;flex:1">
        <div class="p-name">${escapeHtml(p.name)}</div>
        <div class="p-path" title="${escapeHtml(p.path)}">${escapeHtml(p.path)}</div>
      </div>
      <div class="p-actions">
        <button class="mini-btn" data-act="open" title="打开">↗</button>
        <button class="mini-btn" data-act="reveal" title="在 Finder 中显示">⌘</button>
      </div>`;
    item.querySelector('[data-act=open]').addEventListener('click', () => window.desktop.boardOpenPath({ path: p.path }));
    item.querySelector('[data-act=reveal]').addEventListener('click', () => window.desktop.boardOpenPath({ path: p.path, reveal: true }));
    listEl.appendChild(item);
  }
}

function renderProjectDetail(node) {
  const p = node.data;
  const sessions = boardNodes.filter((n) => n.type === 'session' && n.cluster === node.id);
  const detail = $('board-detail');
  detail.innerHTML = `
    <div class="detail-card">
      <h4>${escapeHtml(p.title)}<span class="detail-kind">${p.virtual ? '目录' : '项目'}</span></h4>
      <div class="detail-row">路径：<b>${escapeHtml(p.path || '—')}</b></div>
      <div class="detail-row">会话数：<b>${sessions.length}</b></div>
      ${p.createdAt ? `<div class="detail-row">创建：<b>${escapeHtml(String(p.createdAt).slice(0, 10))}</b></div>` : ''}
      <div class="detail-section"><h5>会话列表</h5>
        ${sessions.map((s) => `<div class="produced-item" style="cursor:pointer" data-sid="${s.id}"><span class="p-name">${escapeHtml(s.label)}</span><span class="p-path">${s.running ? '●' : ''}</span></div>`).join('')}
      </div>
    </div>`;
  detail.querySelectorAll('[data-sid]').forEach((el) => {
    el.addEventListener('click', () => {
      const n = boardNodes.find((x) => x.id === el.dataset.sid);
      if (n) selectBoardNode(n.id);
    });
  });
}

function renderProducedDetail(node) {
  const p = node.data;
  const detail = $('board-detail');
  detail.innerHTML = `
    <div class="detail-card">
      <h4>${escapeHtml(p.name)}<span class="detail-kind">产出物</span></h4>
      <div class="detail-row">路径：<b style="word-break:break-all">${escapeHtml(p.path)}</b></div>
      <div class="detail-actions">
        <button class="btn primary mini-btn" id="btn-po-open">打开文件</button>
        <button class="btn mini-btn" id="btn-po-reveal">在 Finder 中显示</button>
      </div>
    </div>`;
  $('btn-po-open').addEventListener('click', () => window.desktop.boardOpenPath({ path: p.path }));
  $('btn-po-reveal').addEventListener('click', () => window.desktop.boardOpenPath({ path: p.path, reveal: true }));
}

function renderLegend() {
  const legend = $('board-legend');
  let items = [];
  if (boardDim === 'project') {
    const projs = boardNodes.filter((n) => n.type === 'project');
    items = projs.map((n) => `<span class="legend-item"><span class="legend-dot" style="background:${n.color}"></span>${escapeHtml(n.label)}</span>`);
  } else if (boardDim === 'date') {
    const groups = boardNodes.filter((n) => n.type === 'group');
    items = groups.map((n) => `<span class="legend-item"><span class="legend-dot" style="background:${n.color}"></span>${escapeHtml(n.label)}</span>`);
  } else {
    const groups = boardNodes.filter((n) => n.type === 'group');
    items = groups.slice(0, 6).map((n) => `<span class="legend-item"><span class="legend-dot" style="background:${n.color}"></span>${escapeHtml(n.label)}</span>`);
  }
  items.push('<span class="legend-item"><span class="legend-dot sq" style="background:#f472b6"></span>产出物</span>');
  legend.innerHTML = items.join('');
}

// ---------------- 首次启动向导 ----------------
let obPage = 1;
let obDshFound = false;

function obShowPage(n) {
  obPage = n;
  for (let i = 1; i <= 3; i++) {
    $(`ob-page-${i}`).classList.toggle('hidden', i !== n);
  }
  const steps = [1, 2, 3].map((i) =>
    `<span class="ob-step ${i === n ? 'active' : ''} ${i < n ? 'done' : ''}">${i}</span>`
  ).join('');
  $('ob-steps').innerHTML = steps;
}

async function initOnboarding() {
  const st = await window.desktop.setupStatus();
  if (st.ok && st.onboardingDone) {
    $('onboarding').classList.add('hidden');
    return;
  }
  // 展示向导
  $('onboarding').classList.remove('hidden');
  $('ob-model').value = 'deepseek-v4-flash';
  await obRefreshDetect();
  obShowPage(1);
  // 预填已有 key（若已配置过）
  if (st.hasDeepseekKey) $('ob-ds-key').placeholder = '已配置（留空保持原样）';
  if (st.hasAgnesKey) $('ob-ag-key').placeholder = '已配置（留空保持原样）';
}

async function obRefreshDetect() {
  const box = $('ob-detect');
  box.innerHTML = '检测中…';
  const r = await window.desktop.setupDetectDsh();
  obDshFound = r.ok && r.found;
  if (obDshFound) {
    box.innerHTML = `<div class="ok">✓ 已找到 dsh：</div><code>${escapeHtml(r.command)}</code>`;
  } else {
    box.innerHTML = `
      <div class="no">✗ 未检测到 dsh 命令行</div>
      <div class="ob-install">请在终端安装后点击「重新检测」：<br>
        <code>npm install -g @deepseek-ai/dsh</code><br>
        （或使用 npx：<code>npx -y @deepseek-ai/dsh web</code>）</div>`;
  }
}

async function obFinish() {
  const btn = $('ob-finish');
  btn.disabled = true;
  btn.textContent = '保存配置并启动…';
  const res = await window.desktop.setupSaveKeys({
    deepseekKey: $('ob-ds-key').value.trim(),
    agnesKey: $('ob-ag-key').value.trim(),
    provider: $('ob-provider').value,
    model: $('ob-model').value.trim(),
  });
  await window.desktop.setupFinish();
  $('onboarding').classList.add('hidden');
  // 若未填任何 key，提示
  if (!$('ob-ds-key').value.trim() && !$('ob-ag-key').value.trim()) {
    toast('未配置 API Key —— 可在设置 → Harness 服务中随时补充', 'err');
  } else if (res.ok) {
    toast('配置已保存，服务启动中…', 'ok');
  }
  // 触发服务启动（向导期间服务可能未启动）
  if (window.desktop.startHarness) {
    const st = await window.desktop.getState();
    if (!['running', 'starting'].includes(st?.service?.state)) {
      window.desktop.startHarness();
    }
  }
}

// ---------------- 按钮 ----------------
$('btn-command').addEventListener('click', openPalette);
$('btn-board').addEventListener('click', openBoard);
$('btn-board-close').addEventListener('click', closeBoard);
$('btn-board-refresh').addEventListener('click', () => {
  producedCache.clear();
  loadBoard();
});
$('board-search').addEventListener('input', (e) => {
  boardSearchTerm = e.target.value.trim();
  if (boardData) buildGraph();
});
document.querySelectorAll('.dim-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    boardDim = btn.dataset.dim;
    document.querySelectorAll('.dim-btn').forEach((b) => b.classList.toggle('active', b === btn));
    updateBoardFilterVisibility();
    if (boardData) buildGraph();
  });
});

// 日期筛选
function applyDateFilter(mode) {
  boardDateFilter.mode = mode;
  document.querySelectorAll('.f-btn').forEach((b) => b.classList.toggle('active', b.dataset.f === mode));
  const customWrap = $('f-custom-wrap');
  if (mode === 'custom') {
    customWrap.classList.remove('hidden');
    if (!boardDateFilter.from) {
      const d = new Date();
      boardDateFilter.from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      boardDateFilter.to = boardDateFilter.from;
    }
    $('f-from').value = boardDateFilter.from;
    $('f-to').value = boardDateFilter.to;
  } else {
    customWrap.classList.add('hidden');
  }
  if (boardData) buildGraph();
}
document.querySelectorAll('.f-btn').forEach((btn) => {
  btn.addEventListener('click', () => applyDateFilter(btn.dataset.f));
});
$('f-from').addEventListener('change', (e) => {
  boardDateFilter.from = e.target.value;
  if (boardData) buildGraph();
});
$('f-to').addEventListener('change', (e) => {
  boardDateFilter.to = e.target.value;
  if (boardData) buildGraph();
});
$('board-mask').addEventListener('click', (e) => {
  if (e.target === $('board-mask')) closeBoard();
});

// 首次启动向导按钮
$('ob-detect-again').addEventListener('click', obRefreshDetect);
$('ob-next-1').addEventListener('click', () => obShowPage(2));
$('ob-prev-2').addEventListener('click', () => obShowPage(1));
$('ob-next-2').addEventListener('click', () => obShowPage(3));
$('ob-prev-3').addEventListener('click', () => obShowPage(2));
$('ob-finish').addEventListener('click', obFinish);
$('ob-skip').addEventListener('click', async () => {
  await window.desktop.setupFinish();
  $('onboarding').classList.add('hidden');
  toast('已跳过向导 —— 可在设置中配置 API Key');
});
$('btn-skill').addEventListener('click', openSkillPanel);
$('btn-skill-close').addEventListener('click', closeSkillPanel);
$('btn-skill-new').addEventListener('click', newSkillForm);
$('btn-skill-save').addEventListener('click', saveSkill);
$('btn-skill-delete').addEventListener('click', deleteSkill);
$('skill-mask').addEventListener('click', (e) => {
  if (e.target === $('skill-mask')) closeSkillPanel();
});
$('btn-new-window').addEventListener('click', () => window.desktop.openNewWindow());
$('btn-theme').addEventListener('click', cycleTheme);
$('btn-browser').addEventListener('click', () => {
  window.desktop.openInBrowser().then((r) => {
    if (!r?.ok) toast('服务未运行，无法在浏览器打开', 'err');
  });
});
$('btn-settings').addEventListener('click', openDrawer);
$('btn-drawer-close').addEventListener('click', closeDrawer);
$('btn-settings-save').addEventListener('click', saveSettings);
$('btn-settings-reload').addEventListener('click', () => {
  try { view.reload(); } catch {}
  toast('正在重新加载 harness 页面');
});
$('btn-retry').addEventListener('click', () => {
  if (state?.service?.url) { try { view.reload(); } catch {} } else { window.desktop.startHarness(); }
});
$('btn-start-harness').addEventListener('click', () => window.desktop.startHarness());
$('palette-mask').addEventListener('click', (e) => {
  if (e.target === $('palette-mask')) closePalette();
});
$('drawer-mask').addEventListener('click', (e) => {
  if (e.target === $('drawer-mask')) closeDrawer();
});
$('btn-picker-close').addEventListener('click', closeModelPicker);

// 移动端联动
$('lan-enabled').addEventListener('change', async (e) => {
  if (e.target.checked) {
    const res = await window.desktop.lanStart();
    if (!res.ok) {
      e.target.checked = false;
      toast(`局域网代理启动失败：${res.error}`, 'err');
    }
  } else {
    await window.desktop.lanStop();
  }
  await refreshLanStatus();
  if (e.target.checked) toast('已开启局域网访问，用手机扫码或输入地址即可');
});
$('lan-port').addEventListener('change', async () => {
  const port = Math.max(1024, Math.min(65535, Number($('lan-port').value) || 3180));
  $('lan-port').value = port;
  // 若正在运行，用新端口重启
  const st = await window.desktop.lanStatus();
  if (st.running) {
    await window.desktop.lanStop();
    await window.desktop.lanStart();
    await refreshLanStatus();
  }
});
$('btn-lan-copy').addEventListener('click', async () => {
  const st = await window.desktop.lanStatus();
  if (st.ips?.length) {
    navigator.clipboard.writeText(`http://${st.ips[0].address}:${st.port}`);
    toast('地址已复制');
  }
});

// 公网隧道
async function refreshTunnel() {
  const st = await window.desktop.tunnelStatus();
  const labels = { stopped: '未启动', starting: '建立中…', running: '运行中', error: '错误' };
  $('tunnel-state').textContent = labels[st.state] || st.state;
  $('tunnel-state').style.color = st.state === 'running' ? 'var(--ok)' : st.state === 'error' ? 'var(--err)' : '';
  const hasUrl = !!st.url;
  $('tunnel-url-row').classList.toggle('hidden', !hasUrl);
  $('tunnel-url').textContent = st.url || '';
  $('tunnel-qr').classList.toggle('hidden', !hasUrl);
  $('btn-tunnel-start').classList.toggle('hidden', st.state === 'running' || st.state === 'starting');
  $('btn-tunnel-stop').classList.toggle('hidden', st.state !== 'running' && st.state !== 'starting');
  $('btn-tunnel-copy').classList.toggle('hidden', !hasUrl);
  if (hasUrl) {
    const qr = await window.desktop.tunnelQr();
    if (qr.ok) $('tunnel-qr').src = qr.dataUrl;
  }
}
$('btn-tunnel-start').addEventListener('click', async () => {
  $('tunnel-state').textContent = '下载/启动中…';
  const res = await window.desktop.tunnelStart();
  if (!res.ok) {
    toast(`隧道启动失败：${res.error}`, 'err');
    await refreshTunnel();
    return;
  }
  // 轮询等待地址分配（最长 ~30 秒）
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    await refreshTunnel();
    const st = await window.desktop.tunnelStatus();
    if (st.state === 'running' || st.state === 'error') break;
  }
  const st = await window.desktop.tunnelStatus();
  if (st.state === 'running') {
    toast('公网隧道已建立，用手机扫码即可访问');
  } else if (st.state === 'error') {
    toast(`隧道失败：${st.error || '未知错误'}（请检查网络能否访问 Cloudflare）`, 'err');
  }
});
$('btn-tunnel-stop').addEventListener('click', async () => {
  await window.desktop.tunnelStop();
  toast('隧道已停止');
  refreshTunnel();
});
$('btn-tunnel-copy').addEventListener('click', async () => {
  const st = await window.desktop.tunnelStatus();
  if (st.url) {
    navigator.clipboard.writeText(st.url);
    toast('公网地址已复制');
  }
});

// 模型路由按钮（事件委托）
document.querySelectorAll('.apply-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const role = btn.dataset.role;
    // 先保存当前输入再应用
    const routing = collectModelRouting();
    await window.desktop.saveModelRouting(routing);
    settings = { ...settings, modelRouting: routing };
    await applyRouting(role);
  });
});
document.querySelectorAll('.pick-btn').forEach((btn) => {
  btn.addEventListener('click', () => openModelPicker(btn.dataset.role));
});

// 命令面板快捷键（壳聚焦时）
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openPalette();
  }
  if (e.key === 'Escape') {
    if (!$('palette-mask').classList.contains('hidden')) closePalette();
    else if (!$('board-mask').classList.contains('hidden')) closeBoard();
    else if (!$('skill-mask').classList.contains('hidden')) closeSkillPanel();
    else if (!$('drawer-mask').classList.contains('hidden')) closeDrawer();
    else if (!$('model-picker').classList.contains('hidden')) closeModelPicker();
  }
});

$('palette-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runCommand();
  if (e.key === 'Escape') closePalette();
});

// ---------------- 启动 ----------------
setupBoardInteractions();
bindUiCustomEvents();
(async function init() {
  const s = await window.desktop.getSettings();
  settings = s;
  applyThemeSource(s.themeSource || 'system');
  applyUiCustom(s.uiCustom || {});
  renderState(await window.desktop.getState());
  window.desktop.listSessions().then(updateSessions).catch(() => {});
  initOnboarding();
})();
