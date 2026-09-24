#!/bin/bash
# 参赛作品打包脚本
# 按官方要求：团队名称-队长姓名-队长手机号-作品名称

set -e

echo "📦 打包参赛作品..."

# 配置
TEAM_NAME="${TEAM_NAME:-my-team}"
LEADER_NAME="${LEADER_NAME:-leader}"
LEADER_PHONE="${LEADER_PHONE:-13800138000}"
WORK_NAME="${WORK_NAME:-learning-loop-ai-diagnosis}"
OUTPUT_DIR="${OUTPUT_DIR:-dist}"

# 创建输出目录
mkdir -p "${OUTPUT_DIR}"

# 文件名：团队名称-队长姓名-队长手机号-作品名称
ARCHIVE_NAME="${TEAM_NAME}-${LEADER_NAME}-${LEADER_PHONE}-${WORK_NAME}"
ARCHIVE_PATH="${OUTPUT_DIR}/${ARCHIVE_NAME}.zip"

# 清理旧的打包文件
rm -f "${ARCHIVE_PATH}"

echo "📁 打包文件..."

# 创建临时目录用于打包
TEMP_DIR=$(mktemp -d)
mkdir -p "${TEMP_DIR}/${ARCHIVE_NAME}"

# 复制核心文件
echo "  - 复制源代码..."
mkdir -p "${TEMP_DIR}/${ARCHIVE_NAME}/src"
cp -r dashboard/src "${TEMP_DIR}/${ARCHIVE_NAME}/src/"
cp dashboard/package.json "${TEMP_DIR}/${ARCHIVE_NAME}/"
cp dashboard/tsconfig*.json "${TEMP_DIR}/${ARCHIVE_NAME}/" 2>/dev/null || true
cp dashboard/vite.config.ts "${TEMP_DIR}/${ARCHIVE_NAME}/" 2>/dev/null || true
cp dashboard/vitest.config.ts "${TEMP_DIR}/${ARCHIVE_NAME}/" 2>/dev/null || true
cp dashboard/playwright.config.ts "${TEMP_DIR}/${ARCHIVE_NAME}/" 2>/dev/null || true

# 复制文档
echo "  - 复制文档..."
mkdir -p "${TEMP_DIR}/${ARCHIVE_NAME}/docs"
cp README.md "${TEMP_DIR}/${ARCHIVE_NAME}/docs/"
cp SKILL.md "${TEMP_DIR}/${ARCHIVE_NAME}/docs/"
cp 作品说明.md "${TEMP_DIR}/${ARCHIVE_NAME}/docs/" 2>/dev/null || true
cp 参赛改造方案.md "${TEMP_DIR}/${ARCHIVE_NAME}/docs/" 2>/dev/null || true
cp 演示视频脚本.md "${TEMP_DIR}/${ARCHIVE_NAME}/docs/" 2>/dev/null || true
cp 成本估算.md "${TEMP_DIR}/${ARCHIVE_NAME}/docs/" 2>/dev/null || true

# 复制配置和脚本
echo "  - 复制配置..."
cp .env.example "${TEMP_DIR}/${ARCHIVE_NAME}/"
mkdir -p "${TEMP_DIR}/${ARCHIVE_NAME}/scripts"
cp scripts/check.sh "${TEMP_DIR}/${ARCHIVE_NAME}/scripts/"
cp scripts/scan-secrets.sh "${TEMP_DIR}/${ARCHIVE_NAME}/scripts/"

# 复制示例数据
echo "  - 复制示例数据..."
cp -r examples "${TEMP_DIR}/${ARCHIVE_NAME}/"

# 创建 .gitignore
cat > "${TEMP_DIR}/${ARCHIVE_NAME}/.gitignore" << 'EOF'
node_modules/
dist/
.env
.env.*
!.env.example
*.log
test-results/
playwright-report/
dashboard/test-results/
dashboard/playwright-report/
EOF

# 创建 README
cat > "${TEMP_DIR}/${ARCHIVE_NAME}/README.md" << EOF
# Learning Loop - AI 驱动的学习诊断系统

## 快速开始

\`\`\`bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env 填入 AI_BASE_URL, AI_API_KEY, AI_MODEL

# 3. 启动开发服务器
npm run dashboard:dev

# 4. 打开浏览器访问
http://127.0.0.1:4174
\`\`\`

## 功能特性

- 📚 本地 Markdown 学习档案管理
- 🔍 AI 驱动的知识漏洞诊断
- 📝 证据驱动的掌握度评估
- 🔒 原子写入 + 哈希冲突检测
- 🎯 湛卢 IDE Skill 兼容

## 文档

- [作品说明](docs/作品说明.md)
- [参赛改造方案](docs/参赛改造方案.md)
- [演示视频脚本](docs/演示视频脚本.md)
- [成本估算](docs/成本估算.md)
- [Skill 配置](docs/SKILL.md)

## 团队信息

- 团队名称：${TEAM_NAME}
- 队长姓名：${LEADER_NAME}
- 队长手机号：${LEADER_PHONE}

## License

MIT
EOF

# 打包
echo "🗜️  创建 zip 文件..."
(cd "${TEMP_DIR}" && zip -r "${ARCHIVE_PATH}" "${ARCHIVE_NAME}" -x "*.DS_Store" -x "*__MACOSX*")

# 清理临时文件
rm -rf "${TEMP_DIR}"

# 检查文件大小
SIZE=$(du -h "${ARCHIVE_PATH}" | cut -f1)
echo "✅ 打包完成: ${ARCHIVE_PATH}"
echo "   文件大小: ${SIZE}"
echo ""
echo "📋 提交前检查："
echo "   - 确保作品说明文档完整"
echo "   - 确保演示视频已录制"
echo "   - 确保 API Key 不包含在提交中"
echo "   - 确保 .env 文件不被提交"
