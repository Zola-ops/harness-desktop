# DSH-Z

可定制的 **DeepSeek Harness** 桌面端 —— 内嵌现有 Web GUI，叠加原生桌面能力。

![stack](https://img.shields.io/badge/Electron-33-47848F) ![platform](https://img.shields.io/badge/macOS%20%26%20Windows-9cf) ![license](https://img.shields.io/badge/license-MIT-green)

## 安装（开箱即用）

> 从 [Releases](../../releases) 下载对应平台安装包：
> - **macOS**：`Harness-Desktop-<版本>-arm64.dmg`（Apple Silicon）或 `-x64.dmg`（Intel）
> - **Windows**：`Harness-Desktop-Setup-<版本>.exe`（安装版）或 `-portable.exe`（绿色版）

首次启动弹出**配置向导**，三步即可使用：

1. **检测环境**：自动探测 `dsh` 命令行；未安装时给出安装命令（`npm install -g @deepseek-ai/dsh`）
2. **配置 API Key**：DeepSeek Key（主对话模型，必填）+ Agnes Key（可选：图片理解/生成、看板智能摘要）；密钥仅保存在本地 `~/.dsh/.credentials.yaml`（0600 权限）
3. **选择默认模型**：保存并自动启动服务

> 也可跳过向导，稍后在 ⚙ 设置中配置。

## 开发者快速开始

```bash
cd ~/Desktop/harness-desktop   # 先进入项目目录（在 ~ 根目录直接 npm start 会报 Missing script）
npm install                    # 安装依赖（Electron + ws + yaml + qrcode）
npm start                      # 开发运行
npm run dist:mac     # 构建 macOS 安装包（dmg + zip）
npm run dist:win     # 构建 Windows 安装包（nsis + portable，需 Windows / CI）
./scripts/release.sh mac   # 或一键发布脚本（含校验和）
```

首次启动会自动探测 `dsh` 命令（PATH → `~/.npm/_npx/*/node_modules/.bin/dsh`），拉起 harness 服务并打开主窗口。也可以在设置里手动指定 dsh 路径。

| 类别 | 能力 |
| --- | --- |
| **内嵌 GUI** | 壳窗口内嵌 `dsh web` 页面（webview），顶栏提供工具入口 |
| **进程管理** | 自动拉起 / 停止 / 重启 `dsh web` 服务；若浏览器版已在运行（如 3080 端口），自动接管而不重复启动；端口占用自动顺延 |
| **托盘常驻** | 菜单栏图标显示服务状态，菜单一键打开/新建窗口、启停/重启服务、退出 |
| **系统通知** | Agent 出错、Agent 完成、审批请求、问题询问 → macOS 通知，点击聚焦窗口 |
| **审批快捷操作** | 顶栏 🔐 徽标显示待审批数，队列面板一键「允许 / 拒绝」（经 `/api/respond`），无需切到页面 |
| **全局搜索** | `⌘⇧F` 跨会话搜索：命中会话标题/目标或历史内容，显示片段一键复制跳转（`session.search` 不可用时自动本地回退） |
| **会话管理** | `⌘⇧S` 面板：新建（自定义工作目录）/重命名/派生 fork/取消运行中会话/**导出 ZIP**（完整会话日志），列表含标题、目标与状态 |
| **Subagent 协作树** | 左侧「子代理」面板：选择根会话展开子 Agent 树（运行状态/层级），运行中可一键中断，**选中节点可直接委派任务**（subagent.prompt） |
| **智能体预设/专家团** | 左侧「智能体」面板：预设列表（系统/用户/默认/异常标记）+ 应用到会话 + 预览 + 复制 + 删除 |
| **记忆模块** | 左侧「记忆」面板：跨会话记忆库（~/.agents/memory/）笔记 CRUD/搜索/标签 + memory-access skill 让 agent 自动读写偏好与事实 |
| **第三方服务（MCP）** | 设置 → 服务：添加/移除 MCP server（HTTP/stdio），保存并重启后 agent 获得其工具 —— 云手机/云电脑等第三方服务接入通道 |
| **资产仓库** | 左侧「资产」面板：聚合全部会话产出物，按文件名搜索、类型图标、打开/Finder 显示 |
| **Goal 管理** | 会话面板直接「✓ 目标」标记完成；看板详情显示 🎯 目标 |
| **用量统计** | 看板 📊 按钮：会话数/turns/steps/输出 token/模型耗时汇总 + 各会话 Token 条形图 |
| **多窗口** | 任意开多个窗口（⇧⌘N），各自独立浏览/操作 |
| **命令面板** | `⌘K` 唤起：输入 harness 命令（`/plan`、`/goal` 等）直接执行，不经过模型；自动选择目标会话，保留执行历史 |
| **主题定制** | 系统/浅色/深色三态（同步控制 harness 页面的 `prefers-color-scheme`）+ 自定义 CSS 注入 harness 页面 + 切换时径向光晕动效 |
| **自定义 UI** | 壳层外观定制：背景（纯色/本地图片 + 模糊/暗化）、主/次强调色、圆角、顶栏与面板透明度 —— 滑块实时预览，保存持久化；**主题桥**自动把壳主题同步到 harness 页面 |
| **SVG 图标** | 顶栏统一线性 SVG 图标体系（审批/搜索/会话/命令/看板/Skill/新窗口/主题/浏览器/设置） |
| **移动端联动** | 局域网：一键把 harness 暴露给同一 Wi-Fi 的手机（HTTP + WebSocket 代理含 CORS，自动注入 randomUUID polyfill）+ 二维码扫码；公网：Cloudflare 隧道生成 `trycloudflare.com` 地址，移动网/任意网络可访问 |
| **动效 UI** | 主题切换光晕、状态灯呼吸、按钮流光、面板弹簧入场、toast 滑入；尊重系统"减弱动效"偏好 |
| **多模态模型路由** | 常规任务 / 图片理解 / 图片生成 / 视频生成四档模型独立配置；「应用到会话」一键切换当前会话模型（`session.selectModel`），命令面板 `model:vision` / `model:image` / `model:default` / `model:video` 快捷切换 |
| **Skill 管理** | 顶栏 🧩 Skill 面板：浏览全部用户技能（名称/描述/文件信息）、查看全文、编辑、新建（自动生成 frontmatter）、删除；保存后 harness 实时发现，会话立即可用 |
| **知识看板** | 顶栏 ◈ 看板：白底黑字 Obsidian 式力导向图，按项目 / 日期 / 主题三个维度可视化会话、工作区与产出物；**agnes 智能摘要**（一句话概括会话/项目，本地缓存二次查看秒开）；悬停节点看摘要卡；产出物可打开或在 Finder 中显示；搜索过滤、缩放拖拽 |
| **全局快捷键** | ⇧⌘Space 呼出命令面板（任意应用内）、⇧⌘N 新建窗口，均可自定义 |
| **文件集成** | 拖拽文件到窗口 → 路径自动复制到剪贴板，会话里 ⌘V 直接引用 |
| **窗口记忆** | 记住每个窗口的位置与大小，重启还原 |

## 使用要点

- **关闭窗口**：默认最小化到托盘（服务继续跑）；可在设置里改为"保持服务并退出窗口"或"退出应用"
- **退出应用**：托盘菜单「退出」，默认同时停止 harness 服务（可在设置关闭）
- **服务状态**：顶栏左侧圆点 —— 绿=运行、黄=启动中、灰=停止、红=错误
- **命令面板**：顶栏 `⌘K 命令` 按钮或快捷键；会话下拉框选择目标会话（自动按最近活动排序）。本地命令（`model:` 前缀）由桌面端直接处理，不经过 harness
- **多模态模型路由**：设置 → 多模态模型路由 → 四档（常规任务/图片理解/图片生成/视频生成）分别填 Provider + Model（可从「会话目录选择」直接选）。「应用到会话」把当前会话切到对应模型；命令面板 `model:vision` 等可随时快速切换。常规档留空 = 跟随 harness 默认模型
- **Skill 管理**：顶栏 🧩 Skill 按钮打开面板。左侧列表（来源 ~/.agents/skills 与 $DSH_HOME/skills，含目录包与单文件两种格式），右侧查看/编辑正文与 frontmatter 字段（name/description/whenToUse/禁用模型调用/禁止用户调用）；「新建 Skill」生成标准 frontmatter 文件（`~/.agents/skills/<名称>/SKILL.md`）。harness 的文件监控会实时发现变更，新建的 skill 立即进入会话可用列表
- **知识看板**：顶栏 ◈ 看板按钮打开，画布为**白底黑字**（图例/悬停卡同步浅色风格）。画布为力导向图：大实心圆 = 项目/分组（母节点），小实心圆 = 会话（子节点，运行中带光环），蓝色小方块 = 产出物；每个节点带**摘要**：主标签下方有小字副标签，**悬停节点弹出摘要卡**（会话：标题/运行状态/💡 智能摘要/预设/更新时间/目录；项目：摘要/路径/会话数；产出物：文件路径）；滚动缩放、拖拽平移/节点、双击聚焦。维度切换：项目（按工作区聚合）、日期（按具体日期分组，如「今天 · 8月17日」）、主题（按会话目标/标题聚类）。**日期筛选器仅在「日期」维度显示**。点击会话查看详情：标题、目标、Agent 预设、统计、首条消息、产出物列表（可打开文件 / Finder 显示）
- **看板智能摘要**：设置 → 看板智能摘要。用轻量模型（默认 **agnes-2.5-flash**，自动读取 `~/.dsh/.credentials.yaml` 的 `AGNES_API_KEY` 与 harness 的 agnes 配置）为每个会话/项目生成一句话摘要。**缓存到本地 `userData/board-summaries.json`**：同一会话内容未变化时二次查看直接读缓存（毫秒级），只有新会话或会话内容更新后才重新生成；可切换摘要模型、可关闭
- **模型切换的 reasoningEffort 自适应**：切换模型时自动查询目标模型的能力目录，仅当目标模型支持当前 reasoningEffort 时才带上，避免视觉/图片/视频模型因不支持 reasoning 而报 `model-unavailable`
- **自定义 UI**：设置 → 自定义 UI（壳层）。背景选纯色或本地图片（可调模糊 0-40、暗化 0-0.9）；主/次强调色任意取色；圆角 4-20px；顶栏/面板不透明度 30%-100%（毛玻璃效果随透明度增强）。所有改动实时预览，「保存设置」持久化；「重置为默认」一键还原。harness 页面本身的定制仍用「外观 → 自定义 CSS」
- **移动端联动**：设置 → 移动端联动 → 勾选启用。桌面端起一个 `0.0.0.0:<端口>` 的透明代理（默认 3180，HTTP + WebSocket 全转发并附加 CORS 头），手机连同一 Wi-Fi 后扫码或输入 `http://<电脑局域网IP>:3180` 即可访问完整 harness（含实时事件流）。代理会对 HTML 页面自动注入 `crypto.randomUUID` polyfill，兼容旧版手机浏览器。**安全提醒**：harness 可执行命令，仅限可信局域网、用后即关；公共网络禁止开启
- **公网访问（移动网，三档可选）**：设置 → 网络。
  - **SSH 反向隧道（推荐，自持服务器）**：填服务器地址 + SSH 私钥路径 + 域名即可。复用 22 端口，服务器无需开放新端口；启动时自动拉起 LAN 代理、自动清理服务器残留转发、自动把目录选择器切为 native（Mac 本机弹窗、结果回传远程）。适合腾讯云轻量等默认仅开放 22/80/443 的服务器，配合 nginx 反代 + Let's Encrypt 实现 `https://<域名>` 访问
  - **frp 内网穿透**：自持服务器跑 frps，Mac 跑 frpc 自动连接（需服务器放行 frps 通信端口）；配套 `scripts/setup-frps.sh` 一键部署（frps + systemd + Nginx + certbot）
  - **Cloudflare 隧道（免服务器）**：生成 `https://*.trycloudflare.com` 地址，首次自动下载 cloudflared；国内网络数据面可能被干扰，作为备用
  - 启动公网访问时 LAN 代理会自动覆盖 Origin/Referer 为本地 harness 地址，手机访问 `host.*`/`settings.*` 等敏感 RPC 不再 403
- **主题动效**：顶栏 ◐ 按钮循环切换 系统→浅色→深色，伴随径向光晕扩散动画；状态灯运行中呼吸脉动
- **自定义 CSS**：设置 → 外观 → 自定义 CSS，保存后注入 harness 页面（改完点「重新加载页面」立即生效）

## 架构

```
src/
├── main/                  # Electron 主进程
│   ├── index.js           # 入口：单实例锁、生命周期、模块组装、事件接线
│   ├── harness.js         # HarnessManager：dsh 定位、端口协商、spawn/健康检查/停止
│   ├── rpc.js             # RpcClient：HTTP POST /api/<method>，Typert 信封协议
│   ├── events.js          # EventBridge：双 WebSocket 流（mux + host）事件订阅与会话索引
│   ├── windows.js         # WindowManager：多窗口、bounds 记忆、关窗行为
│   ├── tray.js            # 托盘：状态展示与服务控制
│   ├── shortcuts.js       # 全局快捷键（可配置、可重注册）
│   ├── notify.js          # 事件 → 系统通知
│   ├── settings.js        # userData/settings.json 持久化
│   └── ipc.js             # ipcMain.handle 注册表
├── preload/index.js       # contextBridge：window.desktop API（sandbox 兼容，常量内联）
├── renderer/              # 壳页面（本地 UI + webview）
│   ├── shell.html / css / js
└── shared/constants.js    # 通道名常量（主进程侧）
```

### 与 harness 的对接协议（实测验证）

- **RPC**：`POST http://127.0.0.1:<port>/api/<method>`，信封 `{type:'client-request', rpcId, method, payload:{args:{...}}}`，响应 `{type:'server-response', rpcId, result:{ok, value|error}}`
- **事件流**（两条 WebSocket）：
  - `/api/events.mux` —— 会话级：连接即推全部会话 baseline（`session/subscribed`、`session/jobs`），随后推送 `approval/requested`、`question/requested`、`session/event` 等
  - `/api/events.host` —— 宿主级：`host/session-added/removed/status`、`host/agent-error`、`host/remote-event`
- **实例探测**：`GET /` 响应体含 `__DSH_BOOT__` 即判定为 harness，避免与浏览器版重复启动

## 已知限制（v0.1）

- 审批/问题通知依赖 mux 流推送；若 harness 长时间无会话活动，命令面板会话列表可能为空（在页面新建/打开会话即恢复）
- 命令面板执行的是 harness 命令（不走模型），如需 AI 对话请用页面本身
- 仅 macOS（`titleBarStyle: hiddenInset`、template 托盘图标）；应用未签名，首次运行在系统设置中允许即可
- 会话标题未接入（host 流不含 title），列表暂以 agentPreset/会话 ID 展示
- **模型路由是"会话级切换"而非"内容自动路由"**：harness 引擎当前按会话固定模型（无按图片内容自动换模型的机制），且内置 DeepSeek/pi-ai 适配器均不支持图片输入。图片理解档请配置支持视觉的 OpenAI 兼容服务（provider/model + 在 harness 设置里配好 API key）；图片生成/视频生成档为外部 API 的配置位（harness 无生成管线，供命令/工具引用）
- 切换模型时保留当前会话的 reasoningEffort（若会话未设置过则采用模型默认）
- Skill 管理支持用户目录（~/.agents/skills、$DSH_HOME/skills）；内置 bundled skills 为只读展示，不在编辑列表

## 开发

```bash
npm start                    # 运行
node scripts/gen-icons.js    # 重新生成图标
```
