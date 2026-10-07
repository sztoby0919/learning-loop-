# 真实 MoMA 浏览器全流程验收：未全部通过

> 这是修复前的历史记录。修复后的最新结果见 [MoMA 可靠性修复与最终验收](2026-10-03-moma-reliability-repair.md)：真实流程 7/7 通过。

日期：2026-10-03（Asia/Shanghai）。模型：`deepseek-v4-flash-0731`。端点：用户配置的移动云 MoMA。只发送自制的两页机器学习基础课件，没有发送用户教材或个人学习记录。

## 结论

普通建课和数据备份恢复的浏览器流程通过；真实 AI 完善返回 HTTP 500，真实诊断出题超过当前服务的 30 秒预算。因此不能宣称真实 MoMA 全流程已通过。此前适配器直接调用成功，不代表本次浏览器业务流程成功。

| 验收环节 | 本次结果 | 证据 |
| --- | --- | --- |
| 上传 PDF、修改名称/目标/每周时间 | 通过 | 草稿保存状态为已保存，刷新后标题保持；未点击 AI 前模型调用数为零 |
| AI 完善与加载动画 | 部分通过 | 实际看到旋转加载状态；上游在 2,301 ms 返回 HTTP 500，没有候选建议 |
| 失败提示与草稿保留 | 通过 | 页面显示“模型服务返回 HTTP 500，请检查服务状态后重试”；编辑内容和建课按钮仍在 |
| 基础建课、课程列表、资源页打开 | 通过 | 新建课程无需重启可见；五个 Markdown 与确认前预览完全一致；sessions 初始为空；资源链接可打开 |
| 原 PDF 完整性 | 通过 | 下载来源内容的 SHA-256 与上传字节一致 |
| 真实诊断出题 | 失败 | 30,017 ms 内未取得响应，服务报告“请求超时”，页面只显示通用“请求处理失败，请稍后重试” |
| 诊断答错锁定、报告、确认归档 | 未完成 | 没有取得真实题目，不能开展后续断言 |
| 真实错题再练与复习计划推进 | 未完成 | 前置诊断未完成，未使用 Mock 或手工伪造证据来代替 |
| JSON 导出 | 通过 | 浏览器实际下载、解析 JSON；courseCount 为 1 且课程 ID 正确 |
| ZIP 下载、上传校验、预览、刷新、确认恢复 | 通过 | 确认前仍一门课程，确认后两门；3,875 字节测试 ZIP 成功恢复为新课程 |
| 恢复后的数据与来源 | 通过 | 使用现有课程 ID 重映射规则核对五个 Markdown；恢复后的 PDF 哈希一致；原课程未覆盖 |
| 从磁盘重新发现课程 | 通过 | 新调用配置加载器从 managedRoot 发现两门课程；不是进程级重启验收 |

## 调用边界与复现

本次共发出 **2 次真实模型请求**：AI 草稿 1 次、诊断出题 1 次。不自动重试，低于事前约定的 12 次上限。遇到失败后继续完成不依赖 AI 的存储流程，没有重试失败模型调用。

使用随机空闲端口的独立 Express 服务、真实服务类、真实 MoMA Provider 和桌面 Chromium。测试配置仅在临时实例中设 `maxRetries: 0`，不修改 `.env` 或生产配置。所有课程、上传、备份和恢复发生在经校验的独立临时目录，结束后删除；实际用户课程未修改。失败截图及脱敏 JSON 留在本地 `.superpowers/`。

手动测试入口：`.superpowers/live-moma-browser.mjs`。本次执行：

```powershell
node --import ./dashboard/node_modules/tsx/dist/loader.mjs .superpowers/live-moma-browser.mjs
node --import ./dashboard/node_modules/tsx/dist/loader.mjs .superpowers/live-moma-browser.mjs --base-draft-only
node --import ./dashboard/node_modules/tsx/dist/loader.mjs .superpowers/live-moma-browser.mjs --storage-only
```

前两次分别在 AI 完善、诊断出题失败退出；第三次不调用模型，三个存储流程检查通过。没有将这些手动真实接口测试加入常规自动化测试，以免常规测试耗费 API 额度。

本地证据：

- `.superpowers/live-moma-browser-result.json` 与 `live-moma-browser-failure.png`
- `.superpowers/live-moma-browser-base-result.json` 与 `live-moma-browser-base-failure.png`
- `.superpowers/live-moma-browser-storage-result.json` 与 `live-moma-browser-storage-success.png`

## 已确认的问题与建议

1. **AI 完善确实收到上游 HTTP 500**：HTTP 状态来自真实 fetch 返回，不是本地 JSON 解析失败。尚未取得提供商内部原因，不能判断是临时服务异常、请求内容触发的服务问题或其他原因；没有证据支持更换 Key 或改模型名。
2. **诊断超时与提示脱节**：生产 index 给 AiService 30 秒预算，Provider fetch 自身是 90 秒。AiService 的 Promise.race 超时不会取消其内部请求；当前测试额外约束 fetch 为 30 秒，避免继续占用上游。建议统一期限并传播取消信号，而不是仅增加等待时间。
3. **诊断页面隐藏了具体原因**：终端显示“请求超时”，app.ts 通用异常处理将其转换为“请求处理失败，请稍后重试”。应单独处理超时并返回可操作的提示，同时保护 API Key 与内部日志。

本次仅执行测试及记录，没有修改业务实现、提交或 push。下一步应在授权修复超时控制和错误映射后，再用少量真实调用复验失败环节，取得诊断数据后继续错题/复习验收。

边界：小课件、桌面 Chromium、单次顺序流程；未覆盖长教材性能、多个设备、连续调用稳定性、恢复后进程重启，也未重新运行整个单元测试/Mock 浏览器套件。JSON 导出不包含原课件，不称为完整备份；ZIP 才在本次验证了原课件恢复。
