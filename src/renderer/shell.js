// DSH-Z 壳逻辑：状态渲染、webview 管理、命令面板、设置抽屉、
// 主题动效、多模态模型路由、文件拖放
'use strict';

// 全局错误捕获：任何运行时异常都显示为 toast，避免"无响应/静默失败"难以排查
window.addEventListener('error', (e) => {
  try {
    const el = document.createElement('div');
    el.className = 'toast err';
    el.style.position = 'fixed';
    el.style.bottom = '80px';
    el.style.left = '50%';
    el.style.transform = 'translateX(-50%)';
    el.style.zIndex = '99999';
    el.style.maxWidth = '80vw';
    const stack = e && e.error && e.error.stack ? String(e.error.stack).split('\n').slice(0, 6).join(' | ') : '';
    el.textContent = `JS 错误: ${e.message || 'unknown'} @${e.lineno || '?'}:${e.colno || '?'}${stack ? '  STACK: ' + stack : ''}`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
  try {
    const el = document.createElement('div');
    el.className = 'toast err';
    el.style.position = 'fixed';
    el.style.bottom = '110px';
    el.style.left = '50%';
    el.style.transform = 'translateX(-50%)';
    el.style.zIndex = '99999';
    el.style.maxWidth = '80vw';
    const r = e && e.reason;
    const msg = (r && (r.message || r)) || r || 'unknown';
    const stack = (r && r.stack) ? String(r.stack).split('\n').slice(0, 6).join(' | ') : '';
    el.textContent = `异步错误: ${String(msg)}${stack ? '  STACK: ' + stack : ''}`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  } catch {}
});

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
  applyThemeBridge();
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
  // system 模式也按系统偏好判断深浅（否则 system 浅色时仍用深色基础色）
  const theme = document.documentElement.dataset.theme;
  const isLight = theme === 'light' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
  const root = document.documentElement.style;
  // 强调色 + 圆角
  if (u.accent) root.setProperty('--accent', u.accent);
  if (u.accent2) root.setProperty('--accent-2', u.accent2);
  root.setProperty('--radius', `${u.radius ?? 10}px`);  // 组件透明度（基于当前主题基础色计算 rgba）
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
  // 主题桥：壳强调色/圆角同步到 harness 页面（webview 未就绪时跳过，dom-ready 后会再应用）
  try {
    if (view.getURL && view.getURL()) applyThemeBridge();
  } catch {}
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
    // 仅当用户显式定制背景色时覆盖；否则显式跟随主题（输入框/选择框/导航底色随主题）
    if (u.backgroundType === 'color' && u.background) {
      root.setProperty('--bg', u.background);
    } else {
      root.setProperty('--bg', isLight ? '#f4f6f9' : '#0c1016');
    }
  }
}

function themeIsLight() {
  const theme = document.documentElement.dataset.theme;
  return theme === 'light' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
}

