# Learning Loop

Learning Loop 把学习过程整理成可持续的反馈闭环：诊断目标、制定路线、主动回忆、实践、修复薄弱点，并把结果保存在 Markdown 学习档案中。项目还提供一个本地只读 dashboard，把任意主题的学习档案可视化。

## 快速开始

需要 Node.js 20 或更高版本。

```bash
git clone <your-repository-url>
cd learning-loop-project
npm install
npm run dashboard
```

打开 <http://127.0.0.1:3000>，默认会显示 `examples/demo-course`。

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

网站只读这些文件，文件保存后通过 SSE 自动刷新。没有证据的完成度、掌握度和日期保持为空，不会被网站虚构。

## 项目边界

这是一个本地优先项目：学习内容不会上传到服务器，不需要账号或数据库。第一版不自动解析 PDF/网页，也不调用 AI API；如果需要生成学习档案，可以使用 `$learning-loop`，再由 dashboard 展示结果。

## 开发与贡献

提交前请运行 `npm test`、`npm run build`，并在需要时运行 `npm run test:e2e`。请不要提交个人学习记录、本机绝对路径、`dashboard.config.local.json`、日志或构建产物。

## License

MIT
