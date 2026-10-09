# POSIX 原生安全文件操作辅助进程

## 改动结果

ZIP 备份与恢复原先只有 Windows 实现：`native-file-io.ts` 在非 Windows 平台直接抛出 `ZIP 安全文件操作仅支持 Windows`，全部 ZIP 文件操作都依赖 PowerShell 加载的 `windows-file-io.cs`。本次新增等价的 POSIX 实现，使 macOS 可以在不降低安全保证的前提下使用 ZIP 备份与恢复；Windows 行为与代码路径未改动。

新增 `dashboard/src/server/native/posix-file-io.mjs`，与 Windows 版使用完全相同的帧协议（stdin/stdout 每行一个 JSON，首帧为 `{ok:true,result:{protocol:1}}`）与相同的命令集（`ping`、`ensure`、`ownedDirectory`、`moveDirectory`、`removeDirectory`、`openRead`、`openWrite`、`openState`、`read`、`write`、`finishWrite`、`finishState`、`abortWrite`、`closeRead`、`closeList`、`openList`、`list`）。`native-file-io.ts` 只负责按平台选择固定的项目内辅助程序：Windows 仍是 `powershell.exe` + `windows-file-io.ps1`，macOS/Linux 是 `process.execPath` + `posix-file-io.mjs`；其他平台仍然失败关闭。

## 与 Windows 版对应的安全模型

| 保证 | Windows 实现 | POSIX 实现 |
| --- | --- | --- |
| 只接受安全绝对路径 | `Normalize` 拒绝空值、NUL、设备名、非法字符与超长路径 | 同样的长度上限与 NUL 检查，`path.resolve` 后要求绝对路径且叶子名非空 |
| 逐级绑定祖先，不跟随链接 | 每级用 `NtCreateFile` 相对父句柄打开，拒绝 reparse point | 每级用 `anchor(parent)/name` 打开，`O_NOFOLLOW`、`O_DIRECTORY`，并用 `lstat` 交叉核对 `dev/inode` |
| 句柄之后只按对象操作 | 后续读写、改名、删除都基于已持有的句柄 | 所有后续操作都通过锚点寻址：macOS 用 `/.vol/<dev>/<inode>`，Linux 用 `/proc/self/fd/<fd>` |
| 拒绝链接叶子与硬链接 | 打开叶子后拒绝 reparse point，要求 `Links == 1` | `O_NOFOLLOW` 打开叶子，要求普通文件且 `nlink === 1` |
| 句柄路径核验 | `GetFinalPathNameByHandleW` 必须等于请求路径 | `lstat` 的 `dev/inode` 必须等于句柄的 `fstat`，否则“文件句柄路径不安全” |
| 写入不覆盖已有文件 | `CREATE_NEW`；失败时 `EEXIST` | 用 `O_CREAT\|O_EXCL` 占用目标名；失败时 `EEXIST` |
| 未提交写入不残留 | 写入前设置 delete-on-close，提交时清除 | 数据写入同目录随机临时文件，提交时原子改名覆盖自己占用的空文件；取消、辅助进程退出与 SIGTERM 都会删除临时文件与占用文件 |
| 目录发布与清理 | 校验所有权标记后按句柄改名/删除，先完整校验再删除 | 同样先校验所有权标记；清理时先完整校验整棵树（链接、非普通文件、超限直接失败），再自底向上按锚点删除 |
| 崩溃后不继续普通路径写 | 辅助进程退出即失败关闭 | 相同：进程退出、管道关闭、超时都失败关闭，客户端不降级 |

差异与边界（不宣称完全等同）：

- POSIX 没有“命名文件的 delete-on-close”。取消、辅助进程正常退出与收到 SIGTERM 时会删除未提交文件；`SIGKILL` 可能留下事务目录内的临时文件或空占用文件，它不会被当成课程文件（发布路径只出现在提交后的改名结果里），启动恢复会整体处理该事务目录。
- 锚点依赖文件系统支持按对象标识寻址。启动时用真实操作探测根目录与临时目录上的锚点（建、写、fsync、读、改名、枚举、删除），任何一步失败都不发送握手帧，并以失败帧说明原因，此时 ZIP 停用而其他功能不受影响。
- 与 Windows 版一致，只接受规范绝对路径：路径中任何一级是符号链接都会被拒绝。应用启动时对项目根做一次 `realpath`，配置里的课程根在 `loadDashboardConfig` 中已经 `realpath`，因此正常使用不受影响；把工作区放在符号链接路径下时需要先规范化。