function fillUiCustom(u) {
  $('ui-bg-type').value = u.backgroundType || 'color';
  // 背景色输入框默认显示当前主题底色（跟随主题）；用户主动改色才作为自定义值
  $('ui-bg-color').value = u.background || (themeIsLight() ? '#f4f6f9' : '#0c1016');
  $('ui-bg-image').value = u.backgroundImage || '';
  $('ui-bg-blur').value = u.backgroundBlur ?? 12;
  $('ui-blur-val').textContent = u.backgroundBlur ?? 12;
  $('ui-bg-dim').value = Math.round((u.backgroundDim ?? 0.35) * 100);
  $('ui-dim-val').textContent = (u.backgroundDim ?? 0.35).toFixed(2);
  $('ui-accent').value = u.accent || '#3b82f6';
  $('ui-accent2').value = u.accent2 || '#2563eb';
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
  const defaultBg = themeIsLight() ? '#f4f6f9' : '#0c1016';
  const picked = $('ui-bg-color').value;
  return {
    backgroundType: $('ui-bg-type').value,
    // 未主动改色（等于主题底色或未初始化 #000000）时保持空，让 --bg 跟随主题，避免深浅杂糅
    background: (picked === defaultBg || picked === '#000000') ? '' : picked,
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
  $('btn-mcp-add').addEventListener('click', async () => {
  const name = $('mcp-name').value.trim();
  const transport = $('mcp-transport').value;
  const url = $('mcp-url').value.trim();
  const command = $('mcp-command').value.trim();
  if (!name) { toast('请输入服务名称', 'err'); return; }
  if (transport === 'streamable-http' && !url) { toast('请输入 URL', 'err'); return; }
  if (transport === 'stdio' && !command) { toast('请输入命令', 'err'); return; }
  const r = await window.desktop.mcpUpsert({ serverName: name, transport, url, command });
  toast(r.ok ? '已添加配置（保存并重启后生效）' : `失败：${r.error}`, r.ok ? 'ok' : 'err');
  if (r.ok) { $('mcp-name').value = ''; renderMcp(); }
});
$('set-picker').addEventListener('change', async () => {
  const kind = $('set-picker').value;
  const r = await window.desktop.pickerSet(kind);
  toast(r.ok ? '已设置（保存并重启后生效）' : `失败：${r.error}`, r.ok ? 'ok' : 'err');
});
$('btn-mcp-apply').addEventListener('click', async () => {
  const r = await window.desktop.mcpApply();
  toast(r.ok ? (r.restarted ? '配置已保存，服务已重启' : '配置已保存，服务未运行') : `失败：${r.error}`, r.ok ? 'ok' : 'err');
});
$('btn-ui-reset').addEventListener('click', () => {
    const d = { backgroundType: 'color', background: document.documentElement.dataset.theme === 'light' ? '#f2f4f7' : '#111418', backgroundImage: '', backgroundBlur: 12, backgroundDim: 0.35, accent: '#3b82f6', accent2: '#2563eb', radius: 10, titlebarOpacity: 0.94, panelOpacity: 0.92 };
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
    // 填充可用模型下拉（实时查询 API key 权限）
    window.desktop.summaryModels().then((r) => {
      const sel = $('set-summary-model');
      const current = s.summary?.model || '';
      if (r.ok && r.models.length) {
        const opts = r.models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
        sel.innerHTML = opts + '<option value="__custom__">自定义…</option>';
        if (r.models.includes(current)) sel.value = current;
        else if (current) { sel.value = '__custom__'; $('set-summary-model-custom').classList.remove('hidden'); $('set-summary-model-custom').value = current; }
      } else {
        sel.innerHTML = `<option value="${escapeHtml(current || 'agnes-2.5-flash')}">${escapeHtml(current || 'agnes-2.5-flash')}</option><option value="__custom__">自定义…</option>`;
      }
    }).catch(() => {});
    $('set-summary-model-custom').value = '';
  }).catch(() => {});
  // 独立刷新（不依赖 getSettings 成功与否）
  refreshLanStatus();
  refreshTunnel();
  refreshTailscale();
  refreshSsh();
  refreshFrp();
  $('set-summary-model').addEventListener('change', () => {
    $('set-summary-model-custom').classList.toggle('hidden', $('set-summary-model').value !== '__custom__');
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
      model: ($('set-summary-model').value === '__custom__'
        ? $('set-summary-model-custom').value.trim()
        : $('set-summary-model').value.trim()) || 'agnes-2.5-flash',
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
  const isLight = source === 'light' || (source === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
  // 显式设置 --bg，保证输入框/导航等 var(--bg) 元素始终跟随主题（不依赖 media query 计算）
  document.documentElement.style.setProperty('--bg', isLight ? '#f4f6f9' : '#0c1016');
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
  if (ev.kind === 'approvals') {
    approvals = ev.approvals || [];
    renderApprovals();
  }
  if (ev.kind === 'memory-recall') {
    toast(`新会话：发现 ${ev.notes.length} 条相关记忆（打开记忆面板查看）`, 'ok');
  }
  if (ev.kind === 'memory-saved') {
    toast(`🧠 已沉淀记忆：${ev.text || ''}`, 'ok');
    renderMemoryList();
  }
  if (ev.kind === 'memory-summary') {
    showAiResult(`🧠 记忆定期总结\n\n${ev.text}`);
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

const PALETTE = ['#3b82f6', '#60a5fa', '#2563eb', '#93c5fd', '#1d4ed8', '#0ea5e9', '#7dd3fc', '#1e40af', '#0284c7', '#6b7280'];

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
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.5)';
    } else if (l.kind === 'produced') {
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(96, 165, 250, 0.45)';
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
      ctx.fillStyle = n.color || '#60a5fa';
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
  ctx.shadowBlur = 2;
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
    ctx.globalAlpha = 0.88;
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
  if (!tip) return;
  if (!node) {
    tip.classList.add('hidden');
    return;
  }
  const wrapEl = $('board-canvas-wrap');
  if (!wrapEl) return; // 看板未渲染/已关闭时不显示 tooltip
  const wrap = wrapEl.getBoundingClientRect();
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
        vx: 0, vy: 0, r: 5, color: '#60a5fa', cluster: node.id, data: p,
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
        <button class="btn link mini-btn" id="btn-ai-summary">AI 总结</button>
        <button class="btn link mini-btn" id="btn-ai-related">相关会话</button>
        <button class="btn link mini-btn" id="btn-ai-insight">决策 insight</button>
      </div>
      <div id="detail-ai-out" style="margin-top:10px"></div>
    </div>`;
  renderProducedList($('board-produced-list'), produced);
  $('btn-copy-sid').addEventListener('click', () => {
    navigator.clipboard.writeText(node.id);
    toast('会话 ID 已复制');
  });
  const aiOut = $('detail-ai-out');
  $('btn-ai-summary').addEventListener('click', async () => {
    aiOut.innerHTML = '<div class="tt-goal" style="color:var(--text-dim)">agnes 正在总结…</div>';
    const r = await window.desktop.taskSummary({ sessionId: node.id });
    aiOut.innerHTML = r.ok
      ? `<div class="tt-goal">💡 ${escapeHtml(r.summary || '')}</div>`
      : `<div class="tt-goal" style="color:var(--err)">失败：${escapeHtml(r.error)}</div>`;
  });
  $('btn-ai-related').addEventListener('click', async () => {
    const r = await window.desktop.relatedSessions(node.id);
    if (!r.ok) { aiOut.innerHTML = `<div class="tt-goal" style="color:var(--err)">失败：${escapeHtml(r.error)}</div>`; return; }
    if (!r.related.length) { aiOut.innerHTML = '<div class="tt-goal" style="color:var(--text-dim)">暂无相似会话</div>'; return; }
    aiOut.innerHTML = '<div class="detail-section"><h5>相关会话</h5>' + r.related.map((x) =>
      `<div class="produced-item" style="cursor:pointer" data-rsid="${x.id}"><span class="p-name">${escapeHtml(x.title)}</span><span class="p-path">相似 ${Math.round(x.score * 100)}%</span></div>`
    ).join('') + '</div>';
    aiOut.querySelectorAll('[data-rsid]').forEach((el) => {
      el.addEventListener('click', () => {
        const n = boardNodes.find((x) => x.id === el.dataset.rsid);
        if (n) selectBoardNode(n.id);
      });
    });
  });
  $('btn-ai-insight').addEventListener('click', async () => {
    aiOut.innerHTML = '<div class="tt-goal" style="color:var(--text-dim)">agnes 正在分析…</div>';
    const r = await window.desktop.insight(node.id);
    aiOut.innerHTML = r.ok
      ? `<div class="tt-goal">🧭 ${escapeHtml(r.insight || '')}</div>`
      : `<div class="tt-goal" style="color:var(--err)">失败：${escapeHtml(r.error)}</div>`;
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
  items.push('<span class="legend-item"><span class="legend-dot sq" style="background:#60a5fa"></span>产出物</span>');
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

// ---------------- 审批快捷操作 ----------------
let approvals = [];

function renderApprovals() {
  const badge = $('approval-badge');
  badge.textContent = approvals.length;
  badge.classList.toggle('hidden', approvals.length === 0);
  const list = $('appr-list');
  if (!list) return;
  if (!approvals.length) {
    list.innerHTML = '<div class="appr-empty">暂无待审批请求 ✓</div>';
    $('appr-count').textContent = '';
    return;
  }
  $('appr-count').textContent = `${approvals.length} 个`;
  list.innerHTML = '';
  for (const a of approvals) {
    const item = document.createElement('div');
    item.className = 'appr-item';
    const time = new Date(a.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    item.innerHTML = `
      <div class="appr-tool">⚠️ 工具 <span class="tag">${escapeHtml(a.toolName || 'unknown')}</span> <span style="margin-left:auto;font-size:10.5px;color:var(--text-dim)">${time}</span></div>
      ${a.reason ? `<div class="appr-reason">${escapeHtml(a.reason)}</div>` : ''}
      <div class="appr-meta">${escapeHtml(String(a.sessionId || '').slice(0, 24))}</div>
      <div class="appr-actions">
        <button class="btn primary mini-allow" data-id="${escapeHtml(a.approvalId)}">✓ 允许</button>
        <button class="btn danger mini-reject" data-id="${escapeHtml(a.approvalId)}">✕ 拒绝</button>
      </div>`;
    item.querySelector('.mini-allow').addEventListener('click', () => respondApproval(a.approvalId, 'allowed-once'));
    item.querySelector('.mini-reject').addEventListener('click', () => respondApproval(a.approvalId, 'rejected'));
    list.appendChild(item);
  }
}

async function respondApproval(approvalId, outcome) {
  const res = await window.desktop.approvalRespond({ approvalId, outcome });
  if (res.ok) {
    approvals = approvals.filter((a) => a.approvalId !== approvalId);
    renderApprovals();
    toast(outcome === 'rejected' ? '已拒绝该请求' : '已允许该请求', 'ok');
  } else {
    toast(`操作失败：${res.error}`, 'err');
  }
}

function openApprovals() {
  window.desktop.getApprovals().then((r) => {
    if (r.ok) { approvals = r.approvals || []; renderApprovals(); }
  });
  $('appr-mask').classList.remove('hidden');
  void $('appr-mask').offsetWidth;
  $('appr-mask').classList.add('visible');
}

function closeApprovals() {
  $('appr-mask').classList.remove('visible');
  setTimeout(() => $('appr-mask').classList.add('hidden'), 220);
}

// ---------------- 全局搜索 ----------------
function openSearch() {
  $('search-mask').classList.remove('hidden');
  void $('search-mask').offsetWidth;
  $('search-mask').classList.add('visible');
  $('search-input').value = '';
  $('search-results').innerHTML = '<div class="search-empty">输入关键词，搜索所有历史会话内容</div>';
  setTimeout(() => $('search-input').focus(), 40);
}

function closeSearch() {
  $('search-mask').classList.remove('visible');
  setTimeout(() => $('search-mask').classList.add('hidden'), 220);
}

async function doSearch() {
  const q = $('search-input').value.trim();
  const box = $('search-results');
  if (!q) { box.innerHTML = '<div class="search-empty">输入关键词搜索</div>'; return; }
  box.innerHTML = '<div class="search-empty">搜索中…</div>';
  const r = await window.desktop.globalSearch(q);
  if (!r.ok) { box.innerHTML = `<div class="search-empty">搜索失败：${escapeHtml(r.error)}</div>`; return; }
  if (!r.items.length) { box.innerHTML = '<div class="search-empty">没有找到匹配的会话内容</div>'; return; }
  box.innerHTML = '';
  for (const it of r.items) {
    const el = document.createElement('div');
    el.className = 'search-item';
    const time = it.updatedAt ? new Date(it.updatedAt).toLocaleDateString('zh-CN') : '';
    el.innerHTML = `
      <div class="search-item-head">
        <span class="search-item-title">${escapeHtml(it.title || it.sessionId.slice(0, 20))}</span>
        <span class="search-item-time">${time}</span>
      </div>
      <div class="search-item-snippet">${escapeHtml(it.snippet || '').slice(0, 300)}</div>`;
    el.addEventListener('click', () => {
      navigator.clipboard.writeText(it.sessionId);
      toast(`已复制会话 ID（${it.sessionId.slice(0, 12)}…），可在 harness 页面恢复`);
    });
    box.appendChild(el);
  }
}

// ---------------- 会话管理 ----------------
let sessBoardData = null;

async function refreshSessions() {
  const list = $('sess-list');
  const res = await window.desktop.boardSnapshot();
  if (!res.ok) {
    list.innerHTML = `<div class="appr-empty">加载失败：${escapeHtml(res.error)}</div>`;
    return;
  }
  sessBoardData = res;
  const items = [...res.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  if (!items.length) {
    list.innerHTML = '<div class="appr-empty">还没有会话 —— 点击「新建会话」开始</div>';
    return;
  }
  list.innerHTML = '';
  for (const s of items) {
    const el = document.createElement('div');
    el.className = 'sess-item';
    const date = new Date(s.updatedAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `
      <span class="sess-dot ${s.running ? 'running' : 'idle'}"></span>
      <div class="sess-main">
        <div class="sess-title">${escapeHtml(s.title || s.agentPreset || s.id.slice(0, 16))}</div>
        <div class="sess-meta">${s.agentPreset || '—'} · ${date}${s.running ? ' · ● 运行中' : ''}</div>
        ${s.goal ? `<div class="sess-meta" style="color:var(--accent)">🎯 ${escapeHtml(String(s.goal).slice(0, 40))}</div>` : ''}
      </div>
      <div class="sess-actions">
        ${s.goalId && s.goal ? `<button class="mini-btn" data-act="goal-done" data-id="${s.id}" title="标记目标完成">✓ 目标</button>` : ''}
        <button class="mini-btn" data-act="export" data-id="${s.id}">导出</button>
        <button class="mini-btn" data-act="rename" data-id="${s.id}">重命名</button>
        <button class="mini-btn" data-act="fork" data-id="${s.id}">派生</button>
        ${s.running ? `<button class="mini-btn danger" data-act="cancel" data-id="${s.id}">取消</button>` : ''}
      </div>`;
    el.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const act = btn.dataset.act;
        const sid = btn.dataset.id;
        if (act === 'export') {
          const r = await window.desktop.sessionExport(sid);
          if (r.ok) toast(`已导出：${r.path}`, 'ok');
          else if (!r.canceled) toast(`导出失败：${r.error}`, 'err');
        } else if (act === 'rename') {
          const title = prompt('新的会话标题：', s.title || '');
          if (title && title.trim()) {
            const r = await window.desktop.sessionRename({ sessionId: sid, title });
            toast(r.ok ? '已重命名' : `失败：${r.error}`, r.ok ? 'ok' : 'err');
            refreshSessions();
          }
        } else if (act === 'fork') {
          const r = await window.desktop.sessionFork({ sessionId: sid });
          toast(r.ok ? `已派生新会话 ${String(r.sessionId).slice(0, 12)}…` : `失败：${r.error}`, r.ok ? 'ok' : 'err');
          if (r.ok) refreshSessions();
        } else if (act === 'cancel') {
          if (confirm('取消这个运行中的会话？')) {
            const r = await window.desktop.sessionCancel(sid);
            toast(r.ok ? '已发送取消' : `失败：${r.error}`, r.ok ? 'ok' : 'err');
          }
        } else if (act === 'goal-done') {
          const r = await window.desktop.goalComplete({ sessionId: sid, id: s.goalId, revision: s.goalRevision || 1 });
          toast(r.ok ? '目标已完成 🎉' : `失败：${r.error}`, r.ok ? 'ok' : 'err');
          if (r.ok) refreshSessions();
        }
      });
    });
    list.appendChild(el);
  }
}

function openSessions() {
  refreshSessions();
  $('sess-mask').classList.remove('hidden');
  void $('sess-mask').offsetWidth;
  $('sess-mask').classList.add('visible');
}

function closeSessions() {
  $('sess-mask').classList.remove('visible');
  setTimeout(() => $('sess-mask').classList.add('hidden'), 260);
}

// ---------------- 主题桥：壳主题 → harness 页面 ----------------
function themeBridgeCss() {
  const root = getComputedStyle(document.documentElement);
  const accent = root.getPropertyValue('--accent').trim() || '#3b82f6';
  const accent2 = root.getPropertyValue('--accent-2').trim() || '#2563eb';
  const radius = root.getPropertyValue('--radius').trim() || '10px';
  const isLight = document.documentElement.dataset.theme === 'light' ||
    (document.documentElement.dataset.theme === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
  // 浅色模式：修正 harness 页面代码块深色背景（body[data-ds-dark-theme] 会覆盖为深色 token）
  const codeFix = isLight ? `
body[data-ds-dark-theme]{
  --dsw-alias-markdown-code-block:#f6f8fa !important;
  --shiki-background:#f6f8fa !important;
  --shiki-foreground:#24292e !important;
  --shiki-token-constant:#1c7ed6 !important;
  --shiki-token-string:#2f9e44 !important;
  --shiki-token-comment:#6a737d !important;
  --shiki-token-keyword:#d6336c !important;
  --shiki-token-parameter:#e8590c !important;
  --shiki-token-function:#6741d9 !important;
  --shiki-token-string-expression:#2b8a3e !important;
  --shiki-token-punctuation:#495057 !important;
  --shiki-token-link:#1971c2 !important;
}` : '';
  return `
:root{
  --dsh-chat-content-width: min(1200px, 94vw);
  --dsh-composer-card-max-width: min(1200px, 94vw);
  --dsw-alias-brand-primary: ${accent};
  --dsw-alias-brand-primary-hover: ${accent};
  --dsw-alias-brand-primary-active: ${accent};
  --dsw-alias-brand-primary-fg: ${accent};
  --dsw-alias-radius-lg: ${radius};
  --dsw-alias-radius-md: ${radius};
  --dsw-alias-radius-sm: ${radius};
}
${codeFix}
*{scrollbar-width:thin}`;
}

function applyThemeBridge() {
  try {
    // 首次调用时 themeBridgeCssId 为 null，传 null 给 webview.removeInsertedCSS
    // 会触发 GUEST_VIEW_MANAGER_CALL 序列化错误（异步层，try/catch 接不住），
    // 因此仅在 id 有效时才移除。
    if (themeBridgeCssId) view.removeInsertedCSS(themeBridgeCssId);
  } catch {}
  try {
    const css = themeBridgeCss();
    if (css) themeBridgeCssId = view.insertCSS(css);
  } catch {}
}
let themeBridgeCssId = null;

// ---------------- 数据看板 ----------------
let statsDim = 'task';

function renderStats() {
  const summary = $('stats-summary');
  const body = $('stats-body');
  body.innerHTML = '<div class="appr-empty">加载中…</div>';
  window.desktop.boardSnapshot().then((res) => {
    if (!res.ok) { body.innerHTML = `<div class="appr-empty">加载失败：${escapeHtml(res.error)}</div>`; return; }
    const sessions = res.sessions.filter((s) => s.stats);
    if (!sessions.length) { summary.innerHTML = ''; body.innerHTML = '<div class="appr-empty">暂无统计数据</div>'; return; }
    const total = sessions.reduce((a, s) => ({
      sessions: a.sessions + 1,
      turns: a.turns + (s.stats.turns || 0),
      steps: a.steps + (s.stats.steps || 0),
      out: a.out + (s.tokenUsage?.outputTokens || s.stats.decodeTokens || 0),
      inp: a.inp + (s.tokenUsage?.uncachedInputTokens || 0),
      cache: a.cache + (s.tokenUsage?.cacheReadTokens || 0),
    }), { sessions: 0, turns: 0, steps: 0, out: 0, inp: 0, cache: 0 });
    summary.innerHTML = `
      <div class="stats-cell"><b>${total.sessions}</b><span>对话数</span></div>
      <div class="stats-cell"><b>${total.turns}</b><span>轮次</span></div>
      <div class="stats-cell"><b>${(total.out / 1000).toFixed(0)}k</b><span>输出 token</span></div>
      <div class="stats-cell"><b>${(total.inp / 1000).toFixed(0)}k</b><span>输入 token</span></div>
      <div class="stats-cell"><b>${(total.cache / 1000).toFixed(0)}k</b><span>缓存 token</span></div>`;

    if (statsDim === 'task') {
      // 任务维度：每会话一行（标题 + 指标 + 柱状图 + AI 总结按钮）
      const max = Math.max(...sessions.map((s) => (s.tokenUsage?.outputTokens || s.stats.decodeTokens || 0)), 1);
      body.innerHTML = sessions.map((s) => {
        const t = s.tokenUsage?.outputTokens || s.stats.decodeTokens || 0;
        return `<div class="stats-row">
          <div class="sr-title">${escapeHtml(s.title || s.agentPreset || s.id.slice(0, 12))}</div>
          <div class="sr-meta">${s.stats.turns || 0}t · ${(t / 1000).toFixed(1)}k</div>
          <div class="stats-bar-wrap" style="width:120px"><div class="stats-bar" style="width:${Math.max(2, t / max * 100)}%"></div></div>
          <div class="sr-actions"><button class="mini-btn" data-ai="${escapeHtml(s.id)}">AI 总结</button></div>
        </div>`;
      }).join('');
      body.querySelectorAll('[data-ai]').forEach((b) => {
        b.addEventListener('click', () => runTaskSummary(b.dataset.ai));
      });
    } else {
      // 时间维度：按天聚合折线/柱状
      const byDay = new Map();
      for (const s of sessions) {
        const d = new Date(s.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
        const e = byDay.get(d) || { turns: 0, out: 0, count: 0 };
        e.turns += s.stats.turns || 0;
        e.out += s.tokenUsage?.outputTokens || s.stats.decodeTokens || 0;
        e.count += 1;
        byDay.set(d, e);
      }
      const days = [...byDay.entries()].sort((a, b) => new Date(a[0]) - new Date(b[0]));
      const maxOut = Math.max(...days.map(([, v]) => v.out), 1);
      const maxTurns = Math.max(...days.map(([, v]) => v.turns), 1);
      body.innerHTML = `<div style="display:flex;gap:14px;align-items:flex-end;height:140px;padding:0 4px;margin-bottom:14px">` +
        days.map(([d, v]) => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0">
          <span style="font-size:10px;color:var(--text-dim)">${v.count}话</span>
          <div style="width:60%;background:color-mix(in srgb, var(--accent) 35%, transparent);border-radius:4px 4px 0 0;height:${Math.max(3, v.turns / maxTurns * 110)}px" title="${v.turns} turns"></div>
          <div style="width:60%;background:linear-gradient(180deg,var(--accent),var(--accent-2));border-radius:0 0 4px 4px;height:${Math.max(3, v.out / maxOut * 80)}px" title="${(v.out / 1000).toFixed(1)}k tokens"></div>
          <span style="font-size:10px;color:var(--text-dim)">${d}</span>
        </div>`).join('') + `</div>
        <div style="font-size:11px;color:var(--text-dim);display:flex;gap:16px;margin-bottom:8px">
          <span><span style="display:inline-block;width:9px;height:9px;background:var(--accent);border-radius:2px;margin-right:4px"></span>输出 token</span>
          <span><span style="display:inline-block;width:9px;height:9px;background:color-mix(in srgb,var(--accent) 35%,transparent);border-radius:2px;margin-right:4px"></span>轮次</span>
        </div>` +
        days.map(([d, v]) => `<div class="stats-row" style="border:none;background:transparent;padding:4px 6px"><div class="sr-title">${d}</div><div class="sr-meta">${v.count} 会话 · ${v.turns} turns · ${(v.out / 1000).toFixed(1)}k 输出</div></div>`).join('');
    }
  }).catch((e) => { body.innerHTML = `<div class="appr-empty">加载失败：${String(e.message || e)}</div>`; });
}

