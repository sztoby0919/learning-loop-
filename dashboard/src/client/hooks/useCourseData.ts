import { useCallback, useEffect, useState } from "react";

import type { CourseDetail, CourseId, CourseSummary, CoursesResponse } from "../../shared/course.js";
import { fetchCourse, fetchCourses } from "../api.js";

type LoadState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  connection: "connecting" | "live" | "warning";
};

function useJournalEvents(onCourseChange: (id: CourseId) => void) {
  const [connection, setConnection] = useState<LoadState<never>["connection"]>("connecting");

  useEffect(() => {
    const events = new EventSource("/api/events");
    const handle = (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data) as { courseId: CourseId };
      onCourseChange(payload.courseId);
    };
    events.addEventListener("journal-updated", handle as EventListener);
    events.addEventListener("journal-warning", handle as EventListener);
    events.onopen = () => setConnection("live");
    events.onerror = () => setConnection("warning");
    return () => events.close();
  }, [onCourseChange]);

  return connection;
}

export function useApiData<T>(loader: (signal?: AbortSignal) => Promise<T>, dependency: string = ""): LoadState<T> {
  const [state, setState] = useState<Omit<LoadState<T>, "connection">>({ data: null, error: null, loading: true });
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await loader(signal);
      setState({ data, error: null, loading: false });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : String(error), loading: false }));
    }
  // loader is supplied as a stable module function or intentionally keyed by dependency.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dependency]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  const refresh = useCallback(() => void load(), [load]);
  const connection = useJournalEvents(refresh);
  return { ...state, connection };
}

export function useDashboardData(): LoadState<CoursesResponse> {
  const [state, setState] = useState<Omit<LoadState<CoursesResponse>, "connection">>({ data: null, error: null, loading: true });
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await fetchCourses(signal);
      setState({ data, error: null, loading: false });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : String(error), loading: false }));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const refresh = useCallback(() => void load(), [load]);
  const connection = useJournalEvents(refresh);
  return { ...state, connection };
}

export function useCourseDetail(id: CourseId): LoadState<CourseDetail | CourseSummary> {
  const [state, setState] = useState<Omit<LoadState<CourseDetail | CourseSummary>, "connection">>({ data: null, error: null, loading: true });
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await fetchCourse(id, signal);
      setState({ data, error: null, loading: false });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : String(error), loading: false }));
    }
  }, [id]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const refreshMatching = useCallback((changedId: CourseId) => {
    if (changedId === id) void load();
  }, [id, load]);
  const connection = useJournalEvents(refreshMatching);
  return { ...state, connection };
}
