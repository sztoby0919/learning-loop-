# Learning Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sequentially deliver persistent mistakes and targeted re-practice, evidence-based review completion, and trustworthy source navigation.

**Architecture:** Keep `sessions/*.md` as the append-only answer history and `reviews.md` as the editable review schedule. Reuse the existing AI provider, server-side answer checking, file conflict protection, and controlled source-file route; Mock is visibly a demo and never advances real mastery.

**Tech Stack:** TypeScript, React, Express, gray-matter, Vitest, Supertest, Playwright, local Markdown.

**Spec:** `docs/superpowers/specs/2026-09-28-learning-closure-design.md`

## Global Constraints

- Preserve the user's modified `examples/demo-course/*.md` and existing untracked plan/spec files; stage only files owned by each task. Do not push Markdown without a fresh user request.
- No built-in question bank, new mandatory `mistakes.md`, account system, OCR, or live MoMA requirement.
- A question is four-option single choice; scoring is server-side, answer is hidden until submission, and an answer cannot be changed or submitted twice.
- Only confirmed real-model review attempts advance `reviews.md`; Mock records are explicitly `mock` and never change review dates or mastery.
- Every phase must finish with its focused tests, complete `npm test -- --reporter=dot --silent`, `npm run build`, and its Playwright flow green before the next phase starts.

## Review Focus

- A legacy session without knowledge-point metadata still appears as an unclassified mistake, never as a fabricated topic (Task 1 test).
- Two identical or malformed rows for one review topic are rejected without modifying either `reviews.md` or sessions (Task 4 test).
- Refresh/restart after saving loads the same attempts from Markdown, while an unsaved in-memory question is reported expired (Tasks 2 and 5 tests).
- A generated question identical to the source question is rejected, not silently presented as a new practice item (Task 2 test).
- A manual course without `source.<ext>` has no broken source action; unsupported or out-of-range positions return an explicit unavailable result (Task 6 test).

---

### Task 1: Session records and mistakes read API

**Files:** Create `dashboard/src/server/session-records.ts`, `dashboard/src/server/session-records.test.ts`; modify `dashboard/src/server/archive-proposal.ts`, `dashboard/src/server/assessment-manager.ts`, `dashboard/src/server/app.ts`, `dashboard/src/server/index.ts`, `dashboard/src/shared/course.ts`.

**Interfaces:** Produce `MistakeItem { id, courseId, question, selected, correct, explanation, knowledgePoint: string | null, date, sourceSession, mode: "real" | "mock" | "unknown" }`; legacy sessions use `unknown`, never `real` by assumption. `readMistakes(courseRoot: string, courseId: string): Promise<{ items: MistakeItem[]; warnings: string[] }>`; `renderAttemptSession(record: AttemptRecord): string`. Expose `GET /api/courses/:id/mistakes`. `AttemptRecord` includes `kind: "targeted-practice" | "review-attempt"`, one answered question, `mode: "real" | "mock"`, and confirmation date.

- [ ] **Step 1: Write failing tests** for a new diagnostic record with `知识点`, a legacy record without it, malformed neighboring file isolation, and no wrong item for a correct or unapplied diagnostic answer. Assert IDs are stable across reads.
- [ ] **Step 2: Run red**: `npm --prefix dashboard test -- src/server/session-records.test.ts`; expect the new API/function tests to fail.
- [ ] **Step 3: Implement** the codec and add knowledge-point/option/`real`-or-`mock` metadata to newly confirmed diagnosis sessions without changing the visible old format. Pass runtime mode from `index.ts` through `createApp` and `AssessmentManager` (default `mock` in tests). Limit reads to configured course roots and avoid returning the hidden answer for an unsubmitted question.
- [ ] **Step 4: Run green** for the focused test and `dashboard/src/server/archive-proposal.test.ts`; verify zero failures.
- [ ] **Step 5: Commit only owned code files** with `feat: index confirmed diagnostic mistakes`.

### Task 2: Targeted practice service and API

**Files:** Create `dashboard/src/server/practice-manager.ts`, `dashboard/src/server/practice-manager.test.ts`, `dashboard/src/server/practice.integration.test.ts`; modify `dashboard/src/server/ai-service.ts`, `dashboard/src/server/app.ts`, `dashboard/src/server/index.ts`, `dashboard/src/client/api.ts`, `dashboard/src/shared/course.ts`.

