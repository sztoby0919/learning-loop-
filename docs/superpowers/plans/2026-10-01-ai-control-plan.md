# 可控 AI 建议与取消 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户看清发送摘录与 AI 修改，按章节接受/拒绝、撤销最近应用，并能安全取消请求。

**Architecture:** 依赖第一批 DraftStore/revision/stageId/source 范围；AI 调用返回独立候选而非覆盖草稿。发送预览、操作状态、候选应用三个模块共享 revision 契约，逐条笔记 provenance 驱动来源核对。

**Tech Stack:** TypeScript、Node AbortController、Express、React、Zod、Vitest、Playwright；兼容当前 Chat Completions。

**Spec:** `docs/superpowers/specs/2026-10-01-import-control-and-backup-design.md` 第 1–3、6、8 节；先完成 `2026-10-01-import-recovery-plan.md`。

## Global Constraints

- 当前工作区、无 commit/push、新依赖或真实 MoMA；保留旧课程兼容。
- 每章最多开头两页、每页 1,200 字符，全摘录 payload 最多 24,000 字符；不声称覆盖全书。
- 90 秒超时；每草稿一个请求；无自动重试、无假百分比；取消不承诺停止上游计费。
- 手工无 source 范围阶段不能完善；附录与未选择章节不变；不显示“待核对”。

## Review Focus

- 目录标题本身超长导致截断落在页码标记中，不得显示“已发送”但未完整发送的页（Task 1）。
- 模型错误/恶意复制另一个阶段 ID 或同页章节笔记，不能误应用到邻章（Task 1、3）。
- cancel 和完成同时到达，取消成功后不能落盘候选（Task 2）。
- 同一标签页连续点击、另一个标签页编辑和重启，不能重复付费请求/应用（Task 2、3）。
- 只替换一章时，全局 aiStatus 不能让其余原文被误认为 AI 归纳（Task 3）。

## 类型与文件映射

在 shared/course-import.ts 增加：

```ts
interface AiExcerpt { revision: number; stageIds: string[]; excerptHash: string; text: string; pages: Array<{stageId: string; page: number; text: string}>; chars: number }
interface AiSuggestion { stageId: string; title: string; tasks: string[]; notes: ImportNote[] }
interface AiCandidate { id: string; baseRevision: number; suggestions: AiSuggestion[] }
interface AiOperation { id: string; status: "running" | "complete" | "cancelled" | "failed" | "interrupted"; startedAt: number; candidate?: AiCandidate; error?: string }
// DraftEntry 增加 candidate?、operation?、undo?: {appliedRevision: number; before: ImportDraft}。
```

### Task 1：精确发送预览和候选 schema

**Files:** 新增 server/course-import-excerpt.ts、course-import-excerpt.test.ts；修改 course-import-ai.ts、course-import-ai.test.ts、shared/course-import.ts。

**Interfaces:** `buildAiExcerpt(entry: DraftEntry, stageIds: string[]): AiExcerpt`；`createCourseImportAi(config, fetcher)(excerpt: AiExcerpt, draft: ImportDraft, signal: AbortSignal): Promise<AiSuggestion[]>`；调用者传递取消信号，adapter 合并 90 秒 signal；验证页码属于该 stageId 的实际 pages，而非仅文档全局范围。

- [ ] 写失败测试：选择第二章仅包含该章 source 范围开头两页、每页 <=1,200；整体 text <=24,000，实际截断页和显示 pages 一致；排除空页、未选章、辅助及附录；无来源阶段、空选择、重复/未知 ID 拒绝。
- [ ] 写失败测试：模型返回额外/遗漏/重复阶段 ID、别章合法页码、空字段均拒绝；JSON 包装仍兼容；每次调用只发送 preview.text 及同一用户元信息；超长课程目标等按原 schema 验证。
- [ ] `npx vitest run src/server/course-import-excerpt.test.ts src/server/course-import-ai.test.ts` 确认红。
- [ ] 实现确定性的发送文本；按完整条目装入字符预算，页码及目录标记不截成半条；hash 覆盖实际请求用户元信息、revision、选择与摘录。现有公式保守提示保留；不加入未发送全书说明之外的正文。
- [ ] 跑同命令确认绿，无 API Key 日志或候选持久化。

### Task 2：操作生命周期、等待及服务端取消

**Files:** 新增 server/course-import-ai-operations.ts、course-import-ai-operations.test.ts；修改 manager.ts、app.ts、index.ts、store.ts 及对应测试。

**Interfaces:** `ImportAiOperations.start(id, {expectedRevision, stageIds, excerptHash, consent}): Promise<AiOperation>`、`get(id, operationId): Promise<AiOperation>`、`cancel(id, operationId): Promise<AiOperation>`。持久化运行状态后启动后台 Promise，所有拒绝捕获并落可理解错误；Controller 只驻内存、不写快照。

API：POST `/api/course-imports/:id/ai-excerpt` 返回发送预览（零调用）；POST `/:id/ai-operations` 返回 202；GET `/:id/ai-operations/:operationId`；DELETE 同路径取消。旧 /enrich 不能继续直接覆盖草稿：前后端及旧测试迁移后返回明确兼容错误或移除入口，禁止两套行为并存。

