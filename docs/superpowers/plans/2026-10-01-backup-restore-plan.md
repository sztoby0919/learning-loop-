# ZIP 备份与安全恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 备份课程及受管原课件，验证后恢复为新课程，不覆盖旧数据、不读取外部文件。

**Architecture:** 独立备份 manifest/codec/restore manager，经白名单、实际大小计数和 checksum 检查后暂存，确认再在事务日志保护下发布。启动先协调恢复事务，再自动发现课程；现有 JSON 导出不变。

**Tech Stack:** TypeScript、Node fs/crypto/streams、Express、React、现有课程解析器、Vitest、Playwright。ZIP 解码实现由 Task 1 安全能力门禁决定，不能提前假定 JSZip 满足契约。

**Spec:** `docs/superpowers/specs/2026-10-01-import-control-and-backup-design.md` 第 1–3、7–8 节。

## Global Constraints

- 当前工作区，不 commit/push、不调用真实 API；新增依赖必须另获同意。
- 压缩 250 MiB、实际解压总量 500 MiB、最多 2,000 文件和 50 课程；单 Markdown 10 MiB。
- 原文件 PDF 100 / DOCX 50 / HTML 20 / 文本 10 MiB；每个已恢复课程分配新 ID。
- 不打包 .env、配置、草稿、缓存、链接目标、外部资源；保留 JSON 接口与格式。
- 无可靠、实际有界解压方案不得提供恢复功能或声称安全通过。

## Review Focus

- ZIP 声明大小低于实际输出或重复 central 条目，读取对象字典后才校验不够（Task 1）。
- Windows 大小写别名、盘符、junction 与源路径变更，不能读写受管目录外（Task 1、2）。
- 编辑课程与备份并发，不能下载内部不一致的备份（Task 2）。
- 多课程恢复第二门发布失败或重启，不能留下第一门半批课程（Task 3）。
- 普通笔记恰好含旧 ID/来源 URL、证据 ID 或日期，不能全局替换或重算（Task 3）。

## 核心契约

创建 `dashboard/src/shared/course-backup.ts`：

```ts
interface BackupManifest { format: "learning-loop-backup"; version: 1; exportedAt: string; courses: Array<{id: string; title: string; sourceIncluded: boolean; warnings: string[]; files: Array<{path: string; bytes: number; sha256: string}>}> }
interface BackupEntry { path: string; bytes: Uint8Array }
interface RestorePreview { id: string; expiresAt: number; courses: Array<{originalId: string; newId: string; title: string; fileCount: number; sourceIncluded: boolean; warnings: string[]}> }
interface ZipCodec { encode(entries: AsyncIterable<BackupEntry>): Promise<Uint8Array>; decodeToDirectory(bytes: Uint8Array, root: string, limits: BackupLimits): Promise<Array<{path: string; bytes: number; sha256: string}>> }
// BackupLimits 在 shared 定义上述精确上限与允许路径/扩展名限额。
```

归档 `manifest.json` 与 `courses/<oldId>/<allowed-file>`；不使用原标题构造磁盘路径。允许 course/notes/reviews/resources/schedule.md、sessions/<安全 basename>.md 及最多一个 source.<允许格式>；目录条目只允许以上路径的父级，不能导致文件数校验被规避。

### Task 1：安全 ZIP codec 与能力门禁

**Files:** 创建 server/backup-zip.ts、backup-zip.test.ts、shared/course-backup.ts、src/test/zip-fixtures.ts；必要时修改 package.json/package-lock.json，仅获授权后。

**Interfaces:** `ZipCodec` 如上；`validateArchivePath(name: string): string` 不修复危险输入而直接拒绝。codec 对实际解压字节计数并中止，单条及总量双限制。