**Interfaces:** `PracticeManager.create({ courseId, mistakeId, kind: "targeted-practice" })` returns only a `PublicAssessmentQuestion`, `sessionId`, and mode. `answer(sessionId, questionId, choice: "A"|"B"|"C"|"D")` returns feedback; `confirm(sessionId)` writes a unique `sessions/YYYY-MM-DD-<id>.md` through `batchAtomicWrite(... expectedHash:null)`. Routes: `POST /api/practice-sessions`, `POST /api/practice-sessions/:id/answer`, `POST /api/practice-sessions/:id/confirm`.

- [ ] **Step 1: Write failing tests** for selected mistake context, nonidentical four-option question, answer secrecy, score 0/100, second-answer 409, confirmed durable real/mock record, repeated confirmation 409, model error, and unknown/expired session.
- [ ] **Step 2: Run red**: `npm --prefix dashboard test -- src/server/practice-manager.test.ts src/server/practice.integration.test.ts`; expect failures tied to missing service/routes.
- [ ] **Step 3: Implement** using `AiService.generateAssessmentQuestions` with count 1 and mistake-specific context. Reuse the runtime mode plumbing from Task 1; reject a normalized identical question or invalid provider output. Confirm only after answer, and publish the existing journal-updated event.
- [ ] **Step 4: Run green** for focused service/API tests and existing assessment integration tests.
- [ ] **Step 5: Commit owned code files** with `feat: add targeted practice sessions`.

### Task 3: Mistake and practice UI; phase-one gate

**Files:** Create `dashboard/src/client/pages/MistakesPage.tsx`, `dashboard/src/client/pages/MistakesPage.test.tsx`, `dashboard/src/client/components/PracticeFlow.tsx`, `dashboard/tests/e2e/mistakes.spec.ts`; modify `dashboard/src/client/App.tsx`, `dashboard/src/client/pages/CourseDetailPage.tsx`, `dashboard/src/client/styles.css`.

**Interfaces:** Course detail links to `/courses/:id/mistakes`; `PracticeFlow` consumes Task 2 API and is reused in Task 5. Mock mode is visible beside both the question and saved result.

- [ ] **Step 1: Write failing UI and browser tests**: wrong answer is listed only after confirmed diagnosis; create new question, submit once, view explanation, confirm, refresh and see saved attempt; Mock copy never says mastered.
- [ ] **Step 2: Run red** focused Vitest UI and desktop Playwright spec.
- [ ] **Step 3: Implement** course-scoped list, loading/empty/error states, accessible radio group, disabled resubmission, confirmation status, and SSE-driven refresh.
- [ ] **Step 4: Run green** focused UI/E2E, then `npm test -- --reporter=dot --silent` and `npm run build`; stop and repair on any failure.
- [ ] **Step 5: Commit owned UI/test files** with `feat: surface mistakes and re-practice`.

### Task 4: Review schedule writes and diagnosis-date correction

**Files:** Create `dashboard/src/server/review-completion.ts`, `dashboard/src/server/review-completion.test.ts`; modify `dashboard/src/server/archive-proposal.ts`, `dashboard/src/server/review-scheduler.ts`, `dashboard/src/server/review-scheduler.test.ts`.

**Interfaces:** `prepareReviewUpdate(rawReviews: string | null, params: { courseId, topic, date, isCorrect, priorConsecutiveCorrectReviews, evidence }): string` returns valid `reviews.md` content or a typed conflict. `nextIntervalDays(isCorrect: boolean, priorConsecutiveCorrectReviews: number): 1 | 3 | 7 | 30` implements reset-on-wrong and advancement-on-correct, capped at 30.

- [ ] **Step 1: Write failing tests** for +1 on wrong, +3/+7/+30 advancement on real correct attempts, blank diagnosis `lastReviewed`, unchanged nullable mastery, preservation of unrelated manual rows, missing-table creation, duplicate-row conflict, and malformed-table rejection.
- [ ] **Step 2: Run red**: `npm --prefix dashboard test -- src/server/review-completion.test.ts src/server/archive-proposal.test.ts src/server/review-scheduler.test.ts`.
- [ ] **Step 3: Implement** narrowly in existing table format; do not infer 1–10 mastery from one question or treat a planned date as evidence.
- [ ] **Step 4: Run green** focused tests and parser tests.
- [ ] **Step 5: Commit owned code/tests** with `feat: compute evidence-based review dates`.

### Task 5: Review attempt service, UI, and phase-two gate

