# Windows 原生绑定文件 I/O Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 ZIP 父目录并发替换风险，不将事后拒绝结果声称为没有访问外部路径。

**Architecture:** Windows 辅助进程逐级打开祖先目录，拒绝 reparse point，核对句柄路径，并保持禁止删除/重命名共享的目录句柄。实际 I/O 也在辅助进程内执行，不能采用“辅助进程持锁、Node 继续普通路径操作”，否则 helper 退出仍留下操作窗口。

**Tech Stack:** Node/TypeScript、Windows Win32 文件句柄、系统 Windows PowerShell/.NET C#、Vitest、Playwright。不自动安装依赖、编译器或系统组件，不修改执行策略或提权。

**Spec:** `../specs/2026-10-01-import-control-and-backup-design.md` 第 7–8 节及 2026-10-02 用户确认的 Windows 原生句柄方向。部署边界需在实现前确认。

## Global Constraints

- 主代理当前工作区逐项执行；不 commit/push、不调用真实 API、不读取/打印 Key。
- ZIP 250 MiB、实际解压 500 MiB、最多 2,000 文件/50 门课程；单 Markdown 10 MiB；来源 PDF 100 / DOCX 50 / HTML 20 / 文本 10 MiB。
- 恢复预览 24 小时，新 ID/新目录，整批发布、幂等、原文与学习证据保留，JSON 导出不变。
- 本轮原生实现面向本地 Windows 10/11 单服务实例。非 Windows 或 helper 不可用时 ZIP 明确不可用，不能回退到不安全的路径操作；健康课程、普通导入及 AI 不因此被整体停用。
- 辅助进程隐藏窗口、权限不提升，固定白名单命令，不提供任意用户脚本执行。块 ≤64 KiB、帧 ≤128 KiB、活动读写/枚举 streams ≤16、清理元数据/删除句柄 ≤4400（双副本清理裁决）、启动/响应预算 15 秒；EOF/超时释放资源。
- 不承诺抵御管理员或进程内存篡改，但必须覆盖普通同权限目录重命名、junction/symlink/hardlink 替换。

## Review Focus

- helper 退出后没有 Node 普通路径 I/O 回退。
- 任一祖先或末级文件换位/链接，外部哨兵不被读取或写入。
- 发布源与目标父目录同时绑定，目标不覆盖。
- 所有权核验和清理对象绑定，不能先关目录句柄再按路径递归删除。
- worker/句柄/输出有界，失败不使应用整体挂起。

### Task 1：原生绑定 I/O 和能力门禁

**Files:** 新增 `dashboard/src/server/native-file-io.ts`、`native-file-io.test.ts`、`native/windows-file-io.ps1`、`native/windows-file-io.cs`。

**Interfaces:** `BoundFileIo.readFile(filename, limit): Promise<{bytes: Uint8Array; identity: string}>`；`listDirectory(directory): Promise<{identity: string; entries: BoundEntry[]}>`；`ensureDirectory(directory, exclusiveLeaf): Promise<void>`；`createWriter(filename, limit): Promise<BoundWriter>`。writer 提供 write/finish/abort，实际操作与祖先句柄同进程。

- [x] 先写测试：持锁期间另一进程不能重命名父目录；junction/末级链接被拒绝、外部哨兵不变；实际大小限制先于输出；helper 中途退出没有回退。
- [x] `npx vitest run src/server/native-file-io.test.ts` 应 RED，不是导入错误。
- [x] 使用 CreateFileW、GetFileInformationByHandle、GetFinalPathNameByHandleW 逐级绑定、拒绝 reparse point/多硬链接，保证实际 I/O 持锁；不依赖最后一次路径 stat。采用有界协议和常驻 worker，避免每个文件启动新进程。
- [x] 同命令 GREEN；能力不足时暂停，不提供降级“安全”实现。

### Task 2：发布和所有权清理

**Files:** 上述原生模块及 `dashboard/src/server/native-file-transactions.test.ts`。

**Interfaces:** `moveDirectory(source, destination, owner)`、`removeDirectory(directory, owner)`、`replaceStateFile(filename, bytes)` 均返回 Promise<void>。owner 为恢复事务 id/token/newId，不以“路径在根内”代替所有权。

- [x] 测试源/目标父级换位不越界、目标存在不覆盖、所有权不符不删除、子目录链接不跟随、helper 退出保留可协调事务。
- [x] `npx vitest run src/server/native-file-transactions.test.ts` RED。
- [x] 实现句柄绑定的发布、原子状态替换及安全清理；核对 Windows 官方 API 的权限和目标定位，禁止假定普通字符串 Move/Delete 已符合契约。
- [x] 同命令 GREEN，保持 publishing → committed 提交点与整批回滚。

### Task 3：ZIP 接入和交付验收

**Files:** ZIP codec、backup、restore/recovery、app/index/config 中相关 I/O、相应测试、README 和验收报告。

- [x] 测试实际备份、解压、manifest/state/marker、暂存、发布和清理全走绑定适配层；helper 不可用只禁用 ZIP，不阻断健康课程/导入；禁止只保护 codec。
- [x] 定向 RED：`npx vitest run src/server/native-file-io.test.ts src/server/native-file-transactions.test.ts src/server/backup-zip.test.ts src/server/course-backup.test.ts src/server/course-restore.test.ts src/server/course-restore-recovery.test.ts src/server/course-backup.integration.test.ts`。
- [x] 接入并使同命令 GREEN；保留解析安全、首资源表定位和 404/410 入口回归，同时统一 ZIP 超限的 250 MiB 文案。
- [x] `npm test`、`npm run build`、`npm run test:e2e`；三设备浏览器及临时目录中的 441 页教材均验收，记录耗时/RSS/hash，不操作用户课程。
- [x] 原生补充计划末尾一次独立只读审查、作者修复；不重复分派已经完成的原 ZIP 审查。全部门禁通过后才修改安全交付状态。

2026-10-03 完成：两项审查发现经作者 RED→GREEN，最终65files/494passed/6skipped、端口2/2、build exit0、三设备45/45（workers=2）、441页教材PASS。默认8worker一次预览等待超时记录并列后续，不改默认配置/超时/断言。实际采用 NtCreateFile 单级父句柄定位、NtQueryDirectoryFile 句柄枚举、NtSetInformationFile 目标父句柄重命名；不是继续绝对路径操作。未commit/push、真实API调用或系统策略更改。

## 官方依据与自审

Microsoft Learn：CreateFileW 的目录句柄/共享删除/OPEN_REPARSE_POINT；GetFileInformationByHandle 的身份；GetFinalPathNameByHandleW 的真实路径。链接分别为 https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew 、https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandle 、https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew 。

自审已覆盖：实际 I/O 与句柄生命周期同进程、失败无回退、发布两端与所有权清理、限额和可用性。不增加账号/数据库/OCR，不新增业务功能。实现前确认 Windows 专用边界与其他环境禁用 ZIP 的行为，执行方式沿用主代理逐项。