function openStats() {
  $('stats-mask').classList.remove('hidden');
  void $('stats-mask').offsetWidth;
  $('stats-mask').classList.add('visible');
  renderStats();
}

function closeStats() {
  $('stats-mask').classList.remove('visible');
  setTimeout(() => $('stats-mask').classList.add('hidden'), 220);
}

// ---------------- AI 总结（agnes） ----------------
async function runTaskSummary(sessionId) {
  const res = await window.desktop.taskSummary({ sessionId });
  if (!res.ok) { toast(`总结失败：${res.error}`, 'err'); return; }
  toast(res.cached ? '（缓存）' + (res.summary || '').slice(0, 60) : '任务总结已生成', 'ok');
  showAiResult(`📋 任务总结${res.cached ? '（缓存）' : ''}\n\n${res.summary || '无内容'}`);
}

async function runPeriodSummary() {
  const from = $('ai-from').value;
  const to = $('ai-to').value;
  if (!from && !to) { toast('请选择时间范围', 'err'); return; }
  const box = $('ai-result');
  box.innerHTML = '<div class="ai-loading">agnes 正在分析…</div>';
  const res = await window.desktop.periodSummary({ from, to });
  if (!res.ok) { box.innerHTML = `<div class="appr-empty">失败：${escapeHtml(res.error)}</div>`; return; }
  const label = `${from || '最早'} ~ ${to || '现在'}（${res.count} 个会话）`;
  box.innerHTML = `<b>📅 ${escapeHtml(label)}</b>\n\n${res.summary || '（无内容）'}${res.cached ? '\n\n（缓存结果）' : ''}`;
}

function showAiResult(text) {
  $('board-ai-mask').classList.remove('hidden');
  void $('board-ai-mask').offsetWidth;
  $('board-ai-mask').classList.add('visible');
  $('ai-result').innerHTML = `<b>✦ AI 分析结果</b>\n\n${text}`;
}


