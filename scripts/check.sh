#!/bin/bash
# 一键执行：类型检查 + 单元测试 + 构建 + 敏感信息扫描
# 用于自定义流程和 CI 检查

set -e

echo "🔍 执行类型检查..."
npm run build

echo "🧪 执行单元测试..."
npm test

echo "🏗️  执行生产构建..."
npm run build --workspace=dashboard

echo "🔒 扫描敏感信息..."
if grep -r "AI_API_KEY" --include="*.ts" --include="*.tsx" dashboard/src/client/ 2>/dev/null; then
  echo "❌ 错误：前端代码中发现 API Key 硬编码"
  exit 1
fi

echo "✅ 所有检查通过！"
