# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。

## [0.2.0] - 2026-08-17

### 新增
- 首次启动向导：检测 dsh 环境、配置 DeepSeek/Agnes API Key、选择默认模型 —— 开箱即用
- 打包工程（`release/`）：electron-builder 适配 macOS（dmg/zip）与 Windows（nsis/portable）
- 开源脚手架：LICENSE（MIT）、CONTRIBUTING、.gitignore

## [0.1.0] - 2026-08-17

### 新增
- 内嵌 harness Web GUI 的桌面壳（多窗口、托盘、系统通知、全局快捷键）
- Harness 进程管理（自动探测 dsh、端口协商、接管已有实例）
- 命令面板（`⌘K`，harness 命令直接执行）+ `model:` 系列本地命令
- 多模态模型路由：常规 / 图片理解 / 图片生成 / 视频生成四档，会话级一键切换（reasoningEffort 自适应）
- Skill 管理：查看/编辑/新建/删除用户技能（harness 实时发现）
- 知识看板：白底力导向图，项目/日期/主题三维度，agnes 智能摘要 + 本地缓存，节点悬停摘要卡，日期筛选器
- 自定义 UI：背景（纯色/图片）、强调色、圆角、组件透明度（实时预览）
- 移动端联动：局域网代理（HTTP+WS 转发 + CORS + randomUUID polyfill）+ 公网隧道（Cloudflare quick tunnel）
- 主题动效：切换光晕、状态灯呼吸、按钮流光、面板弹簧动画

### 修复
- 切换视觉/图片模型时 reasoningEffort 不匹配导致 model-unavailable
- webviewTag 强制 preload sandbox 导致 contextBridge 失效
- Electron 主进程无全局 WebSocket（引入 ws 包）
