#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo '需要 Node.js 24 或更新版本及 npm。安装说明：https://nodejs.org/zh-cn/download' >&2
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  echo '当前 Node.js 版本过低，请安装 Node.js 24 或更新版本后重试。' >&2
  exit 1
fi
if [[ ! -f node_modules/three/build/three.module.js ]]; then
  echo '首次启动：安装锁定版本的运行依赖……'
  npm ci --omit=dev
fi
echo '启动本机模拟控制台；默认在这台电脑打开 http://127.0.0.1:3000'
echo '实际监听地址以服务启动输出为准。按 Ctrl+C 停止。'
exec node --env-file-if-exists=.env services/control/server.js
