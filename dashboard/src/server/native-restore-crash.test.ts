// @vitest-environment node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { canonicalTempRoot, nativeIoSupported } from "./native-test-support.js";
import { backupFileIo } from "./native-file-io.js";
import { CourseImportManager } from "./course-import-manager.js";
import { CourseRestoreManager } from "./course-restore.js";
import { CourseBackupService } from "./course-backup.js";
import { BackupZipCodec } from "./backup-zip.js";
import { WorkspaceRepository } from "./workspace-repository.js";
import { CourseEventBus } from "./course-events.js";
import { readRestoreState, restoreOwner, stagedDirectory, publishedDirectory, writeRestoreState } from "./course-restore-recovery.js";

it.runIf(nativeIoSupported)("a real helper crash after partial publication preserves the journal for a fresh process to roll back and retry", async () => {
  const root = await canonicalTempRoot("learning-loop-native-crash-");
  const config = path.join(root, "config.json"); await writeFile(config, '{"courses":[]}');
  const repository = new WorkspaceRepository({ configPath: config, courses: [] }, () => "2026-10-02"); const events = new CourseEventBus();
  const imports = new CourseImportManager({ root, repository, events, today: () => "2026-10-02", watchCourse: () => {} });
  try {
    for (const title of ["课程一", "课程二"]) { const draft = await imports.create(Buffer.from(`# ${title}\n\n## 章节\n原文`), "book.md"); await imports.confirm(draft.id, draft.revision); }
    const original = await readFile(path.join(repository.config.courses[0].root, "source.md"));
    const codec = new BackupZipCodec(); const manager = new CourseRestoreManager({ root, repository, events, codec, watchCourse: () => {} });
    const preview = await manager.create((await new CourseBackupService(repository, imports, codec).create()).bytes);
    const state = await readRestoreState(root, preview.id); await writeRestoreState(root, { ...state, phase: "publishing" });
    await mkdir(path.join(root, "learning-journal"), { recursive: true });
    await backupFileIo.moveDirectory(stagedDirectory(root, state, state.courses[0].newId), publishedDirectory(root, state.courses[0].newId), restoreOwner(state, state.courses[0].newId));
    process.kill(backupFileIo.workerPid!);
    await expect(backupFileIo.available()).rejects.toMatchObject({ status: 503 });
    const script = `
      import { recoverRestoreTransactions, readRestoreState } from ${JSON.stringify(new URL("./course-restore-recovery.ts", import.meta.url).href)};
      import { backupFileIo } from ${JSON.stringify(new URL("./native-file-io.ts", import.meta.url).href)};
      import { loadDashboardConfig } from ${JSON.stringify(new URL("./dashboard-config.ts", import.meta.url).href)};
      import { WorkspaceRepository } from ${JSON.stringify(new URL("./workspace-repository.ts", import.meta.url).href)};
      import { CourseRestoreManager } from ${JSON.stringify(new URL("./course-restore.ts", import.meta.url).href)};
      import { CourseEventBus } from ${JSON.stringify(new URL("./course-events.ts", import.meta.url).href)};
      import { BackupZipCodec } from ${JSON.stringify(new URL("./backup-zip.ts", import.meta.url).href)};
      const root = ${JSON.stringify(root)};
      await recoverRestoreTransactions(root);
      const state = await readRestoreState(root, ${JSON.stringify(state.id)});
      const config = await loadDashboardConfig(${JSON.stringify(config)}, ${JSON.stringify(path.join(root, "learning-journal"))});
      const before = config.courses.length;
      const repository = new WorkspaceRepository(config, () => "2026-10-02");
      const manager = new CourseRestoreManager({ root, repository, events: new CourseEventBus(), codec: new BackupZipCodec(), watchCourse: () => {} });
      await manager.confirm(state.id);
      await backupFileIo.close();
      console.log(JSON.stringify({ phase: state.phase, before, after: repository.config.courses.length }));
    `;
    // The fresh process keeps the platform's own helper launch conditions; Windows
    // needs its SystemRoot/PATH, POSIX needs PATH and TMPDIR for the anchor probe.
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const childEnvironment = process.platform === "win32"
      ? { SystemRoot: systemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), PATH: path.join(systemRoot, "System32") }
      : { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: os.tmpdir() };
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", script], { cwd: process.cwd(), timeout: 20000, windowsHide: process.platform === "win32", env: childEnvironment });
    expect(JSON.parse(result.stdout.trim())).toEqual({ phase: "open", before: 2, after: 4 });
    expect((await readFile(path.join(repository.config.courses[0].root, "source.md"))).equals(original)).toBe(true);
  } finally { imports.stopScheduledCleanup(); await backupFileIo.close(); await rm(root, { recursive: true, force: true }); }
}, 30000);
