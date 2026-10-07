import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import multer from "multer";

import type { CourseId } from "../shared/course.js";
import type { CourseEventBus } from "./course-events.js";
import type { WorkspaceRepository } from "./workspace-repository.js";
import type { AiService } from "./ai-service.js";
import { AiRequestError } from "./ai-request.js";
import { AssessmentError, AssessmentManager } from "./assessment-manager.js";
import { ArchiveProposalError } from "./archive-proposal.js";
import { AiResponseFormatError } from "./openai-compatible-provider.js";
import { CourseImportError, type CourseImportManager } from "./course-import-manager.js";
import { CourseImportAiError } from "./course-import-ai.js";
import { DraftStoreError } from "./course-import-store.js";
import { DocxImportError } from "./docx-extractor.js";
import { HtmlImportError } from "./html-extractor.js";
import { PdfImportError } from "./pdf-extractor.js";
import { TextImportError } from "./text-extractor.js";
import { readMistakes } from "./session-records.js";
import { PracticeManager } from "./practice-manager.js";
import { readSourceReferences, safeSourcePath } from "./source-references.js";
import { BackupError, BackupZipCodec } from "./backup-zip.js";
import { CourseBackupService } from "./course-backup.js";
import type { CourseRestoreManager } from "./course-restore.js";
import { BACKUP_LIMITS } from "../shared/course-backup.js";
import { backupFileIo } from "./native-file-io.js";
import { CourseManagement, CourseManagementError } from "./course-management.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(currentDirectory, "../../dist");

function decodeUploadFilename(name: string): string {
  // Multipart parsers commonly expose browser UTF-8 filename bytes as Latin-1 text.
  const decoded = Buffer.from(name, "latin1").toString("utf8");
  return decoded.includes("\uFFFD") ? name : decoded;
}

