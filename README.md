# Learning Loop

Learning Loop 把学习过程整理成可持续的反馈闭环：诊断目标、制定路线、主动回忆、实践、修复薄弱点，并把结果保存在 Markdown 学习档案中。本地 dashboard 支持从文档创建课程、查看学习统计和复习提醒，也可完成四选一单选诊断、预览修改并在确认后写回档案。每题提交后由服务端判分并显示解析，不能重新作答。

## 快速开始

需要 Node.js 20.12 或更高版本。

```bash
git clone <your-repository-url>
cd learning-loop-project
npm install
npm run dashboard
```

打开 <http://127.0.0.1:3000>，默认会显示 `examples/demo-course`。

### 从文档创建课程

打开“课程”→“从文档创建课程”，选择或拖入一个文件：

| 格式 | 支持内容 | 单文件上限 |
| --- | --- | --- |
| PDF | 可提取文字的课件或教材 | 100 MB、1,000 页 |
| Word `.docx` | 正文及标题结构，包括常见的中文“标题 1”等样式 | 50 MB |
| HTML `.html` / `.htm` | 正文及 `h1`–`h3` 标题 | 20 MB |
| Markdown `.md` / `.markdown`、纯文本 `.txt` | 正文及可识别的 Markdown 标题 | 10 MB |

非 PDF 文件最多处理约 1,000 页等价的文本长度；页面展示的“段文本”不是原文件的真实页码。网站先在本地提取内容并生成课程草稿，随后可修改课程名、学习目标、每周学习时间、阶段顺序及任务。点击“更新预览”可检查即将写入的文件；点击“确认创建课程”时也会自动保存当前编辑。创建后立即跳转到新课程，课程列表无需重启即可看到。上传时显示进度，失败后可重试，取消则不会建课。

新课程保存在项目根目录 `learning-journal/<课程 ID>/`，包含 `course.md`、`notes.md`、`reviews.md`、`resources.md`、`schedule.md`、空的 `sessions/` 以及原始文档 `source.<扩展名>`。原始文档自动列入“资源”，可从资源页打开。手工配置的课程与自动导入的课程分开管理。

“AI 完善草稿”是可选步骤，只有勾选同意并点击按钮后，才会把课程名称、填写的学习目标和每周学习时间，以及目录及代表性内容摘录（最多约 24,000 字符，不发送完整文档）发给配置的模型 API。未配置 API、Mock 模式或 AI 调用失败时，仍可创建基础课程。AI 对长教材只生成章节级起点，不保证逐页覆盖；请对照原文核查公式、表格、图片及笔记。扫描版和加密 PDF 暂不支持。没有学习证据的掌握度不会自动填写；日程只提取原文中明确写出的日期。

### 学习统计、复习与导出

- “统计”根据已有学习记录显示每周活动、连续学习天数、课程进度和待处理复习；没有记录时不会伪造数据。
- 学习记录会生成第 1、3、7、30 天的计划复习提醒，并显示在“复习”和“日历”。提醒只是计划，不代表已经完成复习；未记录证据时会明确标注，逾期提醒不会自动跳过。已有手工复习计划时优先使用手工记录。
- “设置”可切换深色模式，选择保存在当前浏览器的 `localStorage`。同页的“导出全部数据”会下载 JSON，包含已登记课程的 Markdown 文件和学习记录，但**不包含**原始 PDF、Word 等课件；这不是一键恢复备份。单课程也提供 JSON 导出接口。

未填写任何模型参数时，诊断会使用离线 Mock 模式，适合演示交互，但不能代表真实模型的诊断质量。使用移动云 MOMA 或其他 OpenAI 兼容的文本 Chat Completions API 时，将 `.env.example` 复制为项目根目录的 `.env`，填写 `AI_BASE_URL`（基础地址，通常包含 `/v1`，不要包含 `/chat/completions`）、`AI_API_KEY` 和 `AI_MODEL`，再重启服务。三项必须一起填写；部分填写或保留示例值会在启动时提示配置错误，不会悄悄进入 Mock。需要暂时离线演示时可设置 `AI_MODE=mock`。`.env` 已被 Git 忽略；不要把密钥提交到仓库或发送到聊天中。课程材料和作答会发送给所配置的模型服务，请勿直接使用敏感资料。

常用命令：

```bash
npm run dashboard:dev   # Vite + Express 开发模式
npm test                # 单元测试
npm run build           # 类型检查和生产构建
npm run test:e2e        # Playwright 浏览器测试
```

## 使用 `$learning-loop`

根目录本身就是一个可安装的 Codex skill，直接包含 `SKILL.md` 和 `agents/openai.yaml`。将仓库根目录安装为名为 `learning-loop` 的 skill 后，在 Codex 中调用：

```text
$learning-loop 帮我系统学习一个新主题，并维护学习档案
```

skill 会在当前学习项目中维护 `learning-journal/<topic>/`。然后复制下面的本地配置示例，并把 `courses[].root` 指向需要展示的课程目录：

```json
{
  "courses": [
    { "root": "../my-study/learning-journal/my-topic", "enabled": true }
  ]
}
```

配置文件相对于配置文件自身所在目录解析。个人配置可以命名为 `dashboard.config.local.json`，该文件已被 Git 忽略；也可以显式指定：

```bash
npm run dashboard -- --config /path/to/dashboard.config.json
```

Windows PowerShell 示例：

```powershell
npm run dashboard -- --config C:\path\to\dashboard.config.json
```

## 不使用 Codex

复制 `templates/course`，将它改成自己的主题目录，把其中的 `YYYY-MM-DD` 换成实际日期，再在 dashboard 配置中登记。第一版支持标准 Markdown 档案：

- `course.md`：概览、学习路线、关键知识、易错点、学习记录；
- `notes.md`：笔记；
- `reviews.md`：复习计划；
- `resources.md`：学习资源；
- `schedule.md`：日程；
- `sessions/`：可选的学习过程记录。

网站读取这些文件，文件保存后通过 SSE 自动刷新。诊断写回仅在用户预览并确认后进行，使用文件哈希检查避免覆盖预览后发生的外部修改。没有证据的完成度、掌握度和日期保持为空，不会被网站虚构。

## 项目边界

这是一个本地优先项目：档案存放在本地，不需要账号或数据库。离线 Mock 模式不会调用外部模型；配置真实模型后，诊断所需的课程片段和作答会发送到模型 API。当前只实现 OpenAI 兼容的文本 Chat Completions 协议，不支持 Anthropic Messages、Gemini 原生协议或多模态接口。移动云 MOMA 的实际接口参数与调用效果仍需在控制台核实和实测。PDF 导入只提取文字层，不做扫描图片 OCR；HTML 导入只提取正文与标题，不抓取外部网页。未确认的导入草稿在服务重启后需重新上传，临时文件在过期后清理。服务重启后，未确认的诊断会话也会失效。`$learning-loop` 可用于创建和维护学习档案。

## 开发与贡献

提交前请运行 `npm test`、`npm run build`，并在需要时运行 `npm run test:e2e`。请不要提交个人学习记录、本机绝对路径、`dashboard.config.local.json`、日志或构建产物。

## License

MIT
