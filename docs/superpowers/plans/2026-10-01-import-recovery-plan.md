# 导入质量与草稿恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PDF 质量提示能定位原页，已保存草稿刷新及重启可恢复，确认不重复建课。

**Architecture:** 保留 Markdown 建课流程，引入有界、版本化的磁盘 DraftStore；CourseImportManager 负责业务状态，存储模块负责验证和原子写入。启动先协调未完成提交，再加载课程配置，最后恢复草稿并启动服务。

**Tech Stack:** TypeScript、Node fs/promises、Zod、PDF.js、Express、React、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-01-import-control-and-backup-design.md` 第 1–5、8 节。

## Global Constraints

- 在当前工作区实施；保留全部既有修改；不 commit/push、不修改用户课程、不调用真实 MoMA。
- Node `^20.19.0 || >=22.12.0`；不安装新依赖；原文件上传限额不变。
- 草稿创建后固定 7 天到期；编辑停顿约 800 毫秒自动保存；只有已保存内容承诺恢复。
- 不新增 OCR、数据库、账号或“待核对”标识。
- 本计划完成后再执行 AI 计划；两批共用本计划定义的类型和修订契约。

## Review Focus

- 较慢保存的旧响应到达新输入之后，不能覆盖新输入（Task 4）。
- 相邻两次编辑都携带同一修订号，第二次不能静默覆盖（Task 3）。
- Windows junction/符号链接草稿目录及遗留孤儿文件不得越界清理（Task 2）。
- 崩溃发生在课程 rename 后、登记前，启动不能重复发布或删除成功课程（Task 3）。
- 页码列表重复、重叠、1,000 页长教材及来源过期，必须正确展示并明确失败（Task 1、4）。

## 文件与接口契约

创建 `dashboard/src/shared/course-import.ts`：统一前后端草稿类型，替代 client/api.ts 重复声明；保留 server/course-import.ts 类型再导出以减少调用迁移。

```ts
interface PdfQuality { version: 1; noTextPages: number[]; sideNotePages: number[]; complexPages: number[] }
interface ImportStage { id: string; title: string; tasks: string[]; source?: { title: string; startPage: number; endPage: number } }
interface ImportNote { title: string; page: number; content: string; stageId?: string; provenance?: "source" | "ai" }
// ImportDraft 保留原字段，stages/notes 使用以上类型，quality?: PdfQuality。
interface DraftEntry { version: 1; id: string; courseId: string; revision: number; createdAt: number; updatedAt: number; expiresAt: number; state: "open" | "committing" | "committed"; draft: ImportDraft; source: ExtractedDocument; sourceExtension: string }
interface DraftSummary { id: string; title: string; updatedAt: number; expiresAt: number; status: "ready" | "invalid"; warning?: string }
// CourseImportPreview 保留旧字段，增加 revision、expiresAt、sourceUrl。
```

客户端不得修改 source、quality、references、provenance；新增阶段由服务端分配 ID，已有 ID 必须属于当前草稿。阶段来源范围按完整有效 PDF 提纲定位，末章截止下一有效目录项前页或文档末页；排除辅助内容，不把附录当作学习阶段。

### Task 1：结构化质量数据与稳定阶段标识

**Files:** 创建 shared/course-import.ts；修改 server/course-import.ts、pdf-extractor.ts、client/api.ts；测试 server/pdf-extractor.test.ts、course-import.test.ts。

**Interfaces:** ExtractedDocument 增加 `quality?: PdfQuality`；`createBasicDraft(source, filename): ImportDraft` 生成稳定阶段 ID、来源范围及原文 provenance；移动不重建 ID。解析未知旧 provenance 保守处理。

- [ ] 写失败测试：`quality reports physical page categories`，用现有 PDF fixture 混合正文/无文字/旁注页，断言 noTextPages、sideNotePages、complexPages 的实际数组及类别交集；非 PDF 无 quality。
- [ ] 写失败测试：阶段重命名/移动仍保留 id，附录链接不变，原文 notes 标为 source；来源末页不越界，辅助目录不能成为正文来源。
- [ ] 运行 `npx vitest run src/server/pdf-extractor.test.ts src/server/course-import.test.ts`（cwd dashboard）；预期新增断言失败。
- [ ] 提取共享类型并实现以上数据，不从 warnings 字符串解析页码，保留五个文件输出及旧调用兼容。
- [ ] 再跑同命令；预期全部通过，记录红绿结果。

### Task 2：磁盘草稿存储与安全清理

**Files:** 创建 server/course-import-store.ts、course-import-store.test.ts；修改 course-import-manager.ts 的存储调用。

**Interfaces:** `DraftStore(root: string, now: () => number)` 提供 `create(entry: DraftEntry, bytes: Uint8Array): Promise<void>`、`read(id: string): Promise<DraftEntry>`、`list(): Promise<DraftSummary[]>`、`replace(entry: DraftEntry, expectedRevision: number): Promise<void>`、`delete(id: string): Promise<void>`、`cleanupExpired(): Promise<void>`、`sourcePath(id: string): Promise<string>`。受管路径为 `.learning-loop/imports/<UUID>/state.json` 和 `source.<ext>`；不保存任意路径。

- [ ] 写失败测试：创建/读取及新 Store 实例恢复完全一致；expiresAt 为 createdAt + `7*24*60*60*1000`，修改不延长；第 7 天到期拒绝读取并清理。
- [ ] 写失败测试：原子写入失败保留旧 revision 和内容；坏 JSON/未知版本/超范围页码/超限快照隔离为 invalid；健康草稿仍可列表读取。
- [ ] 写失败测试：UUID 越界、root/source/state 链接及特殊文件拒绝；到期清理不触碰外部哨兵；老版 `<UUID>.<ext>` 只按原 24 小时孤儿规则清理。Windows 无权限创建链接时单独注明跳过。
- [ ] 运行 `npx vitest run src/server/course-import-store.test.ts` 确认红。
- [ ] 实现 schema 校验、每 ID 串行锁、expectedRevision CAS、临时文件原子 rename；快照读取先 stat 限额 32 MiB，教材全文与各字段仍按页数/既有文本限额校验，超限明确拒绝而非截断。清理前验证绝对及 realpath 归属，不跟随链接。
- [ ] 跑同命令确认绿；验证删除只影响该草稿，密钥不进入任何状态。

### Task 3：修订号 API、恢复和幂等确认

**Files:** 修改 course-import-manager.ts、app.ts、index.ts、dashboard-config.ts；创建 server/course-import-recovery.ts、course-import-recovery.test.ts；测试 manager.test.ts、import.integration.test.ts、dashboard-config.test.ts。

**Interfaces:** Manager 增加 `initialize(): Promise<void>`、`list(): Promise<DraftSummary[]>`，preview/update 改为 async；`update(id, input: {expectedRevision, title, goal, weeklyHours, stages}): Promise<CourseImportPreview>`；`confirm(id, expectedRevision: number): Promise<{courseId: string}>`。恢复函数 `recoverImportCommits(projectRoot: string): Promise<void>` 在 loadDashboardConfig 自动发现前运行。

新增 GET `/api/course-imports`、GET `/api/course-imports/:id/source`；PATCH 要求 expectedRevision；确认 POST 携带 expectedRevision；现有 GET/DELETE 保留。来源接口通过 Store 返回安全文件，404/410/409/422 均返回可理解提示；app.ts 所有 async 路由转 next(error)。

- [ ] 写失败测试：两个同 revision PATCH 仅一个成功、另一个 409；重启 Manager 后列表/preview/source 恢复；未修改 schema 内容的请求不能改 source/quality/附录元数据。
- [ ] 写失败测试：并发确认只创建一个目录；已提交重复确认返回同 courseId；注入 rename 前、rename 后、登记前、登记后进程中断状态，再初始化协调为可重试或已成功；预先存在而非本事务拥有的目录绝不覆盖/删除。
- [ ] 写失败测试：已登记但 watcher 失败仍可用；坏快照不阻塞启动；来源已取消/过期不可读取；启动顺序防止重复 ID/半成品自动发现。
- [ ] 运行 `npx vitest run src/server/course-import-manager.test.ts src/server/course-import.integration.test.ts src/server/course-import-recovery.test.ts src/server/dashboard-config.test.ts` 确认红。
- [ ] 实现存储接入与 revision CAS；提交事务记录包含操作 ID、受管目标、预分配 courseId 和状态。恢复只协调可信事务拥有的路径；新课程成功后留小型 committed 回执直至原 7 天到期，删除上传副本；失败清理暂存并保留可重试草稿。
- [ ] 新服务与测试服务都 await initialize；更新旧同步 preview/update 调用及接口测试，跑同命令确认绿。

### Task 4：自动保存、恢复入口与质量报告 UI

**Files:** 创建 client/hooks/useImportAutosave.ts、useImportAutosave.test.tsx、client/components/ImportQualityReport.tsx、ImportQualityReport.test.tsx；修改 CourseImportPage.tsx、CourseImportPage.test.tsx、api.ts、styles.css；新增 tests/e2e/import-recovery.spec.ts。

**Interfaces:** `useImportAutosave(preview, onSaved)` 提供 `{status, error, flush(): Promise<CourseImportPreview>, reload(): Promise<void>}`；`ImportQualityReport({quality, sourceUrl})`。api 新增 `listCourseImports()`、`fetchCourseImport(id)`；PATCH/confirm 带 revision；客户端错误保留 HTTP status 供冲突交互。

- [ ] 写失败测试：800ms 防抖、快速多次输入仅保存最新内容；deferred Promise 旧响应不覆盖新输入；保存失败展示失败而非已保存；无效临时编辑不发送 PATCH；离开未保存内容提示。
- [ ] 写失败测试：上传后 URL 保存草稿 ID，刷新读取；恢复列表能继续/确认删除；冲突不能自动覆盖，重载须提示丢弃当前未保存编辑；删除失败不假装删除成功。
- [ ] 写失败测试：质量分类 counts 和分页页码（每页 50 个）准确，点击 #page=N 物理页；1,000 页不横向溢出，无文字文案不直接称扫描；非 PDF 不显示 PDF 质量。
- [ ] 运行 `npx vitest run src/client/pages/CourseImportPage.test.tsx src/client/hooks/useImportAutosave.test.tsx src/client/components/ImportQualityReport.test.tsx` 确认红。
- [ ] 实现自动保存队列、输入版本与服务器修订分离；所有 preview/AI/confirm 入口 flush；草稿来源在新标签页打开，rel=noopener；服务端请求错误可见。
- [ ] 同命令确认绿；增加真实服务浏览器测试：编辑→等待已保存→刷新恢复→打开问题原页→建课；恢复重启由接口测试实际重建 Manager 证明，不以浏览器模拟冒充。
- [ ] 更新 README 本批边界；跑 `npm test`、`npm run build`、`npm run test:e2e`（cwd dashboard），所有非环境限制测试通过再进入下一批。

## 自审和交接

已将质量类别、过期清理、修订冲突、输入乱序、提交恢复和客户端继续入口映射到具体任务及测试。没有未定义实现接口；共享类型扩展进入下一批计划。不创建工作树、不自行提交；等待用户核对计划后按选择的执行方式实施。