// ---------------- Subagent 协作树 ----------------
async function refreshSubagentRoots() {
  const sel = $('subagent-root');
  const res = await window.desktop.boardSnapshot();
  if (!res.ok) return;
  sel.innerHTML = '';
  for (const s of res.sessions) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${(s.title || s.agentPreset || s.id.slice(0, 10)).slice(0, 22)} (${s.id.slice(0, 8)})`;
    sel.appendChild(opt);
  }
}

async function renderSubagentTree() {
  const rootId = $('subagent-root').value;
  const box = $('subagent-tree');
  if (!rootId) { box.innerHTML = '<div class="appr-empty">选择一个根会话查看其子 Agent 树</div>'; return; }
  box.innerHTML = '<div class="appr-empty">加载中…</div>';
  const res = await window.desktop.subagentTree(rootId);
  if (!res.ok) { box.innerHTML = `<div class="appr-empty">加载失败：${escapeHtml(res.error)}</div>`; return; }
  if (!res.tree.length) { box.innerHTML = '<div class="appr-empty">该会话没有子 Agent</div>'; return; }
  box.innerHTML = '';
  const renderNodes = (nodes, parentId) => {
    for (const n of nodes) {
      const row = document.createElement('div');
      row.className = 'sa-node';
      row.addEventListener('click', () => {
        selectedSubagentId = n.id;
        document.querySelectorAll('.sa-node').forEach((x) => x.style.background = '');
        row.style.background = 'color-mix(in srgb, var(--accent) 12%, transparent)';
      });
      if (n.kind === 'diagnostic') {
        row.innerHTML = `<div class="sa-node-row"><span class="sa-state diagnostic">诊断</span><span class="sa-label">${escapeHtml(n.reason || 'unavailable')}（${escapeHtml(String(n.id).slice(0, 10))}）</span></div>`;
        box.appendChild(row);
        continue;
      }
      row.innerHTML = `
        <div class="sa-node-row">
          <span class="sa-state ${n.running ? 'running' : 'inactive'}">${n.running ? '● 运行中' : '○ 空闲'}</span>
          <span class="sa-label ${n.kind === 'leaf' ? 'sa-leaf' : ''}">${escapeHtml(n.label || n.id.slice(0, 14))}</span>
          <span class="sa-actions">${n.running ? `<button class="mini-btn" data-stop="${escapeHtml(n.id)}">中断</button>` : ''}</span>
        </div>`;
      box.appendChild(row);
      row.querySelector('[data-stop]')?.addEventListener('click', async () => {
        const childId = row.querySelector('[data-stop]').dataset.stop;
        const r = await window.desktop.subagentInterrupt({ parentSessionId: rootId, childSessionId: childId });
        toast(r.ok ? '已发送中断' : `中断失败：${r.error}`, r.ok ? 'ok' : 'err');
        if (r.ok) renderSubagentTree();
      });
      if (n.children?.length) {
        const wrap = document.createElement('div');
        wrap.className = 'sa-node-children';
        box.appendChild(wrap);
        const sub = document.createElement('div');
        wrap.appendChild(sub);
        const old = box;
        box = sub;
        renderNodes(n.children, n.id);
        box = old;
      }
    }
  };
  renderNodes(res.tree, rootId);
}

function openSubagents() {
  refreshSubagentRoots();
  $('subagent-mask').classList.remove('hidden');
  void $('subagent-mask').offsetWidth;
  $('subagent-mask').classList.add('visible');
  setTimeout(renderSubagentTree, 200);
}

function closeSubagents() {
  $('subagent-mask').classList.remove('visible');
  setTimeout(() => $('subagent-mask').classList.add('hidden'), 220);
}

async function delegateToSubagent() {
  const input = $('subagent-delegate-input');
  const text = input.value.trim();
  if (!text) return;
  const childId = selectedSubagentId;
  const rootId = $('subagent-root').value;
  if (!childId || !rootId) { toast('请先点击左侧选择一个子 Agent 节点', 'err'); return; }
  const r = await window.desktop.subagentPrompt({ parentSessionId: rootId, childSessionId: childId, text });
  toast(r.ok ? '任务已委派给子 Agent' : `委派失败：${r.error}`, r.ok ? 'ok' : 'err');
  if (r.ok) input.value = '';
}
let selectedSubagentId = null;

// ---------------- 资产仓库 ----------------
function assetIcon(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext)) return '🖼';
  if (['md', 'txt', 'doc', 'docx', 'pdf'].includes(ext)) return '📄';
  if (['xlsx', 'xls', 'csv'].includes(ext)) return '📊';
  if (['zip', 'tar', 'gz'].includes(ext)) return '📦';
  if (['py', 'js', 'ts', 'html', 'css', 'json', 'sh', 'sql'].includes(ext)) return '💻';
  return '📁';
}

async function renderAssets() {
  const box = $('assets-list');
  box.innerHTML = '<div class="appr-empty">聚合全部会话产出物…</div>';
  const res = await window.desktop.assetsList();
  if (!res.ok) { box.innerHTML = `<div class="appr-empty">加载失败：${escapeHtml(res.error)}</div>`; return; }
  const q = $('assets-search').value.trim().toLowerCase();
  const assets = res.assets || [];
  const filtered = q ? assets.filter((a) => a.name.toLowerCase().includes(q) || a.path.toLowerCase().includes(q)) : assets;
  if (!filtered.length) { box.innerHTML = '<div class="appr-empty">暂无产出物 —— 在会话中完成任务后自动聚合</div>'; return; }
  box.innerHTML = '';
  for (const a of filtered) {
    const el = document.createElement('div');
    el.className = 'asset-item';
    const time = a.updatedAt ? new Date(a.updatedAt).toLocaleDateString('zh-CN') : '';
    el.innerHTML = `
      <div class="asset-icon">${assetIcon(a.name)}</div>
      <div class="asset-main">
        <div class="asset-name">${escapeHtml(a.name)}</div>
        <div class="asset-meta">${escapeHtml(a.path)} · ${escapeHtml(a.sessionTitle || '')} · ${time}</div>
      </div>
      <div class="asset-actions">
        <button class="mini-btn" data-act="open">打开</button>
        <button class="mini-btn" data-act="reveal" title="在 Finder 中显示">⌘</button>
      </div>`;
    el.querySelector('[data-act=open]').addEventListener('click', () => window.desktop.boardOpenPath({ path: a.path }));
    el.querySelector('[data-act=reveal]').addEventListener('click', () => window.desktop.boardOpenPath({ path: a.path, reveal: true }));
    box.appendChild(el);
  }
}

function openAssets() {
  $('assets-mask').classList.remove('hidden');
  void $('assets-mask').offsetWidth;
  $('assets-mask').classList.add('visible');
  renderAssets();
}

function closeAssets() {
  $('assets-mask').classList.remove('visible');
  setTimeout(() => $('assets-mask').classList.add('hidden'), 220);
}

// ---------------- 智能体预设 / 专家团 ----------------
async function refreshAgentSessions() {
  const sel = $('agent-session');
  const res = await window.desktop.boardSnapshot();
  if (!res.ok) return;
  sel.innerHTML = '';
  // harness 只允许对「未开始」的会话切换智能体预设（已开始的 preset 锁定）
  const candidates = (res.sessions || []).filter((s) => s.blank);
  if (!candidates.length) {
    sel.innerHTML = '<option value="">（无可切换预设的会话：请先新建空白会话）</option>';
    return;
  }
  for (const s of candidates) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${(s.title || s.agentPreset || s.id.slice(0, 10)).slice(0, 20)} (${s.id.slice(0, 8)})`;
    sel.appendChild(opt);
  }
}

async function renderAgents() {
  const box = $('agent-list');
  box.innerHTML = '<div class="appr-empty">加载中…</div>';
  const res = await window.desktop.agentPresets();
  if (!res.ok) { box.innerHTML = `<div class="appr-empty">加载失败：${escapeHtml(res.error)}</div>`; return; }
  const presets = res.presets || [];
  if (!presets.length) { box.innerHTML = '<div class="appr-empty">暂无智能体预设</div>'; return; }
  box.innerHTML = '';
  for (const p of presets) {
    const el = document.createElement('div');
    el.className = 'agent-item';
    el.innerHTML = `
      <div class="agent-head">
        <span class="agent-name">${escapeHtml(p.id)}</span>
        ${p.isDefault ? '<span class="agent-badge default">默认</span>' : ''}
        ${p.trust === 'system' ? '<span class="agent-badge">系统</span>' : '<span class="agent-badge">用户</span>'}
        ${p.broken ? `<span class="agent-badge" style="color:var(--err)">异常</span>` : ''}
      </div>
      ${p.description ? `<div class="agent-desc">${escapeHtml(p.description)}</div>` : ''}
      <div class="agent-actions">
        <button class="mini-btn" data-act="apply" data-id="${escapeHtml(p.id)}">应用到会话</button>
        <button class="mini-btn" data-act="read" data-id="${escapeHtml(p.id)}">预览</button>
        ${res.authorable && p.trust === 'user' ? `<button class="mini-btn" data-act="copy" data-id="${escapeHtml(p.id)}">复制</button>` : ''}
        ${p.trust === 'user' ? `<button class="mini-btn danger" data-act="remove" data-id="${escapeHtml(p.id)}">删除</button>` : ''}
      </div>`;
    el.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const act = btn.dataset.act;
        const pid = btn.dataset.id;
        if (act === 'apply') {
          const sid = $('agent-session').value;
          if (!sid) { toast('无可用空白会话（已开始的会话预设已锁定，请先新建）', 'err'); return; }
          const r = await window.desktop.agentPresetApply({ sessionId: sid, agentPreset: pid });
          toast(r.ok ? `已应用到会话：${pid}` : `失败：${r.error}`, r.ok ? 'ok' : 'err');
        } else if (act === 'read') {
          const r = await window.desktop.agentPresetRead(pid);
          if (r.ok) toast(`「${pid}」：${(r.content || '').slice(0, 60)}…`, 'ok');
        } else if (act === 'copy') {
          const r = await window.desktop.agentPresetCopy({ from: pid });
          toast(r.ok ? `已复制为 ${r.agentPreset}` : `失败：${r.error}`, r.ok ? 'ok' : 'err');
          if (r.ok) renderAgents();
        } else if (act === 'remove') {
          if (confirm(`删除预设「${pid}」？`)) {
            const r = await window.desktop.agentPresetRemove(pid);
            toast(r.ok ? '已删除' : `失败：${r.error}`, r.ok ? 'ok' : 'err');
            if (r.ok) renderAgents();
          }
        }
      });
    });
    box.appendChild(el);
  }
}

