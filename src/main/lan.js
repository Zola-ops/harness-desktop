// LanService：局域网联动 —— 把本机 harness 通过 0.0.0.0 端口暴露给同一 Wi-Fi 下的移动设备
// 实现：HTTP + WebSocket 透明代理转发到 127.0.0.1:<harnessPort>，并追加 CORS 头
// 安全提示：harness 具备执行命令能力，请仅在可信局域网内开启，用后即关。
'use strict';

const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const QRCode = require('qrcode');

// 注入到 harness HTML 页面的 polyfill：旧版手机浏览器没有 crypto.randomUUID
const RANDOM_UUID_POLYFILL = `<script>
(function(){if(window.crypto&&typeof window.crypto.randomUUID!=='function'){try{Object.defineProperty(window.crypto,'randomUUID',{value:function(){var b=new Uint8Array(16);window.crypto.getRandomValues(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h=Array.prototype.map.call(b,function(x){return('0'+x.toString(16)).slice(-2)}).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20)},configurable:true})}catch(e){}}})();
</script>
<style>
/* web 端宽度适配：宽屏充分利用宽度，窄屏(手机)全宽自适应 */
:root{
  --dsh-chat-content-width: min(1280px, 94vw) !important;
  --dsh-composer-card-max-width: min(1280px, 94vw) !important;
}
@media (max-width: 900px){
  :root{
    --dsh-chat-content-width: 100vw !important;
    --dsh-composer-card-max-width: 100vw !important;
  }
  .conversation, [class*='conversation']{ width: 100% !important; padding-left: 12px !important; padding-right: 12px !important; }
}
</style>`;


class LanService extends EventEmitter {
  constructor(settings, harness, app) {
    super();
    this.settings = settings;
    this.harness = harness;
    this.app = app; // Electron app（用于 userData 路径）
    this.server = null;
    this.listenPort = 0;
    this.lastError = '';
    // 公网隧道（cloudflared quick tunnel）
    this.tunnelProc = null;
    this.tunnelUrl = '';
    this.tunnelState = 'stopped'; // stopped | starting | running | error
    this.tunnelError = '';
    // frp 内网穿透进程
    this.frpProc = null;
    this.frpError = '';
    // SSH 反向隧道进程
    this.sshProc = null;
    this.sshError = '';
    // 目录选择器自动修正钩子：由 index.js 注入，隧道启动前调用
    // native 模式在 Mac 本机弹系统目录对话框、结果回传远程页面 —— 本地/隧道都适用；
    // browse 模式（auto 在远程的 fallback）会让 /api/host.pickDirectory 返回 403。
    this.ensureNativePicker = null;
  }

  setPickerEnsurer(fn) {
    this.ensureNativePicker = fn;
  }

