#!/bin/bash
# 敏感信息扫描脚本
# 检查代码中是否包含硬编码的 API Key、密码等敏感信息

set -e

echo "🔒 扫描敏感信息..."

# 检查常见的敏感信息模式
PATTERNS=(
  "AI_API_KEY=[a-zA-Z0-9]"
  "api_key=[a-zA-Z0-9]"
  "apiKey.*=.*['\"][a-zA-Z0-9]"
  "password.*=.*['\"]"
  "secret.*=.*['\"]"
  "Bearer [a-zA-Z0-9]"
)

FOUND=0
for pattern in "${PATTERNS[@]}"; do
  if grep -r "$pattern" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.json" dashboard/src/ 2>/dev/null | grep -v "node_modules" | grep -v ".test."; then
    echo "❌ 发现敏感信息：$pattern"
    FOUND=1
  fi
done

# 检查 .env 文件是否被提交
if git ls-files | grep -q "^\.env$"; then
  echo "❌ 错误：.env 文件被提交到 Git"
  FOUND=1
fi

# 检查是否有 .gitignore
if [ ! -f ".gitignore" ]; then
  echo "⚠️  警告：缺少 .gitignore 文件"
else
  if ! grep -q "^\.env$" ".gitignore"; then
    echo "⚠️  警告：.gitignore 中未包含 .env"
  fi
fi

if [ $FOUND -eq 1 ]; then
  echo "❌ 敏感信息扫描失败"
  exit 1
fi

echo "✅ 敏感信息扫描通过"
