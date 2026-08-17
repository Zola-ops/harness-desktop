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
</script>`;

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
      const upstream = http.request({
        host: hostname,
        port: Number(hport),
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `${hostname}:${hport}`, 'accept-encoding': 'identity' },
      }, (ures) => {
        const headers = {
          ...ures.headers,
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'access-control-allow-headers': '*',
          'access-control-expose-headers': '*',
        };
        // 给 HTML 页面注入 crypto.randomUUID polyfill（兼容旧版手机浏览器）
        const isHtml = (ures.headers['content-type'] || '').includes('text/html');
        if (isHtml && req.method === 'GET') {
          let body = '';
          ures.on('data', (c) => { body += c; });
          ures.on('end', () => {
            const injected = body.includes('</head>')
              ? body.replace('</head>', `${RANDOM_UUID_POLYFILL}</head>`)
              : body;
            res.writeHead(ures.statusCode, { ...headers, 'content-length': Buffer.byteLength(injected) });
            res.end(injected);
          });
          ures.on('error', () => res.end());
          return;
        }
        res.writeHead(ures.statusCode, headers);
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

  // ================= 公网隧道（cloudflared quick tunnel，供移动网访问） =================
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
      const proc = spawn(bin, ['tunnel', '--url', this.harness.url, '--no-autoupdate'], {
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
    return {
      state: this.tunnelState,
      url: this.tunnelUrl,
      error: this.tunnelError,
    };
  }
}

module.exports = { LanService };
