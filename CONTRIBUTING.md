# Contributing — DSH-Z

欢迎贡献！请先阅读并遵守以下约定。

## 快速开始

```bash
npm install          # 安装依赖
npm start            # 开发运行
npm run dist:mac     # 构建 macOS 安装包
```

## 代码规范

- 纯 JavaScript（CommonJS），无构建步骤；新增代码保持与现有风格一致
- 主进程模块位于 `src/main/`，渲染层在 `src/renderer/`，preload 在 `src/preload/`
- **preload 运行于 sandbox**：不能 `require` 本地文件，常量需内联（见 preload 顶部注释）
- IPC 通道名统一登记在 `src/shared/constants.js`，preload 内联同名副本
- 提交前 `node --check` 校验语法；新功能需在 README「功能」表补充一行

## 提交信息

```
feat: 新增看板智能摘要（agnes 缓存）
fix: 修复模型切换时 reasoningEffort 冲突
docs: 更新打包说明
chore: 升级 electron 33 → 37
```

## 测试

目前以人工 + 联调脚本验证为主（CDP 冒烟）。欢迎补充：

- 单元测试：`src/main/board.js`（产出物提取）、`src/main/skill.js`（frontmatter 读写）、`src/main/summary.js`（缓存逻辑）
- e2e：Playwright + Electron

## 安全注意事项

- **本项目可执行任意命令**（内置 harness）：合并任何涉及网络暴露（LAN 代理、公网隧道）的改动时，必须同步更新安全提示
- 严禁在代码、示例、README 中提交任何真实 API Key
- 敏感信息只存在于用户本地的 `~/.dsh/.credentials.yaml`（0600 权限）

## 发布流程

1. 更新 `CHANGELOG.md` 与 `package.json` 版本号
2. `./scripts/release.sh mac`（或 win）产出安装包
3. 配置 `GH_TOKEN` 后 `npx electron-builder --publish always` 发布到 GitHub Releases
4. 签名/公证：设置 `CSC_LINK` / `CSC_KEY_PASSWORD`（Apple Developer 证书）
