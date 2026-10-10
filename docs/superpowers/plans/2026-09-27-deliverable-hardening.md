# Learning Loop 交付收尾 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让已添加的导入、统计、复习、导出及深色模式功能达到真实可用、测试通过的交付状态。

**Architecture:** 保持现有 Express API、课程 Markdown 目录和 React 页面。导入沿用 `ExtractedDocument` → `ImportDraft` → `buildCourseFiles`；统计和复习从课程真实记录派生；JSON 导出只备份文本课程数据，不嵌入原课件。

**Tech Stack:** TypeScript、React、Express、Vitest、Playwright、PDF.js、mammoth。

**Spec:** `docs/superpowers/specs/2026-09-27-deliverable-hardening-design.md`

## Global Constraints

- 本地单用户，不增加账号或多人存储。
- 原 PDF、Word、HTML、文本课件保存在课程目录，但不嵌入 JSON 导出。
- 事实类统计只从真实学习记录派生；无数据时显示空态。
- 用户的 `.md` 文件以及本计划、设计说明均不纳入 Git 推送。
- 当前工作区已有未提交改动；不得重置或覆盖用户文件。

## Review Focus

- 空白或损坏的 DOCX/HTML/TXT：明确报错，不生成半成品课程；Task 1 测试。
- 多标题短文档：全部有效标题保留且引用序号有效；Task 1 测试。
- 上传中断后重试：同一文件再次发起 XHR，而非仅隐藏错误；Task 2 测试。
- 没有学习记录或记录跨月：图表与复习日历不伪造、不遗漏；Task 3、4 测试。
- 某课程缺少可选文件或 sessions 目录：导出仍成功并保留已有数据；Task 5 测试。

---

### Task 1: 文档解析与课程文件语义

**Files:** `dashboard/src/server/{docx,html,text}-extractor.ts`、`course-import.ts`、`course-import-manager.ts`、`app.ts`；对应 `*.test.ts` 与 `course-import.integration.test.ts`。

**Interfaces:** 保留 `extractDocx/extractHtml/extractText(bytes, filename): Promise<ExtractedDocument>` 和 `createBasicDraft(source, filename): ImportDraft`；`sourceFormat` 不单独推断扩展名，原始安全扩展名来自上传文件名。

- [ ] 增加短文档多标题、真实 DOCX 成功样本、各格式错误状态和原始扩展名的失败测试。
- [ ] 运行相关 Vitest 文件，确认失败指向现有解析/确认逻辑。
- [ ] 修正标题引用、文本来源文案、原文件保存名与资源 MIME；保留每格式大小上限及 DOCX 60 秒保护。
- [ ] 运行同组测试，确认通过。

### Task 2: 上传交互及定时清理

**Files:** `dashboard/src/client/{api.ts,pages/CourseImportPage.tsx,pages/CourseImportPage.test.tsx}`、`dashboard/src/server/{course-import-manager.ts,index.ts}`。

**Interfaces:** `uploadCourseFile(file, onProgress?)` 保持 XHR；重试使用失败时保留的 `File`；只由服务启动处创建一个小时清理定时器。

- [ ] 为 XHR 进度、拖放、真正重试、失败提示、成功高亮和阶段排序编写/更新行为测试。
- [ ] 运行页面测试，确认失败原因是当前 XHR mock 缺失或重试未执行。
- [ ] 用共享 `upload(File)` 路径修复交互，移除重复清理定时器。
- [ ] 运行页面和导入管理器测试，确认通过。

### Task 3: 真实学习统计与主题兼容

**Files:** `dashboard/src/server/workspace-repository.ts`、`dashboard/src/shared/course.ts`、`dashboard/src/client/components/StatsCharts.tsx`、`dashboard/src/client/preferences.ts`、统计/页面测试。

**Interfaces:** 扩展现有 `LearningStats`，提供每自然日实际记录数和连续天数；客户端只展示服务端给出的真实计数。`usePreferences()` 在 `matchMedia` 不可用时保持手动主题正常。

- [ ] 写日期边界、无记录、跨课程同日去重、主题无 `matchMedia` 的失败测试。
- [ ] 运行测试观察失败。
- [ ] 删除模拟柱形图及模拟 streak，计算真实每日记录和连续天数，补主题降级。
- [ ] 运行相关测试确认通过。

### Task 4: 去重的复习提醒和日历

**Files:** `dashboard/src/server/{review-scheduler.ts,workspace-repository.ts,review-scheduler.test.ts}`、`dashboard/src/shared/course.ts`、必要的日历测试。

**Interfaces:** `scheduleReviewsForCourse(course): ScheduledReview[]` 每条学习记录至多产生一个当前待办。`StudyRecord` 没有阶段字段时标记“全课程”，不得任意关联阶段；已有 `reviews.md` 明确指定的下次复习日期优先。`getDueReviews` 保持限量语义；日历按月份获取提醒，不复用仅显示近 7 天的待办截断结果。

- [ ] 写多阶段单记录、已复习、未来 30 天、跨月及日期边界失败测试。
- [ ] 运行测试观察失败。
- [ ] 以记录日期和明确的复习计划推导提醒，统一日期口径与日历查询；不根据掌握度伪造复习次数。
- [ ] 运行调度、API 和日历测试确认通过。

### Task 5: JSON 完整学习数据导出

**Files:** `dashboard/src/server/{workspace-repository.ts,app.ts}`、`dashboard/src/client/api.ts`、接口测试。

**Interfaces:** `exportCourse(courseId)` 与 `exportAllData()` 的 `files` 键为课程目录相对路径，包含五类主 Markdown 与 `sessions/*.md`；返回格式有版本号，不含原课件二进制。

- [ ] 写单课程、全量、缺少可选文件、未知课程的失败测试；断言 sessions 被包含且课件不在 JSON。
- [ ] 运行测试观察失败。
- [ ] 以安全相对路径读取课程文本文件，统一两个导出接口和错误码。
- [ ] 运行接口测试确认通过。

### Task 6: 最终集成与选择性推送

**Files:** 上述各文件及必要的浏览器流程测试；不修改或暂存用户 `.md` 文件。

- [ ] 运行 `npm test`，修复所有回归；运行 `npm run build` 与 `npm run test:e2e`。
- [ ] 对照截图逐项人工审查真实数据流、文件大小、深色模式和资源可访问性。
- [ ] 用 `git status` 和 `git diff --cached --name-only` 核对暂存清单：不得有任何 `.md`。
- [ ] 仅当测试及构建均通过时提交、推送非 `.md` 改动；推送受环境限制时报告明确原因。