function openAgents() {
  refreshAgentSessions();
  $('agent-mask').classList.remove('hidden');
  void $('agent-mask').offsetWidth;
  $('agent-mask').classList.add('visible');
  renderAgents();
}

function closeAgents() {
  $('agent-mask').classList.remove('visible');
  setTimeout(() => $('agent-mask').classList.add('hidden'), 220);
}

// ---------------- 记忆库 ----------------
let memoryNotes = [];
let memoryEditingId = null;

async function renderMemoryList() {
  const q = $('memory-search').value.trim();
  const res = await window.desktop.memoryList(q);
  const box = $('memory-list');
  if (!res.ok) { box.innerHTML = `<div class="appr-empty">加载失败：${escapeHtml(res.error)}</div>`; return; }
  memoryNotes = res.notes || [];
  if (!memoryNotes.length) { box.innerHTML = '<div class="appr-empty">还没有记忆笔记</div>'; return; }
  box.innerHTML = '';
  for (const n of memoryNotes) {
    const el = document.createElement('div');
    el.className = `memory-note${memoryEditingId === n.id ? ' active' : ''}`;
    el.innerHTML = `<div>${escapeHtml(n.title)}</div>${n.tags?.length ? `<div class="memory-note-tags">${escapeHtml(n.tags.slice(0, 3).join(' · '))}</div>` : ''}`;
    el.addEventListener('click', () => loadMemoryNote(n.id));
    box.appendChild(el);
  }
}

function renderMemoryEditor(note) {
  const box = $('memory-editor');
  const n = note || {};
  box.innerHTML = `
    <label>标题<input id="mem-title" type="text" value="${escapeHtml(n.title || '')}" spellcheck="false" /></label>
    <label>标签（逗号分隔）<input id="mem-tags" type="text" value="${escapeHtml((n.tags || []).join(', '))}" spellcheck="false" /></label>
    <label>内容<textarea id="mem-body" rows="10" spellcheck="false">${escapeHtml(n.body || '')}</textarea></label>
    <div class="drawer-actions">
      <button class="btn primary" id="btn-mem-save">保存</button>
      ${memoryEditingId ? '<button class="btn danger" id="btn-mem-delete">删除</button>' : ''}
    </div>`;
  $('btn-mem-save').addEventListener('click', async () => {
    const r = await window.desktop.memoryWrite({
      id: memoryEditingId || undefined,
      title: $('mem-title').value.trim(),
      tags: $('mem-tags').value.split(',').map((t) => t.trim()).filter(Boolean),
      body: $('mem-body').value,
    });
    toast(r.ok ? '记忆已保存' : `失败：${r.error}`, r.ok ? 'ok' : 'err');
    if (r.ok) { memoryEditingId = r.id; renderMemoryList(); }
  });
  $('btn-mem-delete')?.addEventListener('click', async () => {
    if (confirm('删除这条记忆？')) {
      await window.desktop.memoryRemove(memoryEditingId);
      memoryEditingId = null;
      renderMemoryList();
      renderMemoryEditor(null);
    }
  });
}

async function loadMemoryNote(id) {
  memoryEditingId = id;
  const res = await window.desktop.memoryRead(id);
  renderMemoryList();
  if (res.ok) {
    const body = (res.raw || '').replace(/^---[\s\S]*?---\n/, '').trim();
    renderMemoryEditor({ id, title: res.title, tags: res.tags, body });
  }
}

function openMemory() {
  $('memory-mask').classList.remove('hidden');
  void $('memory-mask').offsetWidth;
  $('memory-mask').classList.add('visible');
  renderMemoryList();
  if (!memoryNotes.length) renderMemoryEditor(null);
  // 加载锚点配置
  window.desktop.getSettings().then((st) => {
    const a = st.memoryAnchor || {};
    $('mem-anchor-enabled').checked = a.enabled !== false;
    $('mem-turn').value = a.turnInterval || 10;
    $('mem-periodic').value = a.periodic || 'weekly';
  });
}

$('btn-mem-anchor-save').addEventListener('click', async () => {
  const r = await window.desktop.setSettings({
    memoryAnchor: {
      enabled: $('mem-anchor-enabled').checked,
      turnInterval: Math.max(2, Math.min(100, Number($('mem-turn').value) || 10)),
      periodic: $('mem-periodic').value,
    },
  });
  toast(r.ok ? '记忆锚点设置已保存' : '保存失败', r.ok ? 'ok' : 'err');
});

$('btn-mem-summarize').addEventListener('click', async () => {
  const box = $('memory-editor');
  box.innerHTML = '<div class="appr-empty">agnes 正在汇总记忆…</div>';
  const text = await window.desktop.periodicSummaryNow();
  box.innerHTML = text ? `<b>🧠 记忆概览</b>\n\n${text}` : '<div class="appr-empty">记忆库为空或生成失败</div>';
});

function closeMemory() {
  $('memory-mask').classList.remove('visible');
  setTimeout(() => $('memory-mask').classList.add('hidden'), 220);
}

// ---------------- MCP 第三方服务 ----------------
async function renderMcp() {
  const res = await window.desktop.mcpList();
  const box = $('mcp-list');
  if (!res.ok) { box.innerHTML = `<div class="appr-empty">加载失败：${escapeHtml(res.error)}</div>`; return; }
  const servers = res.servers || [];
  if (!servers.length) { box.innerHTML = '<div class="appr-empty">尚未配置第三方服务</div>'; return; }
  box.innerHTML = '';
  for (const s of servers) {
    const el = document.createElement('div');
    el.className = 'mcp-item';
    el.innerHTML = `
      <span class="mcp-name">${escapeHtml(s.serverName)}</span>
      <span class="mcp-meta">${s.transport}${s.url ? ' · ' + escapeHtml(s.url.slice(0, 30)) : ''}${s.command ? ' · ' + escapeHtml(s.command.slice(0, 30)) : ''}</span>
      <button class="mini-btn danger" data-name="${escapeHtml(s.serverName)}">移除</button>`;
    el.querySelector('[data-name]').addEventListener('click', async () => {
      await window.desktop.mcpRemove(s.serverName);
      renderMcp();
    });
    box.appendChild(el);
  }
}

// ---------------- 面板拖拽缩放（智能体/记忆/子代理/资产/审批等） ----------------
(function initPanelResize() {
  const panels = ['appr-panel', 'search-panel', 'sess-panel', 'subagent-panel', 'assets-panel', 'agent-panel', 'memory-panel'];
  const apply = (panel, w, h) => {
    panel.style.width = w + 'px';
    panel.style.maxWidth = '96vw';
    panel.style.height = h + 'px';
    panel.style.maxHeight = 'none';
  };
  for (const id of panels) {
    const panel = document.getElementById(id);
    if (!panel) continue;
    const handle = panel.querySelector('.panel-resize');
    if (!handle) continue;
    let sx = 0, sy = 0, sw = 0, sh = 0, active = false;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      active = true;
      sx = e.clientX; sy = e.clientY;
      sw = panel.offsetWidth; sh = panel.offsetHeight;
      document.body.classList.add('panel-resizing');
    });
    window.addEventListener('mousemove', (e) => {
      if (!active) return;
      apply(panel, Math.max(340, sw + (e.clientX - sx)), Math.max(240, sh + (e.clientY - sy)));
    });
    window.addEventListener('mouseup', () => {
      if (!active) return;
      active = false;
      document.body.classList.remove('panel-resizing');
    });
  }
})();


// ---------------- 配置中心（智能体 / 服务 / 模型 统一管理） ----------------
let cfgTab = 'agents';
let cfgEditingAgent = null;