export function createApp(repository: WorkspaceRepository, events: CourseEventBus, aiService?: AiService, imports?: CourseImportManager, mode: "real" | "mock" = "mock", restores?: CourseRestoreManager) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  const management = new CourseManagement(repository, events);
  app.get("/api/courses/:id/edit", async (request, response, next) => {
    try { response.json(await management.snapshot(request.params.id as string)); } catch (error) { next(error); }
  });
  app.patch("/api/courses/:id", async (request, response, next) => {
    try { response.json(await management.mutate(request.params.id as string, request.body, false)); } catch (error) { next(error); }
  });
  app.delete("/api/courses/:id", async (request, response, next) => {
    try { response.json(await management.mutate(request.params.id as string, request.body, true)); } catch (error) { next(error); }
  });
  app.use("/api/restores", async (_request, _response, next) => { try { if (!restores) throw new BackupError("ZIP 恢复不可用：请在 Windows 上检查文件辅助进程与事务目录", 503); await backupFileIo.available(); next(); } catch (error) { next(error); } });

  if (restores) {
    const uploadZip = multer({ storage: multer.memoryStorage(), limits: { fileSize: BACKUP_LIMITS.compressedBytes, files: 1, fields: 0, parts: 1 }, fileFilter: (_request, file, callback) => callback(null, /\.zip$/i.test(file.originalname)) });
    app.post("/api/restores", uploadZip.single("file"), async (request, response, next) => {
      try { if (!request.file) throw new BackupError("请选择 ZIP 备份文件", 400); response.status(201).json(await restores.create(request.file.buffer)); }
      catch (error) { next(error); }
    });
    app.get("/api/restores/:id", async (request, response, next) => { try { response.json(await restores.preview(request.params.id as string)); } catch (error) { next(error); } });
    app.post("/api/restores/:id/confirm", async (request, response, next) => { try { response.json(await restores.confirm(request.params.id as string)); } catch (error) { next(error); } });
    app.delete("/api/restores/:id", async (request, response, next) => { try { await restores.cancel(request.params.id as string); response.status(204).end(); } catch (error) { next(error); } });
  }

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

  app.get("/api/courses/:id/mistakes", async (request, response, next) => {
    const configured = repository.config.courses.find((course) => course.id === request.params.id);
    if (!configured) { response.status(404).json({ error: "未知课程" }); return; }
    try { response.json(await readMistakes(configured.root, configured.id)); } catch (error) { next(error); }
  });

  app.get("/api/courses/:id/source-references", async (request, response, next) => {
    const id = request.params.id as string;
    if (!repository.config.courses.some((course) => course.id === id)) { response.status(404).json({ error: "未知课程" }); return; }
    try { response.json(imports ? await readSourceReferences(repository, imports, id) : []); }
    catch (error) { next(error); }
  });

  if (imports) {
    const backups = new CourseBackupService(repository, imports, new BackupZipCodec());
    app.get("/api/backups/preview", async (request, response, next) => {
      try { const id = request.query.courseId; if (id !== undefined && typeof id !== "string") throw new BackupError("请选择单个有效课程", 400); response.json(await backups.preview(id === undefined ? undefined : [id])); }
      catch (error) { next(error); }
    });
    app.get("/api/backups", async (request, response, next) => {
      try {
        const id = request.query.courseId;
        if (id !== undefined && typeof id !== "string") throw new BackupError("请选择单个有效课程", 400);
        const backup = await backups.create(id === undefined ? undefined : [id]);
        response.setHeader("Content-Disposition", 'attachment; filename="learning-loop-backup.zip"');
        response.type("application/zip").send(Buffer.from(backup.bytes));
      } catch (error) { next(error); }
    });
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 1 }, fileFilter: (_request, file, callback) => callback(null, /\.(pdf|docx|md|txt|markdown|html|htm)$/i.test(file.originalname)) });
    app.post("/api/course-imports", upload.single("file"), async (request, response, next) => {
      try {
        if (!request.file) throw new CourseImportError("请选择文件", 400);
        response.status(201).json(await imports.create(new Uint8Array(request.file.buffer), decodeUploadFilename(request.file.originalname)));
      } catch (error) { next(error); }
    });
    app.get("/api/course-imports", async (_request, response, next) => {
      try { response.json(await imports.list()); } catch (error) { next(error); }
    });
    app.get("/api/course-imports/:id/source", async (request, response, next) => {
      try {
        const source = await imports.draftSourcePath(request.params.id as string);
        response.setHeader("X-Content-Type-Options", "nosniff");
        if (/\.html?$/.test(source)) response.setHeader("Content-Security-Policy", "sandbox");
        const contentType = source.endsWith(".pdf") ? "application/pdf" : source.endsWith(".docx") ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : /\.html?$/.test(source) ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
        response.type(contentType).sendFile(source, { dotfiles: "allow" }, (error) => { if (error) next(error); });
      } catch (error) { next(error); }
    });
    app.get("/api/course-imports/:id", async (request, response, next) => {
      try { response.json(await imports.preview(request.params.id as string)); } catch (error) { next(error); }
    });
    app.patch("/api/course-imports/:id", async (request, response, next) => {
      try { response.json(await imports.update(request.params.id as string, request.body)); } catch (error) { next(error); }
    });
    app.post("/api/course-imports/:id/enrich", async (request, response, next) => {
      response.status(410).json({ error: "旧版直接完善接口已停用，请刷新页面，使用章节发送预览与 AI 候选建议" });
    });
    app.post("/api/course-imports/:id/ai-excerpt", async (request, response, next) => {
      try { response.json(await imports.aiExcerpt(request.params.id as string, request.body)); } catch (error) { next(error); }
    });
    app.post("/api/course-imports/:id/ai-operations", async (request, response, next) => {
      try { response.status(202).json(await imports.startAi(request.params.id as string, request.body)); } catch (error) { next(error); }
    });
    app.get("/api/course-imports/:id/ai-operations/:operationId", async (request, response, next) => {
      try { response.json(await imports.getAi(request.params.id as string, request.params.operationId as string)); } catch (error) { next(error); }
    });
    app.delete("/api/course-imports/:id/ai-operations/:operationId", async (request, response, next) => {
      try { response.json(await imports.cancelAi(request.params.id as string, request.params.operationId as string)); } catch (error) { next(error); }
    });
    app.post("/api/course-imports/:id/ai-candidates/:candidateId/apply", async (request, response, next) => {
      try { response.json(await imports.applyAi(request.params.id as string, request.params.candidateId as string, request.body)); } catch (error) { next(error); }
    });
    app.delete("/api/course-imports/:id/ai-candidates/:candidateId", async (request, response, next) => {
      try { response.json(await imports.rejectAi(request.params.id as string, request.params.candidateId as string, request.body)); } catch (error) { next(error); }
    });
    app.post("/api/course-imports/:id/ai-undo", async (request, response, next) => {
      try { response.json(await imports.undoAi(request.params.id as string, request.body)); } catch (error) { next(error); }
    });
    app.post("/api/course-imports/:id/confirm", async (request, response, next) => {
      try { response.status(201).json(await imports.confirm(request.params.id as string, request.body?.expectedRevision)); } catch (error) { next(error); }
    });
    app.delete("/api/course-imports/:id", async (request, response, next) => {
      try { await imports.cancel(request.params.id as string); response.status(204).end(); } catch (error) { next(error); }
    });
    app.get("/api/courses/:id/source", async (request, response, next) => {
      const filePath = await safeSourcePath(repository, imports, request.params.id as string);
      if (!filePath) { response.status(404).json({ error: "未找到原始文件" }); return; }
      const contentType = filePath.endsWith(".docx") ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : /\.html?$/.test(filePath) ? "text/html; charset=utf-8" : /\.(md|markdown|txt)$/.test(filePath) ? "text/plain; charset=utf-8" : "application/pdf";
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (/\.html?$/.test(filePath)) response.setHeader("Content-Security-Policy", "sandbox");
      response.type(contentType).sendFile(filePath, (error) => { if (error && !response.headersSent) next(error); });
    });
  }

  const aggregate = <T>(pathName: string, loader: () => Promise<T>) => {
    app.get(pathName, async (_request, response, next) => {
      try { response.json(await loader()); } catch (error) { next(error); }
    });
  };

  aggregate("/api/reviews/due", () => repository.getDueReviews());
  aggregate("/api/export", () => repository.exportAllData());
  app.get("/api/courses/:id/export", async (request, response, next) => {
    try {
      if (!repository.config.courses.some((course) => course.id === request.params.id)) { response.status(404).json({ error: "未知课程" }); return; }
      const data = await repository.exportCourse(request.params.id as string);
      response.json(data);
    } catch (error) { next(error); }
  });

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

  if (aiService) {
    const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const assessments = new AssessmentManager(repository, aiService, today, mode);
    const practices = new PracticeManager(repository, aiService, today, mode);
    app.post("/api/practice-sessions", async (request, response, next) => {
      try {
        const { courseId, mistakeId, topic, kind } = request.body ?? {};
        if (typeof courseId !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(courseId)) {
          throw new AssessmentError("练习参数无效", 400);
        }
        if (kind === "targeted-practice" && typeof mistakeId === "string" && mistakeId) {
          response.status(201).json(await practices.create({ courseId, mistakeId, kind }));
        } else if (kind === "review-attempt" && typeof topic === "string" && topic.trim()) {
          response.status(201).json(await practices.create({ courseId, topic, kind }));
        } else throw new AssessmentError("练习参数无效", 400);
      } catch (error) { next(error); }
    });
    app.post("/api/practice-sessions/:id/answer", async (request, response, next) => {
      try {
        const { questionId, choice } = request.body ?? {};
        if (typeof questionId !== "string" || typeof choice !== "string") throw new AssessmentError("答案无效", 400);
        response.json(await practices.answer(request.params.id as string, questionId, choice as "A" | "B" | "C" | "D"));
      } catch (error) { next(error); }
    });
    app.post("/api/practice-sessions/:id/confirm", async (request, response, next) => {
      try {
        const result = await practices.confirm(request.params.id as string);
        if (result.advanced) {
          await repository.refresh(result.courseId, "reviews");
          events.publish("journal-updated", { courseId: result.courseId, artifact: "reviews" });
        }
        await repository.refresh(result.courseId, "sessions");
        events.publish("journal-updated", { courseId: result.courseId, artifact: "sessions" });
        response.json(result);
      } catch (error) { next(error); }
    });
    app.post("/api/ai/assessments", async (request, response, next) => {
      try {
        const courseId = request.body?.courseId;
        if (typeof courseId !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(courseId)) throw new AssessmentError("courseId 无效", 400);
        response.status(201).json(await assessments.create(courseId));
      } catch (error) { next(error); }
    });

    app.post("/api/ai/assessments/:id/answers", async (request, response, next) => {
      try {
        const { questionId, answer } = request.body ?? {};
        if (typeof questionId !== "string" || typeof answer !== "string") throw new AssessmentError("答案无效", 400);
        response.json(await assessments.answer(request.params.id as string, questionId, answer));
      } catch (error) { next(error); }
    });

    app.get("/api/ai/assessments/:id/proposal", async (request, response, next) => {
      try {
        response.json(await assessments.proposal(request.params.id as string));
      } catch (error) { next(error); }
    });

    app.post("/api/ai/assessments/:id/apply", async (request, response, next) => {
      try {
        const result = await assessments.apply(request.params.id as string);
        for (const artifact of ["course", "reviews", "sessions"] as const) {
          await repository.refresh(result.courseId, artifact);
          events.publish("journal-updated", { courseId: result.courseId, artifact });
        }
        response.json({ success: true, weakPointsApplied: result.weakPointsApplied });
      } catch (error) { next(error); }
    });
  }

  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (_request, response) => {
    response.sendFile(path.join(clientDist, "index.html"));
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof AiRequestError) { response.status(error.status).json({ error: error.message }); return; }
    if (error instanceof CourseManagementError) { response.status(error.status).json({ error: error.message }); return; }
    if (error instanceof BackupError) { response.status(error.status).json({ error: error.message }); return; }
    if (error instanceof CourseImportError) { response.status(error.status).json({ error: error.message }); return; }
    if (error instanceof DraftStoreError) { response.status(error.status).json({ error: error.message }); return; }
    if (error instanceof CourseImportAiError) { response.status(error.status).json({ error: error.message }); return; }
    if (error instanceof PdfImportError) { response.status(error.code === "TOO_MANY_PAGES" ? 413 : 422).json({ error: error.message }); return; }
    if (error instanceof DocxImportError) { response.status(error.code === "TOO_MANY_PAGES" ? 413 : 422).json({ error: error.message }); return; }
    if (error instanceof HtmlImportError) { response.status(422).json({ error: error.message }); return; }
    if (error instanceof TextImportError) { response.status(422).json({ error: error.message }); return; }
    if (error instanceof multer.MulterError) { response.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: error.code === "LIMIT_FILE_SIZE" ? (_request.path.startsWith("/api/restores") ? "ZIP 超过 250 MiB 上传上限，请分课程备份" : "文件超过 100 MB 上传上限，请压缩或拆分后导入；Word 上限 50 MB、HTML 上限 20 MB、文本上限 10 MB") : "请只上传一个文件" }); return; }
    if (error instanceof AssessmentError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof AiResponseFormatError) {
      response.status(502).json({ error: error.message });
      return;
    }
    if (error instanceof ArchiveProposalError) {
      response.status(422).json({ error: error.message });
      return;
    }
    if (process.env.NODE_ENV !== "production") console.error("Unhandled API error:", error);
    response.status(500).json({ error: "请求处理失败，请稍后重试" });
  });

  return app;
}
