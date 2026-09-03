import path from "node:path";

import chokidar, { type FSWatcher } from "chokidar";

import type { ArtifactKind } from "../shared/course.js";
import type { CourseEventBus } from "./course-events.js";
import type { WorkspaceRepository } from "./workspace-repository.js";

const FILE_ARTIFACTS: Record<string, ArtifactKind> = {
  "course.md": "course", "notes.md": "notes", "reviews.md": "reviews", "resources.md": "resources", "schedule.md": "schedule",
};

export function startCourseWatcher(repository: WorkspaceRepository, events: CourseEventBus): FSWatcher {
  const files = repository.config.courses.flatMap((course) => [
    ...Object.keys(FILE_ARTIFACTS).map((name) => path.join(course.root, name)),
    path.join(course.root, "sessions", "*.md"),
  ]).concat((repository.config.standaloneNotes ?? []).map((note) => note.sourcePath));
  const watcher = chokidar.watch(files, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
  });

  const refresh = async (changedPath: string) => {
    const absolute = path.resolve(changedPath);
    const standalone = repository.config.standaloneNotes?.find((note) => absolute === note.sourcePath);
    if (standalone) {
      await repository.refreshStandaloneNote(standalone.id);
      events.publish("journal-updated", { courseId: standalone.id, artifact: "notes" });
      return;
    }
    const configured = repository.config.courses.find((course) => absolute === path.join(course.root, path.basename(absolute)) || absolute.startsWith(path.join(course.root, "sessions") + path.sep));
    if (!configured) return;
    const artifact = absolute.startsWith(path.join(configured.root, "sessions") + path.sep) ? "sessions" : FILE_ARTIFACTS[path.basename(absolute)];
    if (!artifact) return;
    await repository.refresh(configured.id, artifact);
    const settings = await repository.getSettings();
    const warning = settings.courses.find((course) => course.id === configured.id)?.artifacts.find((item) => item.artifact === artifact)?.warning;
    if (warning) events.publish("journal-warning", { courseId: configured.id, artifact, warning });
    else events.publish("journal-updated", { courseId: configured.id, artifact });
  };

  watcher.on("add", refresh);
  watcher.on("change", refresh);
  watcher.on("unlink", refresh);
  return watcher;
}
