// HarnessManager：管理 `dsh web` 子进程的生命周期
// 状态机：stopped -> starting -> running | error
'use strict';

const { spawn, execFile } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DEFAULT_PORT, PORT_RANGE_MAX } = require('../shared/constants');

class HarnessManager extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.state = 'stopped';
    this.child = null;
    this.port = null;
    this.errorMessage = '';
    this._healthTimer = null;
    this._stopRequested = false;
    this._dshCommand = null;
  }

  get url() {
    return this.port ? `http://127.0.0.1:${this.port}` : '';
  }

  setState(state, extra = {}) {
    this.state = state;
    this.emit('state', { state, port: this.port, url: this.url, ...extra });
  }

  // ---- dsh 命令定位 ----
  async detectDshCommand() {
    if (this.settings.get().dshCommand) {
      return this.settings.get().dshCommand;
    }
    if (this._dshCommand) return this._dshCommand;

    // 1) PATH 中的 dsh
    const fromPath = await new Promise((resolve) => {
      execFile('which', ['dsh'], (err, stdout) => resolve(err ? '' : stdout.trim()));
    });
    if (fromPath) {
      this._dshCommand = fromPath;
      return fromPath;
    }
    // 2) npx 缓存里的 dsh（~/.npm/_npx/*/node_modules/.bin/dsh，取最新）
    try {
      const npxRoot = path.join(os.homedir(), '.npm', '_npx');
      const entries = fs.existsSync(npxRoot)
        ? fs.readdirSync(npxRoot).map((d) => path.join(npxRoot, d))
        : [];
      const candidates = [];
      for (const dir of entries) {
        const bin = path.join(dir, 'node_modules', '.bin', 'dsh');
        if (fs.existsSync(bin)) {
          try {
            const st = fs.statSync(bin);
            candidates.push({ bin, mtime: st.mtimeMs });
          } catch {}
        }
      }
      candidates.sort((a, b) => b.mtime - a.mtime);
      if (candidates.length) {
        this._dshCommand = candidates[0].bin;
        return candidates[0].bin;
      }
    } catch {}
    return '';
  }

  // ---- 端口 ----
  async findFreePort(preferred) {
    const start = typeof preferred === 'number' && preferred > 0 ? preferred : DEFAULT_PORT;
    for (let p = start; p <= PORT_RANGE_MAX; p++) {
      if (await this.portFree(p)) return p;
    }
    // 全被占：让 OS 分配
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const { port } = srv.address();
        srv.close(() => resolve(port));
      });
      srv.on('error', reject);
    });
  }

  portFree(port) {
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port, timeout: 400 });
      sock.on('connect', () => {
        sock.destroy();
        resolve(false);
      });
      sock.on('error', () => resolve(true));
      sock.on('timeout', () => {
        sock.destroy();
        resolve(true);
      });
    });
  }

  // 探测某端口上是否已是 harness（首页带 __DSH_BOOT__ 特征）
  async probeHarness(port, timeoutMs = 1500) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return false;
      const text = await res.text();
      return text.includes('__DSH_BOOT__') || /harness/i.test(text.slice(0, 4000));
    } catch {
      return false;
    }
  }

  // ---- 生命周期 ----
  async start() {
    if (this.state === 'running' || this.state === 'starting') return;

    // 若目标端口上已有 harness（例如浏览器版正开着），直接接管，不再拉起子进程
    const preferred = this.settings.get().port || DEFAULT_PORT;
    if (await this.probeHarness(preferred)) {
      this.port = preferred;
      this.setState('running', { adopted: true });
      this.emit('log', { level: 'info', text: `检测到已运行的 harness（端口 ${preferred}），直接接管` });
      return;
    }

    const dsh = await this.detectDshCommand();
    if (!dsh) {
      this.errorMessage = '未找到 dsh 命令。请安装 DeepSeek Harness，或在设置中指定 dsh 命令路径。';
      this.setState('error', { message: this.errorMessage });
      return;
    }

    this.port = await this.findFreePort(preferred);
    this._stopRequested = false;
    this.setState('starting', { command: dsh });

    const child = spawn(dsh, ['web', '--host', '127.0.0.1', '--port', String(this.port)], {
      env: { ...process.env, DSH_HOME: process.env.DSH_HOME || undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    child.on('error', (err) => {
      this.child = null;
      clearTimeout(this._healthTimer);
      if (this._stopRequested) {
        this.setState('stopped');
        return;
      }
      this.errorMessage = `无法启动 dsh 进程：${err.message}`;
      this.setState('error', { message: this.errorMessage });
    });

    const onOut = (buf) => {
      const text = buf.toString().trimEnd();
      if (text) this.emit('log', { level: 'info', text });
    };
    const onErr = (buf) => {
      const text = buf.toString().trimEnd();
      if (text) this.emit('log', { level: 'error', text });
    };
    child.stdout.on('data', onOut);
    child.stderr.on('data', onErr);
    child.on('exit', (code, signal) => {
      this.child = null;
      clearTimeout(this._healthTimer);
      if (this._stopRequested) {
        this.setState('stopped');
      } else if (this.state !== 'running') {
        this.errorMessage = `harness 进程提前退出（code=${code} signal=${signal}）`;
        this.setState('error', { message: this.errorMessage });
      } else {
        // 运行中意外退出
        this.errorMessage = `harness 进程意外退出（code=${code} signal=${signal}）`;
        this.setState('error', { message: this.errorMessage });
      }
    });

    await this.waitHealthy();
  }

  waitHealthy(timeoutMs = 45000) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = async () => {
        if (this.state !== 'starting' && this.state !== 'running') {
          resolve(false);
          return;
        }
        if (await this.probeHarness(this.port)) {
          this.setState('running');
          resolve(true);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          this.errorMessage = 'harness 服务启动超时';
          this.setState('error', { message: this.errorMessage });
          resolve(false);
          return;
        }
        this._healthTimer = setTimeout(tick, 500);
      };
      tick();
    });
  }

  async stop() {
    this._stopRequested = true;
    clearTimeout(this._healthTimer);
    const child = this.child;
    if (!child) {
      if (this.state === 'running' && this.port) {
        // 接管的外部实例：不杀进程（不属于我们），仅解除接管
      }
      this.setState('stopped');
      return;
    }
    await new Promise((resolve) => {
      const done = () => {
        child.removeListener('exit', done);
        resolve();
      };
      child.on('exit', done);
      child.kill('SIGTERM');
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, 4000).unref();
    });
    this.child = null;
    this.setState('stopped');
  }

  async restart() {
    const wasRunning = this.state === 'running';
    await this.stop();
    await this.start();
    return wasRunning;
  }
}

module.exports = { HarnessManager };