async function renderCfg() {
  const body = $('cfg-body');
  body.innerHTML = '<div class="appr-empty">加载中…</div>';
  if (cfgTab === 'agents') {
    const res = await window.desktop.agentPresets();
    if (!res.ok) { body.innerHTML = `<div class="appr-empty">失败：${escapeHtml(res.error)}</div>`; return; }
    const presets = res.presets || [];
    // 新建智能体表单（ID/名称/描述/System Prompt）
    body.innerHTML = `
      <div class="cfg-add-row" style="margin-bottom:10px">
        <button class="mini-btn" id="cfg-agent-new">＋ 新建智能体</button>
      </div>
      <div id="cfg-agent-form" class="hidden" style="border:1px dashed var(--border);border-radius:10px;padding:12px 14px;margin-bottom:10px">
        <div class="cfg-add-row">
          <input id="cfg-ag-id" placeholder="ID（小写连字符，如 product-analyst）" style="flex:1.2" />
          <input id="cfg-ag-name" placeholder="名称（如 产品分析师）" style="flex:1" />
        </div>
        <div class="cfg-add-row">
          <input id="cfg-ag-desc" placeholder="描述（一句话说明职责）" style="flex:1" />
        </div>
        <label style="display:block;font-size:12px;color:var(--text-dim);margin-top:8px">System Prompt
          <textarea id="cfg-ag-prompt" rows="6" style="width:100%;margin-top:4px;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px 10px;outline:none;font-family:ui-monospace,Menlo,monospace;font-size:12px" placeholder="你是一个专注于 XX 的智能体……"></textarea>
        </label>
        <div class="cfg-add-row">
          <button class="mini-btn" id="cfg-ag-save">保存</button>
          <button class="mini-btn" id="cfg-ag-cancel">取消</button>
          <span id="cfg-ag-edit-id" style="font-size:11px;color:var(--text-dim);align-self:center"></span>
        </div>
      </div>`;
    body.querySelector('#cfg-agent-new').addEventListener('click', () => {
      cfgEditingAgent = null;
      $('cfg-ag-id').disabled = false;
      $('cfg-ag-id').value = ''; $('cfg-ag-name').value = ''; $('cfg-ag-desc').value = ''; $('cfg-ag-prompt').value = '';
      $('cfg-ag-edit-id').textContent = '';
      $('cfg-agent-form').classList.remove('hidden');
    });
    body.querySelector('#cfg-ag-cancel').addEventListener('click', () => $('cfg-agent-form').classList.add('hidden'));
    body.querySelector('#cfg-ag-save').addEventListener('click', async () => {
      const input = {
        id: $('cfg-ag-id').value.trim(),
        name: $('cfg-ag-name').value.trim(),
        description: $('cfg-ag-desc').value.trim(),
        systemPrompt: $('cfg-ag-prompt').value,
      };
      if (!input.id || !input.name) { toast('ID 与名称必填', 'err'); return; }
      const r = cfgEditingAgent
        ? await window.desktop.agentPresetEdit(input)
        : await window.desktop.agentPresetCreate(input);
      toast(r.ok ? `智能体「${input.name}」已${cfgEditingAgent ? '更新' : '创建'}（新建会话时可选）` : `失败：${r.error}`, r.ok ? 'ok' : 'err');
      if (r.ok) { $('cfg-agent-form').classList.add('hidden'); renderCfg(); }
    });
    if (!presets.length) body.insertAdjacentHTML('beforeend', '<div class="appr-empty">暂无智能体预设</div>');
    for (const p of presets) {
      const el = document.createElement('div');
      el.className = 'agent-item';
      el.innerHTML = `
        <div class="agent-head">
          <span class="agent-name">${escapeHtml(p.id)}</span>
          ${p.isDefault ? '<span class="agent-badge default">默认</span>' : ''}
          ${p.trust === 'system' ? '<span class="agent-badge">系统</span>' : '<span class="agent-badge">用户</span>'}
        </div>
        ${p.description ? `<div class="agent-desc">${escapeHtml(p.description)}</div>` : ''}
        <div class="agent-actions">
          <button class="mini-btn" data-act="read" data-id="${escapeHtml(p.id)}">预览</button>
          ${p.trust === 'user' ? `<button class="mini-btn" data-act="edit" data-id="${escapeHtml(p.id)}">编辑</button>` : ''}
          <button class="mini-btn" data-act="copy" data-id="${escapeHtml(p.id)}">复制新建</button>
          ${p.trust === 'user' ? `<button class="mini-btn danger" data-act="remove" data-id="${escapeHtml(p.id)}">删除</button>` : ''}
        </div>`;
      el.querySelectorAll('[data-act]').forEach((b) => {
        b.addEventListener('click', async () => {
          const act = b.dataset.act; const pid = b.dataset.id;
          if (act === 'read') {
            const r = await window.desktop.agentPresetRead(pid);
            if (r.ok) showAiResult(`📋 智能体预设「${pid}」\n\n${(r.content || '').slice(0, 400)}`);
            else toast(`预览失败：${r.error}`, 'err');
          } else if (act === 'edit') {
            const r = await window.desktop.agentPresetRead(pid);
            if (!r.ok) { toast(`读取失败：${r.error}`, 'err'); return; }
            cfgEditingAgent = pid;
            const form = $('cfg-agent-form');
            form.classList.remove('hidden');
            form.scrollIntoView({ behavior: 'smooth', block: 'center' });
            // ID 锁定（不能改文件目录名），其余可编辑
            $('cfg-ag-id').disabled = true;
            $('cfg-ag-id').value = pid;
            $('cfg-ag-name').value = r.name || pid;
            $('cfg-ag-desc').value = r.description || '';
            $('cfg-ag-prompt').value = (r.content || '').replace(/^.*?text: >-\s*/s, '').replace(/^\s*- id:.*$/s, '').trim().slice(0, 2000);
            $('cfg-ag-edit-id').textContent = '编辑中：' + pid;
          } else if (act === 'copy') {
            const r = await window.desktop.agentPresetCopy({ from: pid });
            toast(r.ok ? `已复制为 ${r.agentPreset}（可在会话管理中对空白会话应用）` : `失败：${r.error}`, r.ok ? 'ok' : 'err');
            if (r.ok) renderCfg();
          } else if (act === 'remove') {
            if (confirm(`删除预设「${pid}」？`)) {
              const r = await window.desktop.agentPresetRemove(pid);
              toast(r.ok ? '已删除' : `失败：${r.error}`, r.ok ? 'ok' : 'err');
              if (r.ok) renderCfg();
            }
          }
        });
      });
      body.appendChild(el);
    }
    body.insertAdjacentHTML('beforeend', '<div class="appr-empty" style="font-size:11px">提示：预设「应用到会话」需目标会话为未开始状态（在会话管理新建后应用）</div>');
  } else if (cfgTab === 'services') {
    const res = await window.desktop.mcpList();
    const servers = res.ok ? res.servers || [] : [];
    body.innerHTML = '';
    for (const srv of servers) {
      body.insertAdjacentHTML('beforeend', `<div class="mcp-item">
        <span class="mcp-name">${escapeHtml(srv.serverName)}</span>
        <span class="mcp-meta">${srv.transport}${srv.url ? ' · ' + escapeHtml(srv.url.slice(0, 28)) : ''}</span>
        <button class="mini-btn danger" data-rm="${escapeHtml(srv.serverName)}">移除</button>
      </div>`);
    }
    body.insertAdjacentHTML('beforeend', `
      <div class="cfg-add-row">
        <input id="cfg-srv-name" placeholder="服务名（字母数字连字符）" />
        <select id="cfg-srv-transport"><option value="streamable-http">HTTP</option><option value="stdio">本地进程</option></select>
        <input id="cfg-srv-url" placeholder="URL 或命令" style="flex:1" />
        <button class="mini-btn" id="cfg-srv-add">添加服务</button>
      </div>
      <div class="appr-empty" style="font-size:11px">服务 = MCP server（第三方能力接入，如云手机/云电脑）。添加后到设置 → 服务 → 保存并重启生效。</div>`);
    body.querySelector('#cfg-srv-add').addEventListener('click', async () => {
      const name = $('cfg-srv-name').value.trim();
      const transport = $('cfg-srv-transport').value;
      const url = $('cfg-srv-url').value.trim();
      if (!name || !url) { toast('名称与地址必填', 'err'); return; }
      const r = await window.desktop.mcpUpsert({ serverName: name, transport, url, command: url });
      toast(r.ok ? '已添加（重启后生效）' : `失败：${r.error}`, r.ok ? 'ok' : 'err');
      if (r.ok) renderCfg();
    });
    body.querySelectorAll('[data-rm]').forEach((b) => {
      b.addEventListener('click', async () => {
        await window.desktop.mcpRemove(b.dataset.rm);
        renderCfg();
      });
    });
  } else {
    // 模型：provider 列表 + 模型 chips + 添加
    const res = await window.desktop.configProviders();
    if (!res.ok) { body.innerHTML = `<div class="appr-empty">失败：${escapeHtml(res.error)}</div>`; return; }
    const providers = res.providers || [];
    if (!providers.length) body.innerHTML = '<div class="appr-empty">尚无模型 Provider</div>';
    for (const prov of providers) {
      const wrap = document.createElement('div');
      wrap.className = 'cfg-provider';
      wrap.innerHTML = `
        <div class="cfg-provider-head">
          <span class="cfg-provider-name">${escapeHtml(prov.id)}</span>
          <span class="cfg-provider-url">${escapeHtml(prov.baseURL || '')}</span>
          <span class="cfg-prov-key" title="${prov.apiKeyEnv ? `API Key 已配置（${escapeHtml(prov.apiKeyEnv)}）` : '未配置 API Key，无法调用该服务'}">${prov.apiKeyEnv ? '● key' : '○ 无key'}</span>
          <span style="flex:1"></span>
          <button class="mini-btn" data-add-model="${escapeHtml(prov.id)}">＋ 模型</button>
        </div>
        <div class="cfg-models">${(prov.models || []).map((m) =>
          `<span class="cfg-model-chip">${escapeHtml(m)}<button data-rm-model="${escapeHtml(prov.id)}::${escapeHtml(m)}">×</button></span>`
        ).join('') || '<span class="appr-empty" style="padding:4px">暂无模型</span>'}</div>
        <div class="cfg-add-row hidden" data-add-row="${escapeHtml(prov.id)}">
          <input data-new-model="${escapeHtml(prov.id)}" placeholder="模型 ID，如 my-model" style="flex:1" />
          <button class="mini-btn" data-add-ok="${escapeHtml(prov.id)}">添加</button>
        </div>`;
      body.appendChild(wrap);
      wrap.querySelector('[data-add-model]').addEventListener('click', () => {
        wrap.querySelector('[data-add-row]').classList.toggle('hidden');
      });
      wrap.querySelector('[data-add-ok]').addEventListener('click', async () => {
        const modelId = wrap.querySelector(`[data-new-model="${escapeHtml(prov.id)}"]`).value.trim();
        if (!modelId) return;
        const r = await window.desktop.configAddModel({ providerId: prov.id, modelId });
        toast(r.ok ? '已添加模型（重启生效）' : `失败：${r.error}`, r.ok ? 'ok' : 'err');
        if (r.ok) renderCfg();
      });
      wrap.querySelectorAll('[data-rm-model]').forEach((b) => {
        b.addEventListener('click', async () => {
          const [pid, mid] = b.dataset.rmModel.split('::');
          const r = await window.desktop.configRemoveModel({ providerId: pid, modelId: mid });
          toast(r.ok ? '已移除' : `失败：${r.error}`, r.ok ? 'ok' : 'err');
          if (r.ok) renderCfg();
        });
      });
    }
    body.insertAdjacentHTML('beforeend', `
      <div class="cfg-add-row">
        <input id="cfg-prov-name" placeholder="Provider ID（小写连字符）" />
        <input id="cfg-prov-display" placeholder="显示名" />
      </div>
      <div class="cfg-add-row">
        <input id="cfg-prov-url" placeholder="Base URL，如 https://api.xxx.com/v1" style="flex:1.4" />
        <input id="cfg-prov-key" type="password" placeholder="API Key" style="flex:1" />
      </div>
      <div class="cfg-add-row">
        <button class="mini-btn" id="cfg-prov-add">添加并自动检测模型</button>
      </div>
      <div class="appr-empty" style="font-size:11px">添加 Provider 时填 API Key，会自动调用 /v1/models 检测可用模型并填入。</div>`);
    body.querySelector('#cfg-prov-add').addEventListener('click', async () => {
      const id = $('cfg-prov-name').value.trim();
      const url = $('cfg-prov-url').value.trim();
      const key = $('cfg-prov-key').value.trim();
      if (!id || !url) { toast('ID 与 Base URL 必填', 'err'); return; }
      if (!key) { toast('请填写 API Key（用于自动检测模型）', 'err'); return; }
      const btn = $('cfg-prov-add');
      btn.textContent = '检测中…'; btn.disabled = true;
      const r = await window.desktop.configAddProvider({ id, displayName: $('cfg-prov-display').value.trim() || id, baseURL: url, apiKey: key });
      btn.textContent = '添加并自动检测模型'; btn.disabled = false;
      if (r.ok) toast(r.modelsDetected?.length ? `已添加 Provider，检测到 ${r.modelsDetected.length} 个模型` : '已添加（未能自动检测模型，可手动添加）', r.modelsDetected?.length ? 'ok' : 'err');
      else toast(`失败：${r.error}`, 'err');
      if (r.ok) renderCfg();
    });
  }
}