**Files:** Modify `dashboard/src/server/practice-manager.ts`, `dashboard/src/server/practice.integration.test.ts`, `dashboard/src/client/pages/ReviewPage.tsx`, `dashboard/src/client/pages/ReviewPage.test.tsx`, `dashboard/src/client/App.tsx`, `dashboard/src/client/api.ts`; create `dashboard/tests/e2e/review-completion.spec.ts`.

**Interfaces:** Task 2 `create({ courseId, topic, kind:"review-attempt" })` accepts only a registered review topic. Real `confirm()` atomically writes review session plus prepared `reviews.md`; Mock `confirm()` writes only a marked demo session and returns `advanced:false`.

- [ ] **Step 1: Write failing tests** for due topic validation, real confirmation changing one row, mock confirmation not advancing, file-hash conflict leaving both files unchanged, duplicate confirmation, restart reload, and calendar/review refresh.
- [ ] **Step 2: Run red** focused service/API/UI tests and desktop Playwright review flow.
- [ ] **Step 3: Implement** reuse of `PracticeFlow` and `batchAtomicWrite`, with clear confirmation copy and visible status/error; ensure manually edited rows survive.
- [ ] **Step 4: Run green** focused tests, `npm test -- --reporter=dot --silent`, and `npm run build`; stop on failure.
- [ ] **Step 5: Commit owned files** with `feat: complete reviews with answer evidence`.

### Task 6: Source references and safe excerpt API

**Files:** Create `dashboard/src/server/source-references.ts`, `dashboard/src/server/source-references.test.ts`; modify `dashboard/src/server/course-import.ts`, `dashboard/src/server/app.ts`, `dashboard/src/shared/course.ts`.

**Interfaces:** `GET /api/courses/:id/source-references` returns `SourceReference[]` with `artifact: "course" | "notes"`, `headingIndex`, `heading`, `kind: "pdf-page" | "virtual-position"`, `position`, `sourceUrl`, `verifiedExcerpt: string | null`, and `aiDerived`. Derive references only from known generated `来源：原…` markers and an existing managed `source.<ext>`; source text called verified only after matching extracted content.

- [ ] **Step 1: Write failing tests** for a PDF true page, DOCX/HTML/text virtual label, AI-derived unverified note, manual course without source, invalid/out-of-range position, and a source path outside managed courses.
- [ ] **Step 2: Run red** focused reference and app-route tests.
- [ ] **Step 3: Implement** bounded source lookup: read only the requested PDF page with PDF.js, or use the existing text/Word/HTML extractors for a virtual position; cap returned excerpts at 500 characters. Add `aiStatus` to generated notes frontmatter, treat older files without it as unverified, and return `verifiedExcerpt:null` unless normalized non-AI note text actually matches extracted source. Preserve source-route `nosniff` and HTML sandbox; never interpolate arbitrary filesystem paths.
- [ ] **Step 4: Run green** focused server tests and import integration tests.
- [ ] **Step 5: Commit owned code/tests** with `feat: expose trustworthy course source references`.

### Task 7: Source UI, full regression, and handoff

**Files:** Create `dashboard/src/client/components/SourceReference.tsx`, `dashboard/src/client/components/SourceReference.test.tsx`, `dashboard/tests/e2e/source-reference.spec.ts`; modify `dashboard/src/client/pages/NotesPage.tsx`, `dashboard/src/client/pages/CourseDetailPage.tsx`, `dashboard/src/client/App.tsx`, `dashboard/src/client/api.ts`, `dashboard/src/client/styles.css`, `README.md`.

**Interfaces:** Render source action only if Task 6 confirms a managed source file exists; a source action does not imply its excerpt was verified. PDF link opens with `#page=N`; virtual positions say “估算位置”; AI notes say “待核对”. Existing manual courses remain unchanged.

- [ ] **Step 1: Write failing UI/browser tests** for all three labels and PDF link, missing source, keyboard-accessible link, and no false verbatim quote for AI-derived notes.
- [ ] **Step 2: Run red** focused tests and desktop Playwright spec.
- [ ] **Step 3: Implement** source cards in notes and course key points; update README with new workflow and Mock/real limits without touching unrelated Markdown.
- [ ] **Step 4: Run green** focused tests, full `npm test -- --reporter=dot --silent`, `npm run build`, and `npm run test:e2e`; verify `git diff --check` and a staged-file list excluding user Markdown.
- [ ] **Step 5: Commit only feature-owned files** with `feat: link imported notes to source documents`.