- [ ] 写失败测试：未同意/发送 hash 过时/修订过时零调用；双 start 仅一次 fetch；cancel signal 确实 aborted，故意忽略 signal 的 fake 迟到结果也不能落候选。
- [ ] 写失败测试：fake clock 90 秒超时、取消/完成交错、断连及重启 running→interrupted，无启动重发；其他标签页 PATCH 运行中 409；完成候选不改变 draft.stages/notes/revision。
- [ ] `npx vitest run src/server/course-import-ai-operations.test.ts src/server/course-import-manager.test.ts src/server/course-import.integration.test.ts` 确认红。
- [ ] 实现每草稿锁、operationId 守卫及存储失败恢复；cancel 标记持久化后 abort；最终结果在同锁内核对当前操作、baseRevision 与取消状态。源文件仅在请求运行中保留，删除草稿先取消任务再删除。
- [ ] 跑同命令确认绿；AI 失败不把既有 source 原文或已应用 AI provenance 擦掉。

### Task 3：部分应用、撤销及混合来源

**Files:** 新增 server/course-import-suggestions.ts、course-import-suggestions.test.ts；修改 manager.ts、course-import.ts、source-references.ts、source-references.test.ts 及 shared types。

**Interfaces:** `applyAiSuggestions(entry, candidateId: string, acceptedStageIds: string[], expectedRevision: number): DraftEntry`、`undoAiSuggestions(entry, expectedRevision: number): DraftEntry`，纯状态变换，Manager 使用 Store CAS 写入。API POST `/:id/ai-candidates/:candidateId/apply`、DELETE 同路径拒绝全部、POST `/:id/ai-undo`。

- [ ] 写失败测试：仅接受一章，其余 stage、笔记、目标、周时间和 references 字节级不变；模型 notes 全部 provenance=ai；拒绝不改草稿；未知接受 ID 或候选过时 409。
- [ ] 写失败测试：一次应用 revision+1，重复请求不再次应用；撤销最近应用恢复 before，revision 单调递增；编辑后撤销失效，不删用户新编辑；重启后未过期撤销仍可用。
- [ ] 写失败测试：混合 source/ai 笔记保存并解析后，source 仍核对成功、ai 仍不标直接原文；旧 fenced-text-v2 和 escaped-line-v1 无逐项 metadata 时保持保守兼容；伪造 metadata 不免除原文实际匹配。
- [ ] `npx vitest run src/server/course-import-suggestions.test.ts src/server/source-references.test.ts src/server/course-import.test.ts` 确认红。
- [ ] 实现阶段绑定 notes 和最近一次 undo；任意成功编辑使 candidate/undo 失效。生成 Markdown 时写版本化、按稳定 heading 对应的笔记 provenance 元数据，来源读取须验证映射位置与 marker，而非允许正文改写标签突破核对。
- [ ] 跑同命令确认绿；附录参考 links 始终来自本地 references，不依赖 AI notes。

### Task 4：发送确认、对比及取消 UI

**Files:** 新建 client/components/ImportAiPanel.tsx、ImportAiPanel.test.tsx；修改 CourseImportPage.tsx、api.ts、styles.css；新增 tests/e2e/import-ai-control.spec.ts 及隔离假上游 fixture。

**Interfaces:** `ImportAiPanel({preview, flush, onPreviewChanged})`；api 逐一实现 Task 1–3 路由，轮询仅 GET 操作状态，不重发 POST。UI 选择变更清空旧 consent/excerptHash。

- [ ] 写失败测试：手工阶段不可选；改变选择需重新同意；展开能看到实际页码、字符数和正文；点击前不调用 AI；启动先 flush 保存。
- [ ] 写失败测试：运行时秒数增长/转圈/取消可点击/其余修改冻结；取消失败不谎报已取消；导航卸载清理轮询和计时器，不因重新挂载重复 start；恢复页读取服务器已存在 operation。
- [ ] 写失败测试：两章原/新内容对比，部分接受、拒绝、撤销、冲突后重载；停止轮询后的旧响应不覆盖新状态；Keyboard/窄屏可操作，不展示待核对。
- [ ] `npx vitest run src/client/components/ImportAiPanel.test.tsx src/client/pages/CourseImportPage.test.tsx` 确认红。
- [ ] 实现轮询约 1 秒、实际等待秒数、取消计费说明及应用/撤销；完整请求失败保留草稿且只支持用户主动重试。
- [ ] 同命令确认绿；浏览器假上游覆盖发送范围、部分接受、撤销、挂起取消后迟到、重新载入候选；不调用真实 MoMA。
- [ ] 更新 README；`npm test`、`npm run build`、`npm run test:e2e`（cwd dashboard）全部通过，再进入备份批次。

## 自审和交接

共享类型沿用第一批，无隐式阶段下标关联；每个来源范围、候选、操作与撤销均绑定稳定 ID/revision。新增返回方式必须连带迁移原 manager、app、client、integration 和 E2E 测试，不留旧直接覆盖路径。等待计划审阅与执行方式确认。
