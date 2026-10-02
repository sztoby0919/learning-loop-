// Run with: node --import tsx/esm scripts/benchmark-pdf-import.mjs [path/to/textbook.pdf]
// Everything stays local. No model calls, project courses, or config changes.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { CourseEventBus } from "../src/server/course-events.ts";
import { CourseImportManager } from "../src/server/course-import-manager.ts";
import { loadDashboardConfig } from "../src/server/dashboard-config.ts";
import { WorkspaceRepository } from "../src/server/workspace-repository.ts";
import { textPdf } from "../src/test/pdf-fixtures.ts";
import { readSourceReferences } from "../src/server/source-references.ts";
import { CourseBackupService } from "../src/server/course-backup.ts";
import { BackupZipCodec } from "../src/server/backup-zip.ts";
import { CourseRestoreManager } from "../src/server/course-restore.ts";
import { recoverRestoreTransactions } from "../src/server/course-restore-recovery.ts";

const filename = process.argv[2];
const bytes = filename ? new Uint8Array(await readFile(filename)) : textPdf(Array.from({ length: 1000 }, (_, index) => `Chapter ${index + 1} Limits. Formula: f(x)=x^2. Table: x 1 2; f(x) 1 4.`));
const root = await mkdtemp(path.join(os.tmpdir(), "learning-loop-pdf-benchmark-"));
const configPath = path.join(root, "config.json");
const today = () => "2026-10-01";
const repository = new WorkspaceRepository({ configPath, courses: [] }, today);
const manager = new CourseImportManager({ root, repository, events: new CourseEventBus(), watchCourse: () => {}, today });
let draftRecoveryManager;
const initialRss = process.memoryUsage().rss;
let observedPeakRss = initialRss;
const timer = setInterval(() => { observedPeakRss = Math.max(observedPeakRss, process.memoryUsage().rss); }, 20);
const started = performance.now();
try {
  const preview = await manager.create(bytes, filename ? path.basename(filename) : "synthetic-1000-pages.pdf");
  const previewMs = performance.now() - started;
  const edited = await manager.update(preview.id, { expectedRevision: preview.revision, title: "PDF import acceptance", goal: "Verify local import and recovery", weeklyHours: 3, stages: preview.draft.stages });
  manager.stopScheduledCleanup();
  draftRecoveryManager = new CourseImportManager({ root, repository, events: new CourseEventBus(), watchCourse: () => {}, today });
  const restoredDraft = await draftRecoveryManager.preview(preview.id);
  if (JSON.stringify(restoredDraft.draft) !== JSON.stringify(edited.draft) || restoredDraft.revision !== edited.revision) throw new Error("Saved draft recovery mismatch");
  const confirmed = await draftRecoveryManager.confirm(preview.id, restoredDraft.revision);
  const totalMs = performance.now() - started;
  const courseRoot = path.join(root, "learning-journal", confirmed.courseId);
  for (const [name, expected] of Object.entries(edited.files)) {
    if (await readFile(path.join(courseRoot, name), "utf8") !== expected) throw new Error(`Preview mismatch: ${name}`);
  }
  await writeFile(configPath, JSON.stringify({ courses: [] }));
  const recovered = new WorkspaceRepository(await loadDashboardConfig(configPath, path.join(root, "learning-journal")), today);
  const courses = await recovered.getCourses();
  if (courses.courses.length !== 1 || courses.courses[0].title !== "PDF import acceptance") throw new Error("Recovery failed");
  const source = await readFile(path.join(courseRoot, "source.pdf"));
  const hash = (data) => createHash("sha256").update(data).digest("hex");
  if (hash(source) !== hash(bytes)) throw new Error("Original PDF changed");
  const references = await readSourceReferences(repository, draftRecoveryManager, confirmed.courseId);
  if (!references.some((item) => item.kind === "pdf-page" && item.verifiedExcerpt && item.sourceUrl.includes("#page="))) throw new Error("Source page verification failed");
  const backupStarted = performance.now(); const codec = new BackupZipCodec();
  const backup = await new CourseBackupService(repository, draftRecoveryManager, codec).create();
  const backupMs = performance.now() - backupStarted;
  const restores = new CourseRestoreManager({ root, repository, events: new CourseEventBus(), watchCourse: () => {}, codec });
  const restoreStarted = performance.now(); const restorePreview = await restores.create(backup.bytes);
  const restoreResult = await restores.confirm(restorePreview.id);
  if (JSON.stringify(await restores.confirm(restorePreview.id)) !== JSON.stringify(restoreResult)) throw new Error("Restore receipt not idempotent");
  const newRoot = path.join(root, "learning-journal", restoreResult.courseIds[0]);
  if (hash(await readFile(path.join(newRoot, "source.pdf"))) !== hash(bytes)) throw new Error("Restored PDF changed");
  const restoredReferences = await readSourceReferences(repository, draftRecoveryManager, restoreResult.courseIds[0]);
  if (!restoredReferences.some((item) => item.sourceUrl.includes(`/api/courses/${restoreResult.courseIds[0]}/source#page=`))) throw new Error("Restored source URL did not remap");
  await recoverRestoreTransactions(root);
  if ((await loadDashboardConfig(configPath, path.join(root, "learning-journal"))).courses.length !== 2) throw new Error("Restored course discovery failed");
  for (const [name, expected] of Object.entries(edited.files)) if (await readFile(path.join(courseRoot, name), "utf8") !== expected) throw new Error("Original course modified during restore");
  const backupRestore = { zipBytes: backup.bytes.length, backupMs: Math.round(backupMs), restoreMs: Math.round(performance.now() - restoreStarted), sourceSha256: hash(bytes), restoredAsNewCourse: true, sourceHashUnchanged: true, idempotent: true, discoveredAfterRestart: true, sourceReferences: restoredReferences.length };
  observedPeakRss = Math.max(observedPeakRss, process.memoryUsage().rss);
  console.log(JSON.stringify({ result: "PASS", sample: filename ? "user-provided PDF" : "synthetic PDF (not a real textbook)", bytes: bytes.length, pages: preview.draft.pageCount, stages: preview.draft.stages.length, previewMs: Math.round(previewMs), importAndConfirmMs: Math.round(totalMs), initialRssMiB: Math.round(initialRss / 1048576), observedPeakRssMiB: Math.round(observedPeakRss / 1048576), warnings: preview.draft.warnings, quality: preview.draft.quality, previewMatchesFiles: true, savedDraftRecovered: true, recoveredFromDisk: true, sourceUnchanged: true, sourcePagesVerified: references.length, backupRestore }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: "FAIL", elapsedMs: Math.round(performance.now() - started), message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  clearInterval(timer);
  manager.stopScheduledCleanup();
  draftRecoveryManager?.stopScheduledCleanup();
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("learning-loop-pdf-benchmark-")) throw new Error("Unexpected temporary directory");
  await rm(resolved, { recursive: true, force: true });
}