## 关键文件

- `dashboard/src/server/native/posix-file-io.mjs`：POSIX 辅助进程，帧协议、能力探测与全部文件操作。
- `dashboard/src/server/native-file-io.ts`：按平台解析辅助程序（`resolveHelperLaunch`），能力握手失败时把辅助进程给出的原因传给上层。
- `dashboard/src/server/index.ts`：项目根做一次 `realpath`；ZIP 不可用提示改为平台中立。
- `dashboard/src/server/app.ts`、`dashboard/src/client/components/CourseBackupPanel.tsx`：错误与说明文案改为平台中立。
- `dashboard/src/server/native-test-support.ts`：测试用的平台判定、链接类型与规范临时目录。
- `dashboard/src/server/native-file-io.test.ts`、`native-file-transactions.test.ts`、`native-restore-crash.test.ts`、`backup-native.integration.test.ts`：原 Windows 专用用例改为在 Windows 与 POSIX 上同样运行，新增 POSIX 专属断言。
- `dashboard/src/server/native-posix-window.test.ts`：新增，用打过补丁的辅助进程副本在“已持有祖先”的确切窗口注入路径接管。
- `dashboard/tests/e2e/backup-restore.spec.ts`：浏览器验收使用规范临时目录。

## 验证

环境：macOS（Apple Silicon，Node 26.3.1），本机单服务实例。以下结果均为本次实际执行，未调用任何付费模型接口。

- `npm run build`：TypeScript 检查与 Vite 构建通过。
- `npx vitest run`：543 项通过、5 项跳过、5 项失败。对照同一提交的未改动副本（同一机器、同一命令，基线为 513 项通过、41 项失败）：新增回归 0 项，基线中 36 项失败在本分支通过；剩余 5 项在基线上同样失败且与本次改动无关（2 项依赖浏览器 LocalStorage 的客户端用例、1 项断言 Windows 盘符路径的配置用例、2 项断言未规范化临时目录的配置用例）。
- 新增/改造的 ZIP 相关用例在 macOS 上全部通过，包括：符号链接祖先与叶子被拒绝且不触碰外部哨兵文件；硬链接叶子与硬链接状态文件被拒绝；超限读写返回 413；不允许覆盖已有文件；`ensure` 独占叶子返回 `EEXIST`；16 个活动句柄上限；辅助进程被真实 `kill` 后失败关闭；真实崩溃后由新进程回滚并重试；2200 文件的所有权目录清理；ZIP 全流程不退化到普通路径读写。
- 新增 `native-posix-window.test.ts`：在辅助进程已持有祖先目录后，测试副本把该目录改名并在原路径放上指向外部目录的符号链接，随后 `ensureDirectory`、`createWriter`、`moveDirectory` 三类操作都仍然落在原来的目录对象里，外部目录与哨兵文件未被修改；另有一例注入原生提交失败，验证租约被回收、不残留文件、辅助进程不重启即可继续写入。
- 真实浏览器流程（Playwright，Chromium，desktop/tablet/mobile 三种视口）：备份 ZIP → 下载 → 上传校验 → 取消不发布 → 恢复为新课程 → 原课件可通过来源打开，三种视口全部通过。同一命令下基线失败 15 项、本分支失败 3 项，新增回归 0 项；剩余 3 项（首页、导入恢复、真实受管 PDF）在基线上同样失败。
- 真实 HTTP 流程：对本机服务执行 `GET /api/backups/preview`、`GET /api/backups`、`POST /api/restores`、`POST /api/restores/:id/confirm`，ZIP 内容与哈希清单正确，恢复后新课程出现在课程列表且文件已发布到 `learning-journal/`，事务目录按设计只留下状态文件。

## 未验证

- 未在 Windows 上运行本次改动。Windows 分支（PowerShell 与 `windows-file-io.cs`）没有修改，但辅助程序选择与握手错误信息的改动需要在 Windows 上复跑既有用例确认。
- 未在 Linux 真机验收：`/proc/self/fd` 路径已实现并有同一套能力探测，但没有实际运行记录，README 中标注为已实现、未验收。
- 未验证 `SIGKILL`、拔盘、磁盘写满等极端情况下的残留与恢复行为；未覆盖非 APFS/HFS 卷或网络卷上锚点探测失败以外的情形。
- 未验证多进程同时操作同一工作区、超长路径（>1000 字符）以及超大目录（>4400 条目）的边界组合。
- 未重新执行 Windows 的 515 项历史验收，也不据此宣称所有 POSIX 环境兼容。
