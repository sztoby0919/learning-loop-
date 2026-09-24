import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import express from "express";

import type { CourseId } from "../shared/course.js";
import type { CourseEventBus } from "./course-events.js";
import type { WorkspaceRepository } from "./workspace-repository.js";
import type { AiService } from "./ai-service.js";
import type { DiagnosisResult } from "./ai-types.js";
import { batchAtomicWrite, computeFileHash } from "./file-utils.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(currentDirectory, "../../dist");

export function createApp(repository: WorkspaceRepository, events: CourseEventBus, aiService?: AiService) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/courses", async (_request, response, next) => {
    try {
      response.json(await repository.getCourses());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/courses/:id", async (request, response, next) => {
    const id = request.params.id as CourseId;
    if (!repository.config.courses.some((course) => course.id === id)) {
      response.status(404).json({ error: "未知课程" });
      return;
    }

    try {
      const course = await repository.getCourse(id);
      if (!course) response.status(404).json({ error: "未知课程" });
      else response.json(course);
    } catch (error) {
      next(error);
    }
  });

  const aggregate = <T>(pathName: string, loader: () => Promise<T>) => {
    app.get(pathName, async (_request, response, next) => {
      try { response.json(await loader()); } catch (error) { next(error); }
    });
  };

  aggregate("/api/tasks", () => repository.getTasks());
  aggregate("/api/notes", () => repository.getNotes());
  aggregate("/api/reviews", () => repository.getReviews());
  aggregate("/api/resources", () => repository.getResources());
  aggregate("/api/stats", () => repository.getStats());
  aggregate("/api/settings", () => repository.getSettings());

  app.get("/api/calendar", async (request, response, next) => {
    try {
      const month = String(request.query.month ?? "");
      if (!/^\d{4}-\d{2}$/.test(month)) {
        response.status(400).json({ error: "month 必须为 YYYY-MM" });
        return;
      }
      response.json(await repository.getCalendar(month));
    } catch (error) { next(error); }
  });

  app.get("/api/events", (request, response) => {
    const disconnect = events.connect(response);
    request.on("close", disconnect);
  });

  // AI 诊断路由
  if (aiService) {
    app.post("/api/ai/assessments", async (request, response, next) => {
      try {
        const { courseId, topic, count, difficulty, context } = request.body;
        const questions = await aiService.generateAssessmentQuestions({
          courseId, topic, count, difficulty, context,
        });
        response.json({ questions });
      } catch (error) { next(error); }
    });

    app.post("/api/ai/assessments/:id/answers", async (request, response, next) => {
      try {
        const { question, answer, context } = request.body;
        const feedback = await aiService.submitAnswer({ question, answer, context });
        response.json(feedback);
      } catch (error) { next(error); }
    });

    app.post("/api/ai/assessments/:id/diagnosis", async (request, response, next) => {
      try {
        const { answers, learningRecords } = request.body;
        const diagnosis = await aiService.generateDiagnosis({
          courseId: request.params.id,
          answers,
          learningRecords,
        });
        response.json(diagnosis);
      } catch (error) { next(error); }
    });

    app.post("/api/ai/assessments/:id/apply", async (request, response, next) => {
      try {
        const { courseId, diagnosis, expectedHashes } = request.body as {
          courseId: string;
          diagnosis: DiagnosisResult;
          expectedHashes?: Record<string, string>;
        };

        // 验证课程存在
        const course = repository.config.courses.find((c) => c.id === courseId);
        if (!course) {
          response.status(404).json({ error: "未知课程" });
          return;
        }

        // 准备写入操作
        const operations: Array<{ filePath: string; content: string; expectedHash?: string }> = [];

        // course.md 修改
        if (diagnosis.proposedChanges.courseMarkdown) {
          const filePath = path.join(course.root, "course.md");
          operations.push({
            filePath,
            content: diagnosis.proposedChanges.courseMarkdown,
            expectedHash: expectedHashes?.["course.md"],
          });
        }

        // reviews.md 修改
        if (diagnosis.proposedChanges.reviewsMarkdown) {
          const filePath = path.join(course.root, "reviews.md");
          operations.push({
            filePath,
            content: diagnosis.proposedChanges.reviewsMarkdown,
            expectedHash: expectedHashes?.["reviews.md"],
          });
        }

        // mistakes.md 修改（追加到现有内容）
        if (diagnosis.proposedChanges.mistakesMarkdown) {
          const filePath = path.join(course.root, "mistakes.md");
          const existing = await readFile(filePath, "utf8").catch(() => "");
          operations.push({
            filePath,
            content: existing + "\n" + diagnosis.proposedChanges.mistakesMarkdown,
            expectedHash: expectedHashes?.["mistakes.md"],
          });
        }

        // sessions/ 新增记录
        const sessionDir = path.join(course.root, "sessions");
        const sessionFile = path.join(sessionDir, `${new Date().toISOString().slice(0, 10)}.md`);
        operations.push({
          filePath: sessionFile,
          content: diagnosis.proposedChanges.sessionMarkdown,
        });

        // 批量原子写入
        const result = await batchAtomicWrite(operations);

        if (!result.success) {
          if (result.conflict) {
            response.status(409).json({
              error: result.error,
              conflict: true,
            });
          } else {
            response.status(500).json({ error: result.error });
          }
          return;
        }

        // 手动刷新缓存并触发事件
        await repository.refresh(courseId, "course");
        await repository.refresh(courseId, "reviews");
        await repository.refresh(courseId, "sessions");
        events.publish("journal-updated", { courseId, artifact: "course" });

        response.json({
          success: true,
          hash: result.hash,
          weakPointsApplied: diagnosis.weakPoints.length,
        });
      } catch (error) { next(error); }
    });
  }

  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (_request, response) => {
    response.sendFile(path.join(clientDist, "index.html"));
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : "未知错误";
    response.status(500).json({ error: message });
  });

  return app;
}