function openConfig() {
  $('cfg-mask').classList.remove('hidden');
  void $('cfg-mask').offsetWidth;
  $('cfg-mask').classList.add('visible');
  renderCfg();
}

function closeConfig() {
  $('cfg-mask').classList.remove('visible');
  setTimeout(() => $('cfg-mask').classList.add('hidden'), 220);
}

document.querySelectorAll('[data-cfg]').forEach((b) => {
  b.addEventListener('click', () => {
    cfgTab = b.dataset.cfg;
    document.querySelectorAll('[data-cfg]').forEach((x) => x.classList.toggle('active', x === b));
    renderCfg();
  });
});
$('btn-cfg-close').addEventListener('click', closeConfig);
$('cfg-mask').addEventListener('click', (e) => { if (e.target === $('cfg-mask')) closeConfig(); });

// ---------------- 按钮 ----------------
$('btn-command').addEventListener('click', openPalette);
$('btn-approvals').addEventListener('click', openApprovals);
$('btn-appr-close').addEventListener('click', closeApprovals);
$('appr-mask').addEventListener('click', (e) => { if (e.target === $('appr-mask')) closeApprovals(); });
$('btn-search').addEventListener('click', openSearch);
$('search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); if (e.key === 'Escape') closeSearch(); });
$('search-mask').addEventListener('click', (e) => { if (e.target === $('search-mask')) closeSearch(); });
$('btn-sessions').addEventListener('click', openSessions);
$('btn-subagents').addEventListener('click', openSubagents);
$('btn-subagent-close').addEventListener('click', closeSubagents);
$('subagent-root').addEventListener('change', renderSubagentTree);
$('subagent-mask').addEventListener('click', (e) => { if (e.target === $('subagent-mask')) closeSubagents(); });
$('btn-assets').addEventListener('click', openAssets);
$('btn-agents').addEventListener('click', openAgents);
$('btn-agent-close').addEventListener('click', closeAgents);
$('agent-mask').addEventListener('click', (e) => { if (e.target === $('agent-mask')) closeAgents(); });
$('btn-memory').addEventListener('click', openMemory);
$('btn-memory-close').addEventListener('click', closeMemory);
$('btn-memory-new').addEventListener('click', () => { memoryEditingId = null; renderMemoryEditor(null); });
$('memory-search').addEventListener('input', renderMemoryList);
$('memory-mask').addEventListener('click', (e) => { if (e.target === $('memory-mask')) closeMemory(); });
// 子代理委派
$('btn-subagent-send').addEventListener('click', delegateToSubagent);
$('subagent-delegate-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') delegateToSubagent(); });
$('btn-assets-close').addEventListener('click', closeAssets);
$('assets-search').addEventListener('input', renderAssets);
$('assets-mask').addEventListener('click', (e) => { if (e.target === $('assets-mask')) closeAssets(); });
$('btn-sess-close').addEventListener('click', closeSessions);
$('sess-mask').addEventListener('click', (e) => { if (e.target === $('sess-mask')) closeSessions(); });
$('btn-sess-new').addEventListener('click', async () => {
  const cwd = $('sess-new-cwd').value.trim();
  const r = await window.desktop.sessionCreate({ cwd: cwd || undefined });
  toast(r.ok ? `已创建会话 ${String(r.sessionId).slice(0, 12)}…` : `失败：${r.error}`, r.ok ? 'ok' : 'err');
  if (r.ok) {
    $('sess-new-cwd').value = '';
    refreshSessions();
  }
});
$('btn-board').addEventListener('click', openBoard);
$('btn-board-close').addEventListener('click', closeBoard);
$('btn-board-refresh').addEventListener('click', () => {
  producedCache.clear();
  loadBoard();
});
$('btn-board-stats').addEventListener('click', openStats);
$('btn-stats').addEventListener('click', openStats);
$('btn-stats-close').addEventListener('click', closeStats);
$('stats-mask').addEventListener('click', (e) => { if (e.target === $('stats-mask')) closeStats(); });
document.querySelectorAll('[data-sdim]').forEach((b) => {
  b.addEventListener('click', () => {
    statsDim = b.dataset.sdim;
    document.querySelectorAll('[data-sdim]').forEach((x) => x.classList.toggle('active', x === b));
    renderStats();
  });
});
function openBoardAi() {
  $('board-ai-mask').classList.remove('hidden');
  void $('board-ai-mask').offsetWidth;
  $('board-ai-mask').classList.add('visible');
  const today = new Date();
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  $('ai-from').value = `${weekAgo.getFullYear()}-${String(weekAgo.getMonth() + 1).padStart(2, '0')}-${String(weekAgo.getDate()).padStart(2, '0')}`;
  $('ai-to').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}
$('btn-board-ai').addEventListener('click', openBoardAi);
$('btn-ai-close').addEventListener('click', () => {
  $('board-ai-mask').classList.remove('visible');
  setTimeout(() => $('board-ai-mask').classList.add('hidden'), 220);
});
$('board-ai-mask').addEventListener('click', (e) => { if (e.target === $('board-ai-mask')) { $('board-ai-mask').classList.remove('visible'); setTimeout(() => $('board-ai-mask').classList.add('hidden'), 220); } });
$('btn-ai-run').addEventListener('click', runPeriodSummary);
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
  $('ts-state').textContent = labels[st.state] || st.state;
  $('ts-state').style.color = st.state === 'running' ? 'var(--ok)' : st.state === 'error' ? 'var(--err)' : '';
  const custom = st.customUrl || '';
  const cfUrl = st.source === 'cloudflared' ? st.url : '';
  const frpUrl = st.frpRunning && st.frpUrl ? st.frpUrl : '';
  const sshUrl = st.sshRunning && st.sshUrl ? st.sshUrl : '';
  const displayUrl = sshUrl || frpUrl || custom || cfUrl;
  // 同步自定义地址输入框（仅当未聚焦时，避免打断用户输入）
  const cust = document.getElementById('tunnel-custom-url');
  if (cust && document.activeElement !== cust) {
    cust.value = custom;
  }
  $('ts-url-row').classList.toggle('hidden', !displayUrl);
  $('ts-url').textContent = displayUrl || '';
  $('ts-source-row').classList.toggle('hidden', !displayUrl);
  $('ts-source').textContent = sshUrl ? 'SSH 隧道' : (frpUrl ? 'frp（自有服务器）' : (custom ? '自定义（自有域名）' : (cfUrl ? 'Cloudflare 隧道' : '')));
  $('ts-qr').classList.toggle('hidden', !displayUrl);
  // Cloudflare 按钮反映其自身状态；自定义地址存在时启动按钮降级为备用
  $('btn-tunnel-start').classList.toggle('hidden', st.state === 'running' || st.state === 'starting');
  $('btn-tunnel-stop').classList.toggle('hidden', st.state !== 'running' && st.state !== 'starting');
  $('btn-tunnel-copy').classList.toggle('hidden', !displayUrl);
  $('tunnel-custom-hint').classList.toggle('hidden', !custom);
  $('btn-tunnel-start').textContent = custom ? 'Cloudflare 备用' : '启动 Cloudflare 隧道';
  if (displayUrl) {
    const qr = await window.desktop.tunnelQr();
    if (qr.ok) $('ts-qr').src = qr.dataUrl;
  }
}
$('btn-tunnel-start').addEventListener('click', async () => {
  $('ts-state').textContent = '下载/启动中…';
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
    toast(st.source === 'custom' ? '自定义地址生效，用手机扫码即可访问' : '公网隧道已建立，用手机扫码即可访问');
  } else if (st.state === 'error') {
    toast(`隧道失败：${st.error || '未知错误'}（请检查网络能否访问 Cloudflare）`, 'err');
  }
});
$('btn-tunnel-stop').addEventListener('click', async () => {
  await window.desktop.tunnelStop();
  toast('Cloudflare 隧道已停止');
  refreshTunnel();
});
$('btn-tunnel-copy').addEventListener('click', async () => {
  const st = await window.desktop.tunnelStatus();
  const url = st.customUrl || st.url;
  if (url) {
    navigator.clipboard.writeText(url);
    toast('公网地址已复制');
  }
});
// 自定义公网地址保存
$('btn-tunnel-custom-save').addEventListener('click', async () => {
  const url = $('tunnel-custom-url').value.trim();
  const r = await window.desktop.tunnelCustomUrl(url);
  if (r.ok) {
    toast(url ? '自定义公网地址已保存，立即生效' : '已清除自定义地址');
    refreshTunnel();
  } else {
    toast(`保存失败：${r.error}`, 'err');
  }
});
// Tailscale 检测（移动网访问零依赖备选）
async function refreshTailscale() {
  try {
    const r = await window.desktop.tailscaleStatus();
    if (r.ok && r.installed) {
      $('tailscale-row').classList.remove('hidden');
      $('tailscale-url').textContent = r.url;
    } else {
      $('tailscale-row').classList.add('hidden');
    }
  } catch {}
}

