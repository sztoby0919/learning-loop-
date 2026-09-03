# Website-facing course archive

Use this contract only when the learner explicitly requests a website-readable local course archive or names the standard course files. Markdown is the source of truth; the website is read-only.

## Inputs and preflight

Require or safely confirm:

- course directory (absolute path);
- `courseId` using only lowercase letters, digits, and hyphens;
- course title, accent color as `#RRGGBB`, and display order when the website requires them.

Before writing, recursively inspect relevant course materials, README files, syllabi, assignments, lab instructions, code, test output, existing roadmaps/progress/checklists, mistake logs, resources, and session records. Read existing target files before editing them. Preserve original files and unfamiliar free-form text; migrate useful facts into the standard files without deleting their source.

Never invent a study date, duration, deadline, resource, score, completion state, personal mistake, test result, or code artifact. Passive reading, environment setup, and planning are not mastery evidence. Mark `[x]` only for active recall, an independent explanation, runnable code, test results, or completed coursework that meets the task's stated acceptance criterion. Mastery must be an integer from 1 to 10 or blank.

## Standard layout

Create or update only the requested course-root files:

```text
<course-dir>/
  course.md
  notes.md
  reviews.md
  resources.md
  schedule.md
  sessions/YYYY-MM-DD[-n].md
```

Use UTF-8 and `YYYY-MM-DD` dates. Do not create an empty session merely to populate the directory. Do not use `TBD` or `TODO` placeholders.

## `course.md`

Use this frontmatter exactly, substituting real metadata and the date of the actual archive modification:

```yaml
---
id: <courseId>
title: <course title>
shortTitle: <course title>
accent: "#RRGGBB"
updated: YYYY-MM-DD
order: <positive integer>
archived: false
---
```

Use exactly these level-two headings in this order:

```markdown
# <course title>

## 课程概览
## 学习路线
## 关键知识
## 易错点
## 学习记录
```

`课程概览` gives 1-3 source-grounded paragraphs about the goal, current evidence, materials, and practice project. Do not report a made-up completion percentage.

`学习路线` has 4-8 `### <stage name>` stages. Each stage contains 3-6 concrete checkbox tasks with observable acceptance criteria. The first unchecked task is the website's next step. Preserve supported existing checks; unknown work stays unchecked.

`关键知识` uses third-level topics to explain concepts, formulas, algorithms, code patterns, and their relationships in plain language. It may contain Markdown, GFM tables, KaTeX, and code blocks.

`易错点` records only personal errors supported by learning records or issues explicitly emphasized by course materials. Each entry has this shape:

```markdown
### <problem name>

- 问题：<observed error or confusion>
- 原因：<why it happens>
- 正确理解：<verified correction>
```

If no supported personal error exists, write `暂无个人易错点记录`.

`学习记录` uses this exact table. Keep it empty except for the header when no real record exists:

```markdown
| 日期 | 学习内容 | 掌握度 1-10 | 遇到困难 | 下一步 |
| --- | --- | ---: | --- | --- |
```

## `notes.md`

````markdown
---
courseId: <courseId>
updated: YYYY-MM-DD
---

# <course title>笔记

## <topic>

### 核心问题
<what the topic solves>

### 我的理解
<the learner's own words or a clearly labeled source-grounded note>

### 公式或代码
```text
<only needed formula, pseudocode, or code>
```

### 验证证据
<practice, output, test, or retrieval result; otherwise 尚未验证>
````

Keep real existing notes; do not claim a concept has been personally mastered merely because source material explains it.

## `reviews.md`

```markdown
---
courseId: <courseId>
updated: YYYY-MM-DD
---

# <course title>复习计划

| 知识点 | 上次复习 | 下次复习 | 掌握度 1-10 | 复习证据 |
| --- | --- | --- | ---: | --- |
```

The learner sets `下次复习`; leave it blank without a real date. Extract a row from a supported mistake or learning record only when its evidence is preserved.

## `resources.md`

```markdown
---
courseId: <courseId>
updated: YYYY-MM-DD
---

# <course title>学习资源

| 名称 | 类型 | URL 或本地路径 | 对应阶段 | 使用状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
```

Include only real resources. Local resources use absolute paths. Network resources use direct real URLs, verified when a recommendation or current claim is involved. Listing a resource is not completion evidence.

## `schedule.md`

```markdown
---
courseId: <courseId>
updated: YYYY-MM-DD
---

# <course title>日程

| 日期 | 类型 | 标题 | 对应阶段 | 状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
```

Record only known real dates. Leave only the header when no course event is known; do not duplicate session or review dates because the website can merge them.

## `sessions/`

Create a session file only for a real learning record, named `YYYY-MM-DD[-n].md`. Use this structure:

```markdown
# YYYY-MM-DD 学习记录

## 本次目标
## 完成内容
## 主动回忆或实践证据
## 暴露的问题
## 修正后的理解
## 下一步
```

Record only observed work. The next step must be one concrete action.

## Synchronization and validation

On a later real learning save, append or create the dated session, merge supported entries into `course.md`, and update `notes.md`, `reviews.md`, `resources.md`, or `schedule.md` only if new evidence belongs there. Never rewrite all files just because a session occurred.

Before reporting completion, verify:

1. required `course.md` headings and frontmatter fields exist, and ID/color/date formats are valid;
2. every completed checkbox has evidence and every mastery value is an integer 1-10 or blank;
3. each table has consistent columns;
4. no invented facts or placeholder words remain;
5. original source materials still exist; and
6. standard files do not contradict each other.

Report the files created or updated, migrated sources, information left blank for lack of evidence, completed/total task count, current stage and next step, and any dates, mastery values, resources, or schedule facts still needed from the learner.
