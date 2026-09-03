import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

import type { CourseId } from "../shared/course.js";
import type { CourseEventBus } from "./course-events.js";
import type { WorkspaceRepository } from "./workspace-repository.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(currentDirectory, "../../dist");

export function createApp(repository: WorkspaceRepository, events: CourseEventBus) {
  const app = express();
  app.disable("x-powered-by");

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
