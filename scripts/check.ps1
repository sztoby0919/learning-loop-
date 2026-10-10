# 湛卢可复用检查脚本（Windows PowerShell）
# 依次运行：npm test -> npm run build
# - 任一步失败立即停止，返回非零退出码
# - 输出保存到 zhanlu-evidence/<日期>/
# - 不调用真实模型、不打印环境变量或 API Key
# - 不自动安装工具、不修改执行策略、不提升权限、不删除用户数据

$ErrorActionPreference = "Stop"

# 项目根目录（本脚本位于 <root>/scripts 下）
$root = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format "yyyy-MM-dd"
$outDir = Join-Path $root "zhanlu-evidence\$stamp"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

Write-Host "[1/2] npm test"
Push-Location $root
try {
  npm test 2>&1 | Tee-Object -FilePath (Join-Path $outDir "npm-test.txt")
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($code -ne 0) { Write-Host "FAIL: npm test exit=$code (输出: npm-test.txt)"; exit $code }

Write-Host "[2/2] npm run build"
Push-Location $root
try {
  npm run build 2>&1 | Tee-Object -FilePath (Join-Path $outDir "npm-build.txt")
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($code -ne 0) { Write-Host "FAIL: npm run build exit=$code (输出: npm-build.txt)"; exit $code }

Write-Host "ALL CHECKS PASSED"
exit 0
