import type { Response } from "express";

import type { ArtifactKind, CourseId } from "../shared/course.js";

export type CourseEventName = "journal-updated" | "journal-warning";

export class CourseEventBus {
  private readonly clients = new Set<Response>();

  connect(response: Response): () => void {
    response.status(200);
    response.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    response.write("retry: 2000\n\n");
    this.clients.add(response);

    return () => this.clients.delete(response);
  }

  publish(event: CourseEventName, data: { courseId: CourseId; artifact: ArtifactKind; warning?: string }): void {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) client.write(message);
  }
}