// ---- SSH 反向隧道 ----
async function refreshSsh() {
  try {
    const r = await window.desktop.sshStatus();
    if (!r.ok) { $('ssh-status').textContent = `读取失败：${r.error}`; return; }
    const c = r.config || {}, s = r.status || {};
    // 仅在已有保存配置时才覆盖表单（否则保留 HTML 预填的默认值）
    if (c.server) { if (document.activeElement !== $('ssh-server')) $('ssh-server').value = c.server; }
    if (c.user) { if (document.activeElement !== $('ssh-user')) $('ssh-user').value = c.user; }
    if (c.keyPath) { if (document.activeElement !== $('ssh-key')) $('ssh-key').value = c.keyPath; }
    if (c.remotePort) { if (document.activeElement !== $('ssh-remote-port')) $('ssh-remote-port').value = c.remotePort; }
    if (c.domain) { if (document.activeElement !== $('ssh-domain')) $('ssh-domain').value = c.domain; }
    // 状态综合判定：运行中 > 错误 > 已配置 > 表单有值(待启动) > 未配置
    // 表单有值时即使 settings 未同步也提示"已填好"，避免误导为"未配置"
    const formReady = !!(($('ssh-server').value || '').trim() && ($('ssh-key').value || '').trim());
    let label = '未配置';
    if (s.running) label = `运行中${s.url ? ' → ' + s.url : ''}`;
    else if (s.error) label = `错误：${s.error}`;
    else if (s.configured) label = '已配置，未连接';
    else if (formReady) label = '已填好，点击「启动 SSH 隧道」';
    $('ssh-status').textContent = label;
    $('ssh-status').style.color = s.running ? 'var(--ok)' : s.error ? 'var(--err)' : (s.configured || formReady ? '' : '');
    $('btn-ssh-start').classList.toggle('hidden', !!s.running);
    $('btn-ssh-stop').classList.toggle('hidden', !s.running);
  } catch {}
}
window.sshSaveClick = async function sshSaveClick() {
  const cfg = {
    server: $('ssh-server').value.trim(),
    user: $('ssh-user').value.trim() || 'root',
    keyPath: $('ssh-key').value.trim(),
    remotePort: $('ssh-remote-port').value,
    domain: $('ssh-domain').value.trim(),
  };
  if (!cfg.server) { toast('请填写服务器地址', 'err'); return; }
  if (!cfg.keyPath) { toast('请填写私钥路径', 'err'); return; }
  const r = await window.desktop.sshSave(cfg);
  if (r.ok) { toast('SSH 隧道配置已保存', 'ok'); refreshSsh(); refreshTunnel(); }
  else toast(`保存失败：${r.error}`, 'err');
};
window.sshStartClick = async function sshStartClick() {
  // 先尝试保存当前表单（未保存过时自动保存，避免"先保存再启动"两步骤）
  const cfg = {
    server: $('ssh-server').value.trim(),
    user: $('ssh-user').value.trim() || 'root',
    keyPath: $('ssh-key').value.trim(),
    remotePort: $('ssh-remote-port').value,
    domain: $('ssh-domain').value.trim(),
  };
  if (cfg.server && cfg.keyPath) {
    const saved = await window.desktop.sshSave(cfg);
    if (!saved.ok) { $('ssh-status').textContent = `配置无效：${saved.error}`; $('ssh-status').style.color = 'var(--err)'; return; }
  }
  $('ssh-status').textContent = '连接中…';
  $('ssh-status').style.color = '';
  try {
    const r = await window.desktop.sshStart();
    if (!r.ok) {
      $('ssh-status').textContent = `启动失败：${r.error}`;
      $('ssh-status').style.color = 'var(--err)';
      toast(`SSH 隧道启动失败：${r.error}`, 'err');
    } else {
      toast('SSH 隧道已建立，手机可访问 ' + (r.status?.url || ''));
    }
  } catch (e) {
    $('ssh-status').textContent = `启动异常：${String(e.message || e)}`;
    $('ssh-status').style.color = 'var(--err)';
  }
  refreshSsh();
  refreshTunnel();
};
window.sshStopClick = async function sshStopClick() {
  await window.desktop.sshStop();
  toast('SSH 隧道已停止');
  refreshSsh();
  refreshTunnel();
};
// 点击处理由 document 级 [data-sb-action] 事件委托统一触发（见文件底部），
// 此处不再直接绑定，避免与委托双触发。

// ---- frp 内网穿透 ----
async function refreshFrp() {
  try {
    const r = await window.desktop.frpStatus();
    if (!r.ok) { $('frp-status').textContent = `读取失败：${r.error}`; return; }
    const c = r.config || {}, s = r.status || {};
    if (document.activeElement !== $('frp-server')) $('frp-server').value = c.server || '';
    if (document.activeElement !== $('frp-bind-port')) $('frp-bind-port').value = c.bindPort || 7000;
    if (document.activeElement !== $('frp-remote-port')) $('frp-remote-port').value = c.remotePort || 8080;
    if (document.activeElement !== $('frp-domain')) $('frp-domain').value = c.domain || '';
    if (document.activeElement !== $('frp-token')) $('frp-token').value = c.token || '';
    $('frp-status').textContent = s.running ? `运行中${s.url ? ' → ' + s.url : ''}` : (s.error ? `错误：${s.error}` : (s.configured ? '已配置，未连接' : '未配置'));
    $('frp-status').style.color = s.running ? 'var(--ok)' : s.error ? 'var(--err)' : '';
    $('btn-frp-start').classList.toggle('hidden', !!s.running);
    $('btn-frp-stop').classList.toggle('hidden', !s.running);
  } catch {}
}
$('btn-frp-save').addEventListener('click', async () => {
  const cfg = {
    server: $('frp-server').value.trim(),
    bindPort: $('frp-bind-port').value,
    remotePort: $('frp-remote-port').value,
    domain: $('frp-domain').value.trim(),
    token: $('frp-token').value,
  };
  if (!cfg.server) { toast('请填写服务器地址', 'err'); return; }
  if (!cfg.token) { toast('请填写 frp token', 'err'); return; }
  const r = await window.desktop.frpSave(cfg);
  if (r.ok) { toast('frp 配置已保存', 'ok'); refreshFrp(); refreshTunnel(); }
  else toast(`保存失败：${r.error}`, 'err');
});
$('btn-frp-start').addEventListener('click', async () => {
  $('frp-status').textContent = '连接中…';
  const r = await window.desktop.frpStart();
  if (!r.ok) { toast(`frp 启动失败：${r.error}`, 'err'); }
  else { toast('frp 连接已建立，手机可访问 ' + (r.status?.url || '')); }
  refreshFrp();
  refreshTunnel();
});
$('btn-frp-stop').addEventListener('click', async () => {
  await window.desktop.frpStop();
  toast('frp 已停止');
  refreshFrp();
  refreshTunnel();
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
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    openSearch();
  }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    openSessions();
  }
  if (e.key === 'Escape') {
    if (!$('palette-mask').classList.contains('hidden')) closePalette();
    else if (!$('board-mask').classList.contains('hidden')) closeBoard();
    else if (!$('skill-mask').classList.contains('hidden')) closeSkillPanel();
    else if (!$('drawer-mask').classList.contains('hidden')) closeDrawer();
    else if (!$('model-picker').classList.contains('hidden')) closeModelPicker();
    else if (!$('search-mask').classList.contains('hidden')) closeSearch();
    else if (!$('sess-mask').classList.contains('hidden')) closeSessions();
    else if (!$('appr-mask').classList.contains('hidden')) closeApprovals();
    else if (!$('subagent-mask').classList.contains('hidden')) closeSubagents();
    else if (!$('assets-mask').classList.contains('hidden')) closeAssets();
    else if (!$('agent-mask').classList.contains('hidden')) closeAgents();
    else if (!$('memory-mask').classList.contains('hidden')) closeMemory();
    else if (!$('stats-mask').classList.contains('hidden')) closeStats();
  }
});

$('palette-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runCommand();
  if (e.key === 'Escape') closePalette();
});

// ---------------- 启动 ----------------
setupBoardInteractions();
bindUiCustomEvents();
// 设置抽屉 tab 切换
function setDrawerTab(tab) {
  document.querySelectorAll('.dtab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.drawer-pane').forEach((p) => p.classList.toggle('active', p.id === `pane-${tab}`));
  if (tab === 'services') {
    renderMcp();
    window.desktop.pickerBackend().then((r) => {
      if (r.ok && document.getElementById('set-picker')) document.getElementById('set-picker').value = r.backend;
    }).catch(() => {});
  }
}

// dtab 点击绑定（曾因误删丢失导致其他 tab 无法切换）
document.querySelectorAll('.dtab').forEach((btn) => {
  btn.addEventListener('click', () => setDrawerTab(btn.dataset.tab));
});

// 终极兜底：document 级事件委托，保证工具条按钮点击必然生效
document.addEventListener('click', (e) => {
  const t = e.target && e.target.closest ? e.target.closest('[data-sb-action]') : null;
  if (!t) return;
  const fn = window[t.dataset.sbAction];
  if (typeof fn === 'function') { e.preventDefault(); fn(); }
}, true);

// 防御性重绑：确保工具条/关键按钮点击绑定在任何初始化竞态后依然有效
(function rebindCritical() {
  const pairs = [
    ['btn-stats', 'openStats'], ['btn-board-stats', 'openStats'], ['btn-board-ai', 'openBoardAi'],
    ['btn-agents', 'openAgents'], ['btn-memory', 'openMemory'], ['btn-subagents', 'openSubagents'],
    ['btn-assets', 'openAssets'], ['btn-approvals', 'openApprovals'], ['btn-sessions', 'openSessions'],
    ['btn-board', 'openBoard'], ['btn-skill', 'openSkillPanel'], ['btn-command', 'openPalette'],
  ];
  for (const [id, fn] of pairs) {
    const el = document.getElementById(id);
    if (el && typeof window[fn] === 'function') el.addEventListener('click', window[fn]);
  }
})();

(async function init() {
  const v = document.getElementById('app-version');
  if (v) {
    try { const vi = await window.desktop.appVersion(); v.textContent = 'v' + (vi?.version || ''); } catch {}
  }
  const s = await window.desktop.getSettings();
  settings = s;
  applyThemeSource(s.themeSource || 'system');
  applyUiCustom(s.uiCustom || {});
  renderState(await window.desktop.getState());
  window.desktop.listSessions().then(updateSessions).catch(() => {});
  initOnboarding();
})();