- [ ] 写失败测试 fixture：raw ZIP 保留重复原始条目、大小写冲突、绝对/盘符/.. /反斜杠/链接路径、central 与 local header 不一致、声明小实际大、超 2,000 个文件，全部拒绝且目录外哨兵不变。
- [ ] 检查已安装 JSZip 的公开读写接口能否保留原始条目、验证 header 并及时停止实际解压。禁用无界 `file.async()` 或 CRC 整体解压，不能先分配完整输出再做限制。
- [ ] 若现有公开接口无法通过测试，暂停本批，说明缺少的能力，并向用户申请一个经官方文档核实、支持流式逐条校验及实际输出上限的 ZIP 依赖；未获准不安装、不写未经验证的通用 ZIP 解析器。前两批交付不受影响。
- [ ] 安全方案获准或现有能力证明后，运行 `npx vitest run src/server/backup-zip.test.ts` 确认红；实现契约及正确句柄关闭/失败清理。
- [ ] 用小限额注入 tests 验证真实输出累计先于落盘超限停止；用规格限额检查边界，不为每次单测分配 500 MiB。跑同命令确认绿，写下使用的公开能力和拒绝范围。

### Task 2：安全备份集合、manifest 与下载

**Files:** 创建 server/course-backup.ts、course-backup.test.ts；修改 workspace-repository.ts、app.ts；必要时 source-references.ts 只提取通用同级路径安全 helper。

**Interfaces:** `CourseBackupService(repository, imports, codec)` 的 `preview(courseIds?: string[]): Promise<BackupManifest>`、`create(courseIds?: string[]): Promise<{bytes: Uint8Array; manifest: BackupManifest}>`。GET `/api/backups/preview?courseId=...`、GET `/api/backups?courseId=...`，省略 courseId 为全部；下载 MIME application/zip。

- [ ] 写失败测试：五文件/sessions/原 source 包含且 hash 正确，.env/配置/草稿/Markdown 引用的外部文件不出现；手工课程缺来源可导出但带 warning，单/全 JSON 老接口不变。
- [ ] 写失败测试：根目录、Markdown、session 或 source 链接拒绝；超过 50 门或格式限额明确失败；白名单之外文件不偷偷打包；mtime/size/content 在读取时变化使本次备份失败而非出混合版本。
- [ ] `npx vitest run src/server/course-backup.test.ts src/server/workspace-repository.test.ts src/server/app.test.ts` 确认红。
- [ ] 实现读取前/后身份、内容状态一致性检查与安全快照；manifest 基于同一实际备份 bytes 的哈希生成，下载前再生成时重新核验，不复用失效预览。并发编辑无法获取可靠快照时拒绝并提示重试，绝不声称包含全部外部素材。
- [ ] 跑同命令确认绿；backup preview/download 无模型调用及密钥日志。

### Task 3：恢复预览、结构化重映射与发布事务

**Files:** 创建 server/course-restore.ts、course-restore.test.ts、course-id-remap.ts、course-id-remap.test.ts、course-restore-recovery.ts、course-restore-recovery.test.ts；修改 repository.ts、index.ts、app.ts、dashboard-config.ts；新增 course-backup.integration.test.ts。

**Interfaces:** `CourseRestoreManager({root, repository, events, watchCourse, codec, now})` 的 `create(bytes): Promise<RestorePreview>`、`preview(id): Promise<RestorePreview>`、`confirm(id): Promise<{courseIds: string[]}>`、`cancel(id): Promise<void>`、`cleanupExpired(): Promise<void>`；`remapCourseFiles(files: Record<string,string>, oldId: string, newId: string): Record<string,string>`；`recoverRestoreTransactions(root: string): Promise<void>` 在自动发现前执行。Repository 提供验证整批后一次性登记、撤销本事务新增缓存/配置的方法，不修改用户配置 JSON。

API POST `/api/restores` ZIP 上传、GET `/:id` 预览、POST `/:id/confirm`、DELETE `/:id` 取消；通过单独 multer/流式限额而非旧 PDF 100 MiB limiter。预览固定创建后 24 小时过期并每小时清理安全暂存目录；恢复确认回执同期间内幂等。