  lanIps() {
    const out = [];
    const ifaces = os.networkInterfaces();
    for (const [name, addrs] of Object.entries(ifaces || {})) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal && !/^(bridge|utun|awdl|llw|anpi|en0-p2p)/i.test(name)) {
          out.push({ name, address: a.address });
        }
      }
    }
    return out;
  }

  urlFor(ip) {
    return `http://${ip}:${this.listenPort || this.settings.get().lan.port}`;
  }

  isRunning() {
    return !!this.server;
  }

  status() {
    return {
      running: this.isRunning(),
      port: this.listenPort || this.settings.get().lan.port,
      ips: this.lanIps(),
      error: this.lastError,
      harnessUrl: this.harness.url,
    };
  }

  async start() {
    if (this.server) return true;
    const port = this.settings.get().lan.port || 3180;
    const harness = this.harness;

    const server = http.createServer((req, res) => {
      const target = harness.url;
      if (!target) {
        res.writeHead(503, { 'access-control-allow-origin': '*' });
        res.end('harness 未运行');
        return;
      }
      // CORS 预检
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'access-control-allow-headers': '*',
          'access-control-max-age': '600',
        });
        res.end();
        return;
      }
      const { hostname, port: hport } = new URL(target);
      // 覆盖 Origin/Referer 为本地 harness 地址：harness 对远程来源的
      // host.*/settings.*/agentPreset.* 等 RPC 有信任栅栏（403），
      // 手机经隧道访问时浏览器 Origin 是公网域名，会被判定非本地来源。
      const localOrigin = `${target.endsWith('/') ? target.slice(0, -1) : target}`;
      const fwdHeaders = {
        ...req.headers,
        host: `${hostname}:${hport}`,
        'accept-encoding': 'identity',
      };
      if (fwdHeaders.origin) fwdHeaders.origin = localOrigin;
      if (fwdHeaders.referer) {
        try { fwdHeaders.referer = new URL(fwdHeaders.referer).pathname ? localOrigin + new URL(fwdHeaders.referer).pathname : fwdHeaders.referer; } catch { fwdHeaders.referer = localOrigin; }
      }
      const upstream = http.request({
        host: hostname,
        port: Number(hport),
        path: req.url,
        method: req.method,
        headers: fwdHeaders,
      }, (ures) => {
        const headers = {
          ...ures.headers,
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'access-control-allow-headers': '*',
          'access-control-expose-headers': '*',
        };
        // 给 HTML 页面注入 crypto.randomUUID polyfill（兼容旧版手机浏览器）
        // 注意：注入后 body 已完整收集，必须剥离上游 transfer-encoding/content-length，
        // 否则 chunked 与 content-length 并存会让反向代理（nginx 等）报 502。
        const isHtml = (ures.headers['content-type'] || '').includes('text/html');
        if (isHtml && req.method === 'GET') {
          let body = '';
          ures.on('data', (c) => { body += c; });
          ures.on('end', () => {
            const injected = body.includes('</head>')
              ? body.replace('</head>', `${RANDOM_UUID_POLYFILL}</head>`)
              : body;
            const h = { ...headers };
            delete h['transfer-encoding'];
            delete h['content-length'];
            res.writeHead(ures.statusCode, { ...h, 'content-length': Buffer.byteLength(injected) });
            res.end(injected);
          });
          ures.on('error', () => res.end());
          return;
        }
        // 非 HTML：同样剥离传输头，避免透传 chunked 时与 Node 自动生成的头冲突
        const h2 = { ...headers };
        delete h2['transfer-encoding'];
        delete h2['content-length'];
        res.writeHead(ures.statusCode, h2);
        ures.pipe(res);
      });
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'access-control-allow-origin': '*' });
        res.end('proxy upstream error');
      });
      req.pipe(upstream);
    });

    // WebSocket 升级转发（/api/events.mux、/api/events.host 等）
    server.on('upgrade', (req, socket, head) => {
      const target = harness.url;
      if (!target) {
        socket.end();
        return;
      }
      const { hostname, port: hport } = new URL(target);
      const upstream = http.request({
        host: hostname,
        port: Number(hport),
        path: req.url,
        method: 'GET',
        headers: { ...req.headers, host: `${hostname}:${hport}` },
      });
      upstream.on('upgrade', (ures, usocket, uhead) => {
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          `Upgrade: ${ures.headers.upgrade || 'websocket'}\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Accept: ${ures.headers['sec-websocket-accept'] || ''}\r\n` +
          'Access-Control-Allow-Origin: *\r\n' +
          '\r\n'
        );
        if (uhead && uhead.length) socket.write(uhead);
        usocket.pipe(socket);
        socket.pipe(usocket);
        usocket.on('error', () => socket.destroy());
        socket.on('error', () => usocket.destroy());
      });
      upstream.on('error', () => socket.destroy());
      if (head && head.length) upstream.write(head);
      upstream.end();
    });

    await new Promise((resolve, reject) => {
      server.once('error', (err) => {
        this.lastError = `无法绑定端口 ${port}：${err.message}`;
        reject(err);
      });
      server.listen(port, '0.0.0.0', () => {
        server.removeListener('error', reject);
        this.lastError = '';
        resolve();
      });
    });

    this.server = server;
    this.listenPort = port;
    this.emit('status', this.status());
    return true;
  }

  stop() {
    if (!this.server) return;
    try {
      this.server.close();
    } catch {}
    this.server = null;
    this.listenPort = 0;
    this.emit('status', this.status());
  }

  async qrDataUrl(url) {
    if (!url) throw new Error('没有可用的访问地址');
    return QRCode.toDataURL(url, { margin: 1, width: 320, color: { dark: '#111418', light: '#ffffff' } });
  }

  // ================= 公网隧道（cloudflared quick tunnel / 自定义公网地址） =================
  // 自定义公网地址：自有域名（SSH 反向隧道 / frp / Cloudflare named tunnel）映射到本机后的 URL
  customTunnelUrl() {
    return (this.settings.get().lan.customTunnelUrl || '').trim();
  }

  // 设置自定义公网地址
  setCustomTunnelUrl(url) {
    const clean = (url || '').trim().replace(/\/+$/, '');
    if (clean && !/^https?:\/\//i.test(clean)) {
      throw new Error('自定义地址需以 http:// 或 https:// 开头');
    }
    this.settings.set({ lan: { ...this.settings.get().lan, customTunnelUrl: clean } });
    this.emit('tunnel-status', this.tunnelStatus());
    return { ok: true, url: clean };
  }

  // 检测本机 Tailscale 状态（tailscale ip -4），作为移动网访问的零依赖备选
  tailscaleStatus() {
    return new Promise((resolve) => {
      execFile('tailscale', ['ip', '-4'], { timeout: 4000 }, (err, stdout) => {
        if (err || !stdout) { resolve({ installed: false, ip: '' }); return; }
        const ip = (stdout.trim().split(/\s+/)[0] || '').trim();
        resolve({ installed: !!ip, ip });
      });
    });
  }

  // 统一公网访问地址：SSH 隧道 → frp → 自定义地址 → cloudflared
  publicUrl() {
    const ssh = this.sshStatus();
    if (ssh.running && ssh.url) return ssh.url;
    const frp = this.frpStatus();
    if (frp.running && frp.url) return frp.url;
    return this.customTunnelUrl() || this.tunnelUrl;
  }

  // ================= frp 内网穿透（推荐：自持服务器 + 自有域名） =================
  frpConfig() {
    return this.settings.get().lan.frp || {};
  }

  frpUrl() {
    const c = this.frpConfig();
    return c.domain ? `https://${c.domain}` : '';
  }

  frpProcPath() {
    return path.join(this.app.getPath('userData'), 'frp', process.arch === 'arm64' ? 'frpc-darwin-arm64' : 'frpc-darwin-amd64');
  }

  hasFrpc() {
    return fs.existsSync(this.frpProcPath());
  }

  async ensureFrpc() {
    if (this.hasFrpc()) return this.frpProcPath();
    // 从 GitHub releases 拉最新 frp（darwin 对应系统架构）
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const ver = await fetch('https://api.github.com/repos/fatedier/frp/releases/latest')
      .then((r) => r.json()).then((j) => j.tag_name || 'v0.61.1')
      .catch(() => 'v0.61.1');
    const base = ver.replace(/^v/, '');
    const url = `https://github.com/fatedier/frp/releases/download/${ver}/frp_${base}_darwin_${arch}.tar.gz`;
    const dir = path.dirname(this.frpProcPath());
    fs.mkdirSync(dir, { recursive: true });
    const tgz = path.join(dir, 'frp.tgz');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载 frpc 失败（HTTP ${res.status}，请检查网络能否访问 GitHub）`);
    fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
    // 解压 tar.gz：包内是 frp_<ver>_darwin_<arch>/frpc
    const zlib = require('node:zlib');
    const tarBuf = zlib.gunzipSync(fs.readFileSync(tgz));
    let off = 0;
    const found = [];
    while (off + 512 <= tarBuf.length) {
      const name = tarBuf.subarray(off, off + 100).toString('utf8').replace(/\0.*$/, '');
      const sizeStr = tarBuf.subarray(off + 124, off + 136).toString('utf8').replace(/\0.*$/, '').trim();
      const size = parseInt(sizeStr, 8) || 0;
      const type = String.fromCharCode(tarBuf[off + 156] || 48);
      if (name && type === '0' && /\/frpc$/.test(name)) {
        const content = tarBuf.subarray(off + 512, off + 512 + size);
        fs.writeFileSync(this.frpProcPath(), content);
        fs.chmodSync(this.frpProcPath(), 0o755);
        found.push(this.frpProcPath());
        break;
      }
      off += 512 + Math.ceil(size / 512) * 512;
    }
    fs.rmSync(tgz, { force: true });
    if (!found.length) throw new Error('frp 下载包解析失败');
    return this.frpProcPath();
  }

  // 保存 frp 配置（server / bindPort / remotePort / token / domain）
  frpSave(cfg = {}) {
    const cur = this.frpConfig();
    const next = {
      ...cur,
      server: (cfg.server || cur.server || '').trim(),
      bindPort: Number(cfg.bindPort || cur.bindPort || 7000),
      remotePort: Number(cfg.remotePort || cur.remotePort || 8080),
      token: (cfg.token !== undefined ? String(cfg.token) : cur.token || '').trim(),
      domain: (cfg.domain || cur.domain || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    };
    if (next.server && !/^[a-zA-Z0-9.\-:]+$/.test(next.server)) throw new Error('服务器地址格式不正确');
    this.settings.set({ lan: { ...this.settings.get().lan, frp: next } });
    return { ok: true, ...next };
  }

  async frpStart() {
    const c = this.frpConfig();
    if (!c.server || !c.token) throw new Error('请先填写 frp 服务器地址与 token');
    if (this.frpProc) return { ok: true, running: true };
    const bin = await this.ensureFrpc();
    // 生成 frpc.toml
    const confPath = path.join(path.dirname(this.frpProcPath()), 'frpc.toml');
    const toml = `serverAddr = "${c.server}"
serverPort = ${c.bindPort || 7000}
auth.token = "${c.token}"

[[proxies]]
name = "dshz"
type = "tcp"
localIP = "127.0.0.1"
localPort = ${this.listenPort || this.settings.get().lan.port || 3180}
remotePort = ${c.remotePort || 8080}
`;
    fs.writeFileSync(confPath, toml);
    const proc = spawn(bin, ['-c', confPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.frpProc = proc;
    this.frpError = '';
    let errBuf = '';
    proc.stderr.on('data', (b) => { errBuf = (errBuf + b.toString()).slice(-2000); });
    proc.on('exit', (code) => {
      this.frpProc = null;
      this.frpError = errBuf.split('\n').find((l) => /error|fail/i.test(l)) || `frpc 退出（code=${code}）`;
      this.emit('tunnel-status', this.tunnelStatus());
    });
    // 等待 2 秒看是否存活
    await new Promise((r) => setTimeout(r, 2000));
    if (!this.frpProc) throw new Error(this.frpError || 'frpc 启动失败');
    return { ok: true, running: true };
  }

  frpStop() {
    if (this.frpProc) {
      try { this.frpProc.kill('SIGTERM'); } catch {}
      this.frpProc = null;
    }
    this.frpError = '';
    this.emit('tunnel-status', this.tunnelStatus());
    return { ok: true };
  }

  frpStatus() {
    return {
      running: !!this.frpProc,
      configured: !!(this.frpConfig().server && this.frpConfig().token),
      error: this.frpError || '',
      url: this.frpUrl(),
    };
  }

  // ================= SSH 反向隧道（复用 22 端口，服务器无需开新端口） =================
  sshConfig() {
    return this.settings.get().lan.sshTunnel || {};
  }

  // 应用启动时自动初始化 SSH 隧道默认配置（若完全未配置）
  // 背景：首次使用时 settings.json 里没有 sshTunnel，面板会显示"未配置"。
  // 这里在应用运行时写入（不受沙箱限制），让面板打开即为已配置状态。
  ensureSshDefaults() {
    const cur = this.sshConfig();
    if (cur.server && cur.keyPath) return; // 已配置
    if (cur.server || cur.keyPath) return; // 半配置：留给用户手动补全
    const candidates = [
      path.join(os.homedir(), '.ssh', 'id_rsa'),
      path.join(os.homedir(), '.ssh', 'id_rsa'),
      path.join(os.homedir(), '.ssh', 'id_ed25519'),
    ];
    const key = candidates.find((p) => fs.existsSync(p));
    if (!key) return; // 没有任何私钥可用，保持未配置
    const defaults = {
      server: 'YOUR_SERVER_IP',
      user: 'root',
      keyPath: key,
      remotePort: 8080,
      domain: 'dsh.example.com',
    };
    this.settings.set({ lan: { ...this.settings.get().lan, sshTunnel: defaults } });
    console.log('[lan] SSH 隧道默认配置已初始化：', defaults.server, defaults.keyPath);
  }

  sshUrl() {
    const c = this.sshConfig();
    return c.domain ? `https://${c.domain}` : '';
  }

  // 保存 SSH 隧道配置
  sshSave(cfg = {}) {
    const cur = this.sshConfig();
    const next = {
      ...cur,
      server: (cfg.server || cur.server || '').trim(),
      user: (cfg.user || cur.user || 'root').trim(),
      keyPath: (cfg.keyPath || cur.keyPath || '').trim(),
      remotePort: Number(cfg.remotePort || cur.remotePort || 8080),
      domain: (cfg.domain || cur.domain || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    };
    if (next.server && !/^[a-zA-Z0-9.\-:]+$/.test(next.server)) throw new Error('服务器地址格式不正确');
    if (next.keyPath && !fs.existsSync(next.keyPath.replace(/^~/, os.homedir()))) throw new Error(`私钥文件不存在：${next.keyPath}`);
    this.settings.set({ lan: { ...this.settings.get().lan, sshTunnel: next } });
    return { ok: true, ...next };
  }

  async sshStart() {
    const c = this.sshConfig();
    if (!c.server || !c.keyPath) throw new Error('请先填写服务器地址与私钥路径');
    if (this.sshProc) return { ok: true, running: true };
    const key = c.keyPath.replace(/^~/, os.homedir());
    if (!fs.existsSync(key)) throw new Error(`私钥文件不存在：${key}`);
    // SSH 隧道转发到本机 LAN 代理端口；若代理未运行，自动启动
    // （否则 3180 上无服务，隧道转发被拒绝 → 远程访问 502）
    if (!this.server) {
      try {
        await this.start();
        console.log('[lan] SSH 隧道：已自动启动 LAN 代理（端口 ' + (this.listenPort || this.settings.get().lan.port) + '）');
      } catch (err) {
        throw new Error(`SSH 隧道需要 LAN 代理，但启动失败：${err.message}`);
      }
    }
    const localPort = this.listenPort || this.settings.get().lan.port || 3180;
    // 目录选择器自动修正：远程访问（SSH 隧道）必须 native
    // （Mac 本机弹系统目录对话框、结果回传远程页面；auto/browse 在远程
    // fallback 到 browse → /api/host.pickDirectory 返回 403）
    if (typeof this.ensureNativePicker === 'function') {
      try { await this.ensureNativePicker(); } catch {}
    }
    // 自愈：服务器侧 8080 可能残留上次断开的隧道转发（应用被杀时 sshd 转发不释放），
    // 导致 remote port forwarding failed。先连服务器杀掉占用 8080 的残留 sshd 会话。
    try {
      const heal = await new Promise((resolve) => {
        execFile('ssh', [
          '-i', key, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=8',
          `${c.user || 'root'}@${c.server}`,
          'fuser -k 8080/tcp 2>/dev/null; ss -tlnp | grep 8080 || true',
        ], { timeout: 15000 }, (err, stdout) => resolve(stdout || ''));
      });
      if (/8080/.test(heal)) {
        // fuser 未成功或仍有残留，再尝试一次
        await new Promise((resolve) => {
          execFile('ssh', [
            '-i', key, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=8',
            `${c.user || 'root'}@${c.server}`,
            'pkill -f "sshd: root@notty" 2>/dev/null; sleep 1; ss -tlnp | grep 8080 || echo RELEASED',
          ], { timeout: 15000 }, (err, stdout) => resolve(stdout || ''));
        });
      }
    } catch {}
    const args = [
      '-i', key,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ConnectTimeout=10',
      '-N',
      '-R', `${c.remotePort || 8080}:127.0.0.1:${localPort}`,
      `${c.user || 'root'}@${c.server}`,
    ];
    const proc = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.sshProc = proc;
    this.sshError = '';
    let errBuf = '';
    proc.stderr.on('data', (b) => { errBuf = (errBuf + b.toString()).slice(-2000); });
    proc.on('exit', (code) => {
      this.sshProc = null;
      this.sshError = errBuf.split('\n').find((l) => /error|refused|denied|fail/i.test(l)) || `SSH 隧道退出（code=${code}）`;
      this.emit('tunnel-status', this.tunnelStatus());
    });
    // 等待 3 秒看是否存活（ssh -N 无输出时进程存活即连接保持）
    await new Promise((r) => setTimeout(r, 3000));
    if (!this.sshProc) throw new Error(this.sshError || 'SSH 隧道建立失败');
    return { ok: true, running: true };
  }

  sshStop() {
    if (this.sshProc) {
      try { this.sshProc.kill('SIGTERM'); } catch {}
      this.sshProc = null;
    }
    this.sshError = '';
    this.emit('tunnel-status', this.tunnelStatus());
    return { ok: true };
  }

  sshStatus() {
    return {
      running: !!this.sshProc,
      configured: !!(this.sshConfig().server && this.sshConfig().keyPath),
      error: this.sshError || '',
      url: this.sshUrl(),
    };
  }

  cloudflaredPath() {
    return path.join(this.app.getPath('userData'), 'cloudflared', 'cloudflared');
  }

  hasCloudflared() {
    return fs.existsSync(this.cloudflaredPath());
  }

  async ensureCloudflared() {
    // 1) PATH 里的 cloudflared
    const fromPath = await new Promise((resolve) => {
      execFile('which', ['cloudflared'], (err, stdout) => resolve(err ? '' : stdout.trim()));
    });
    if (fromPath) return fromPath;
    // 2) 已下载的本地二进制
    if (this.hasCloudflared()) return this.cloudflaredPath();
    // 3) 下载 darwin arm64 二进制（tgz）
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}.tgz`;
    const local = this.cloudflaredPath();
    const dir = path.dirname(local);
    fs.mkdirSync(dir, { recursive: true });
    const tgz = path.join(dir, 'cloudflared.tgz');
    this.lastError = '';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载 cloudflared 失败（HTTP ${res.status}）`);
    fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
    // 解压 tgz（zlib gunzip + tar 解析：tgz 内是一个可执行文件）
    const zlib = require('node:zlib');
    const tarBuf = zlib.gunzipSync(fs.readFileSync(tgz));
    // 简单 tar 解析：找第一个 regular file 条目
    let off = 0;
    let extracted = false;
    while (off + 512 <= tarBuf.length) {
      const name = tarBuf.subarray(off, off + 100).toString('utf8').replace(/\0.*$/, '');
      const sizeStr = tarBuf.subarray(off + 124, off + 136).toString('utf8').replace(/\0.*$/, '').trim();
      const size = parseInt(sizeStr, 8) || 0;
      const type = String.fromCharCode(tarBuf[off + 156] || 48);
      if (name && type === '0') {
        const content = tarBuf.subarray(off + 512, off + 512 + size);
        fs.writeFileSync(local, content);
        fs.chmodSync(local, 0o755);
        extracted = true;
        break;
      }
      off += 512 + Math.ceil(size / 512) * 512;
    }
    fs.rmSync(tgz, { force: true });
    if (!extracted) throw new Error('cloudflared 下载包解析失败');
    return local;
  }

  async tunnelStart() {
    if (this.tunnelProc) return { ok: true, url: this.tunnelUrl };
    this.tunnelState = 'starting';
    this.tunnelError = '';
    this.emit('tunnel-status', this.tunnelStatus());
    try {
      const bin = await this.ensureCloudflared();
      if (!this.harness.url) throw new Error('harness 未运行');
      // 目录选择器自动修正：隧道场景必须 native（Mac 本机弹窗，结果回传远程）。
      // auto/browse 在远程 fallback 到 browse → /api/host.pickDirectory 返回 403。
      if (typeof this.ensureNativePicker === 'function') {
        await this.ensureNativePicker();
      }
      // --protocol http2：强制走 TCP 443（QUIC/UDP 7844 在部分网络被阻会导致 error 1033）
      const proc = spawn(bin, ['tunnel', '--url', this.harness.url, '--protocol', 'http2', '--no-autoupdate'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.tunnelProc = proc;
      let errBuf = '';
      const onData = (buf) => {
        const text = buf.toString();
        errBuf = (errBuf + text).slice(-3000);
        const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m && !this.tunnelUrl) {
          this.tunnelUrl = m[0];
          this.tunnelState = 'running';
          this.emit('tunnel-status', this.tunnelStatus());
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('exit', (code) => {
        this.tunnelProc = null;
        if (this.tunnelUrl) {
          this.tunnelState = 'stopped';
          this.tunnelUrl = '';
        } else {
          this.tunnelState = 'error';
          // 提取 stderr 里的失败原因（如 Cloudflare API 超时/网络问题）
          const failLine = errBuf.split('\n').find((l) => /failed|error|timed? ?out|deadline/i.test(l));
          this.tunnelError = failLine ? failLine.trim().slice(0, 200) : `隧道进程退出（code=${code}）`;
        }
        this.emit('tunnel-status', this.tunnelStatus());
      });
      // 30 秒内没拿到 URL 视为失败
      const t0 = Date.now();
      const waiter = setInterval(() => {
        if (this.tunnelUrl) {
          clearInterval(waiter);
        } else if (Date.now() - t0 > 30000) {
          clearInterval(waiter);
          if (!this.tunnelUrl) {
            this.tunnelState = 'error';
            this.tunnelError = '隧道建立超时';
            this.emit('tunnel-status', this.tunnelStatus());
          }
        }
      }, 1000);
      return { ok: true };
    } catch (err) {
      this.tunnelState = 'error';
      this.tunnelError = String(err.message || err);
      this.emit('tunnel-status', this.tunnelStatus());
      return { ok: false, error: this.tunnelError };
    }
  }

  tunnelStop() {
    if (this.tunnelProc) {
      try {
        this.tunnelProc.kill('SIGTERM');
      } catch {}
      this.tunnelProc = null;
    }
    this.tunnelState = 'stopped';
    this.tunnelUrl = '';
    this.tunnelError = '';
    this.emit('tunnel-status', this.tunnelStatus());
  }

  tunnelStatus() {
    const custom = this.customTunnelUrl();
    const frp = this.frpStatus();
    const frpUrl = frp.running ? frp.url : '';
    const ssh = this.sshStatus();
    const sshUrl = ssh.running ? ssh.url : '';
    // 优先级：SSH 隧道（运行中）→ frp（运行中）→ 自定义地址 → cloudflared
    const source = sshUrl ? 'ssh' : (frpUrl ? 'frp' : (custom ? 'custom' : (this.tunnelUrl ? 'cloudflared' : '')));
    return {
      state: this.tunnelState,
      url: this.tunnelUrl,
      customUrl: custom,
      frpRunning: frp.running,
      frpConfigured: frp.configured,
      frpError: frp.error,
      frpUrl,
      sshRunning: ssh.running,
      sshConfigured: ssh.configured,
      sshError: ssh.error,
      sshUrl,
      source,
      error: this.tunnelError,
    };
  }
}

module.exports = { LanService };
