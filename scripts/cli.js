#!/usr/bin/env node
// DSH-Z 全局启动器：从任何目录启动桌面应用
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
let electronBin;
try {
  electronBin = require('electron'); // 返回 electron 可执行文件路径
} catch {
  console.error('未找到 Electron，请先在项目目录执行 npm install');
  process.exit(1);
}
const child = spawn(electronBin, [path.join(root, '.')], { stdio: 'inherit', env: process.env });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code || 0);
});
child.on('error', (e) => {
  console.error('启动失败:', e.message);
  process.exit(1);
});