- [ ] 写失败测试：manifest/version/hash/大小/未知路径/非法 Markdown 和跨课程 courseId 不一致拒绝且无已发布课程；空归档/缺 course.md 明确拒绝，其他四文件缺失按现有手工课程允许性保留 warning。
- [ ] 写失败测试：映射仅 frontmatter 关联字段和 resources 表中精确内部 source URL，正文旧 ID、日期、分数、选项、证据/mistakeId 保留；原页 fragment 保留，新课程来源可打开，旧课程 unchanged。
- [ ] 写失败测试：重复 confirm 同新 ID；50 门整批新 ID；第 2 门 rename/登记失败只清理事务创建内容；旧同名/同 ID 永远不覆盖；事务任何阶段重启恢复，不让 loadDashboardConfig 发现未提交课程。
- [ ] `npx vitest run src/server/course-restore.test.ts src/server/course-id-remap.test.ts src/server/course-restore-recovery.test.ts src/server/course-backup.integration.test.ts` 确认红。
- [ ] 先 decode 到 .learning-loop/restores/<UUID>，解析所有文件再建 preview；SHA-256 和实际长度均校验。remap 通过 frontmatter/资源表结构定位修改，重新跑课程/artifact/session 解析，禁止全文替换。
- [ ] 在 .learning-loop/ 暂存整批并保存事务日志和新 ID 列表；以发布锁逐个 rename、一次登记，明确 commit point；恢复前协调可信日志，再读取配置。watcher 失败不回滚已提交课程；中断前后均只操作带事务所有权的目录。
- [ ] 跑同命令确认绿；清理/事务回执支持启动及定期恢复，来源文件保持与归档字节一致，不执行内容。

### Task 4：设置页备份/恢复 UI 与最终验收

**Files:** 创建 client/components/CourseBackupPanel.tsx、CourseBackupPanel.test.tsx；修改 SettingsPage.tsx、SettingsPage.export.test.tsx、api.ts、styles.css、README.md；新增 tests/e2e/backup-restore.spec.ts；扩展 scripts/benchmark-pdf-import.mjs 本地恢复验证。

**Interfaces:** `CourseBackupPanel({courses})`；client/api 新增 preview/downloadBackup、uploadRestore、fetchRestore、confirmRestore、cancelRestore。下载用 Blob URL 且完成后 revoke，不把 250 MiB 文件转 Base64。

- [ ] 写失败测试：旧 JSON 导出仍可用，单/全部 ZIP 下载前展示原课件包含及隐私警告；失败能手动重试，不把 JSON 显示成完整备份。
- [ ] 写失败测试：恢复上传→预览→确认新课程→列表刷新无需重启；取消不建课，重复确认按钮锁定；损坏或超限错误可见；恢复不会默认替换已有课程。
- [ ] `npx vitest run src/client/components/CourseBackupPanel.test.tsx src/client/pages/SettingsPage.export.test.tsx` 确认红。
- [ ] 实现 UI 和真实 API 接入，同命令确认绿；浏览器完成创建课程→下载ZIP→上传ZIP→确认→查看原文件与学习证据，桌面/平板/移动都验收；隔离测试课程。
- [ ] 更新 README 限制/覆盖范围/安全恢复/取消；全量 `npm test`、`npm run build`、`npm run test:e2e`（cwd dashboard）通过。
- [ ] `node --import tsx/esm scripts/benchmark-pdf-import.mjs "D:\nju\大三\机器学习\机器学习.pdf"`（cwd dashboard）复验质量、草稿重启与备份恢复；临时目录内执行，记录时间/RSS/原文件 hash、剩余环境跳过项。不执行真实 API。

## 自审和交接

ZIP codec 是显式依赖能力门禁，不将 JSZip 默认成功误当作安全保证；批准实现方案前本批不能进入恢复编码。路径/大小/原文保留/失败事务都有具体测试。计划与规格的 24 小时恢复预览期限相容，草稿仍固定 7 天；确认回执防止重复。所有成功结论均需新鲜测试输出，不由计划预期代替。
