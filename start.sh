#!/bin/bash
# KuGou Music API 启动脚本
# 自动安装缺失依赖并启动服务

set -e

cd /app

# 安装缺失依赖
if ! node -e "require('mysql2/promise')" 2>/dev/null; then
  echo "[startup] Installing mysql2..."
  npm install mysql2 --save 2>/dev/null || true
fi

if ! node -e "require('axios')" 2>/dev/null; then
  echo "[startup] Installing axios..."
  npm install axios --save 2>/dev/null || true
fi

echo "[startup] Starting KuGou Music API..."
exec node index.js
