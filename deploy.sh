#!/bin/bash
set -e

echo "🎵 KuGou Music Web Player - 部署脚本"
echo "=================================="

cd "$(dirname "$0")"

echo ""
echo "📦 步骤 1/3: 停止旧容器..."
docker compose down || true

echo ""
echo "🔨 步骤 2/3: 构建新镜像..."
docker compose build --no-cache

echo ""
echo "🚀 步骤 3/3: 启动服务..."
docker compose up -d

echo ""
echo "✅ 部署完成！"
echo "🌐 访问地址: http://$(hostname -I | awk '{print $1}'):5301"
echo ""
echo "查看日志: docker compose logs -f"
echo "停止服务: docker compose down"
