#!/usr/bin/env bash
# 发布脚本：构建 + 可选签名/公证 + 生成校验和
set -euo pipefail
cd "$(dirname "$0")/.."

PLATFORM="${1:-mac}"

case "$PLATFORM" in
  mac)
    echo "==> 构建 macOS 安装包 (dmg + zip)"
    npx electron-builder --config release/electron-builder.yml --mac
    ;;
  win)
    echo "==> 构建 Windows 安装包 (nsis + portable)"
    npx electron-builder --config release/electron-builder.yml --win
    ;;
  all)
    echo "==> 构建 mac + win（win 交叉构建需要 wine 或远程 runner）"
    npx electron-builder --config release/electron-builder.yml --mac --win
    ;;
  *)
    echo "用法: ./scripts/release.sh [mac|win|all]"
    exit 1
    ;;
esac

echo "==> 生成校验和"
cd release/dist
shasum -a 256 *.dmg *.zip *.exe 2>/dev/null | tee SHASUMS256.txt || true
echo "==> 完成，产物在 release/dist/"
