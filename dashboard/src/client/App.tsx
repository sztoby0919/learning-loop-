import { WarningCircle } from "@phosphor-icons/react";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";

import type { CalendarEvent, CourseDetail, CourseId, CourseSummary, CoursesResponse, LearningStats, NoteDocument, ResourceItem, ReviewItem, ScheduledReview, TaskReference } from "../shared/course.js";
import { fetchCalendar, fetchDueReviews, fetchNotes, fetchResources, fetchReviews, fetchSettings, fetchStats, fetchTasks } from "./api.js";
import { AppShell } from "./components/AppShell.js";
import { useApiData, useCourseDetail, useDashboardData } from "./hooks/useCourseData.js";
import { usePreferences } from "./preferences.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import type { SettingsData } from "./pages/SettingsPage.js";

const CourseDetailPage = lazy(async () => {
  const module = await import("./pages/CourseDetailPage.js");
  return { default: module.CourseDetailPage };
});

const CourseCoachPage = lazy(async () => {
  const module = await import("./pages/CourseCoachPage.js");
  return { default: module.CourseCoachPage };
});
const CourseImportPage = lazy(async () => ({ default: (await import("./pages/CourseImportPage.js")).CourseImportPage }));
const MistakesPage = lazy(async () => ({ default: (await import("./pages/MistakesPage.js")).MistakesPage }));

const CalendarPage = lazy(async () => ({ default: (await import("./pages/CalendarPage.js")).CalendarPage }));
const CoursesPage = lazy(async () => ({ default: (await import("./pages/CoursesPage.js")).CoursesPage }));
const NotesPage = lazy(async () => ({ default: (await import("./pages/NotesPage.js")).NotesPage }));
const ResourcesPage = lazy(async () => ({ default: (await import("./pages/ResourcesPage.js")).ResourcesPage }));
const ReviewPage = lazy(async () => ({ default: (await import("./pages/ReviewPage.js")).ReviewPage }));
const SettingsPage = lazy(async () => ({ default: (await import("./pages/SettingsPage.js")).SettingsPage }));
const StatsPage = lazy(async () => ({ default: (await import("./pages/StatsPage.js")).StatsPage }));
const TasksPage = lazy(async () => ({ default: (await import("./pages/TasksPage.js")).TasksPage }));

function LoadingState() {
  return (
    <div className="skeleton-grid" aria-label="正在加载课程">
      {[0, 1, 2].map((item) => <div className="course-card-skeleton" key={item} />)}
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="page-error" role="alert">
      <WarningCircle size={28} />
      <div><strong>无法读取学习记录</strong><p>{message}</p></div>
    </div>
  );
}

function DashboardRoute() {
  const state = useDashboardData();
  const statsState = useApiData(fetchStats);
  const [preferences] = usePreferences();
  const data = state.data ? filterDashboard(state.data, preferences.hiddenCourseIds, preferences.courseOrder) : null;
  return (
    <AppShell connection={state.connection}>
      {state.loading && <LoadingState />}
      {state.error && <ErrorState message={state.error} />}
      {data && <DashboardPage data={data} stats={statsState.data} />}
    </AppShell>
  );
}

function CourseRoute() {
  const id = useParams().id as CourseId;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return <Navigate to="/" replace />;
  return <KnownCourseRoute id={id} />;
}

function CourseCoachRoute() {
  const id = useParams().id as CourseId;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return <Navigate to="/" replace />;
  return <KnownCourseCoachRoute id={id} />;
}

function CourseMistakesRoute() {
  const id = useParams().id as CourseId;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return <Navigate to="/" replace />;
  return <MistakesPage courseId={id} />;
}

function KnownCourseRoute({ id }: { id: CourseId }) {
  const state = useCourseDetail(id);
  const detail = state.data && "stages" in state.data ? state.data as CourseDetail : null;

  return (
    <AppShell connection={state.connection}>
      {state.loading && <LoadingState />}
      {state.error && <ErrorState message={state.error} />}
      {state.data && !detail && <ErrorState message={state.data.warning ?? "course.md 尚未准备好"} />}
      {detail && (
        <Suspense fallback={<LoadingState />}>
          <CourseDetailPage course={detail} />
        </Suspense>
      )}
    </AppShell>
  );
}

function KnownCourseCoachRoute({ id }: { id: CourseId }) {
  const state = useCourseDetail(id);
  const detail = state.data && "stages" in state.data ? state.data as CourseDetail : null;

  return (
    <AppShell connection={state.connection}>
      {state.loading && <LoadingState />}
      {state.error && <ErrorState message={state.error} />}
      {state.data && !detail && <ErrorState message={state.data.warning ?? "course.md 尚未准备好"} />}
      {detail && (
        <Suspense fallback={<LoadingState />}>
          <CourseCoachPage course={detail} onComplete={() => {}} />
        </Suspense>
      )}
    </AppShell>
  );
}

function filterCourses(courses: CourseSummary[], hidden: string[], order: string[]) {
  return courses.filter((course) => !hidden.includes(course.id) && !course.archived).sort((a, b) => { const ai = order.indexOf(a.id); const bi = order.indexOf(b.id); return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || (a.order ?? 999) - (b.order ?? 999); });
}

function filterDashboard(data: CoursesResponse, hidden: string[], order: string[]): CoursesResponse {
  const courses = filterCourses(data.courses, hidden, order);
  const ids = new Set(courses.map((course) => course.id));
  return { ...data, courses, recentRecords: data.recentRecords.filter((record) => ids.has(record.courseId)) };
}

function useCoursesAndPreferences() {
  const coursesState = useDashboardData();
  const [preferences] = usePreferences();
  return { coursesState, courses: filterCourses(coursesState.data?.courses ?? [], preferences.hiddenCourseIds, preferences.courseOrder), preferences };
}

function PageState({ loading, error, children }: { loading: boolean; error: string | null; children: ReactNode }) {
  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} />;
  return <Suspense fallback={<LoadingState />}>{children}</Suspense>;
}

function TasksRoute() { const { coursesState, courses } = useCoursesAndPreferences(); const state = useApiData<TaskReference[]>(fetchTasks); const ids = new Set(courses.map((course) => course.id)); return <AppShell connection={state.connection}><PageState loading={state.loading || coursesState.loading} error={state.error || coursesState.error}>{state.data && <TasksPage courses={courses} tasks={state.data.filter((item) => ids.has(item.courseId))} />}</PageState></AppShell>; }
function ReviewRoute() { const { coursesState, courses } = useCoursesAndPreferences(); const [revision, setRevision] = useState(0); const state = useApiData<ReviewItem[]>(fetchReviews, String(revision)); const due = useApiData<ScheduledReview[]>(fetchDueReviews, String(revision)); const ids = new Set(courses.map((course) => course.id)); return <AppShell connection={state.connection}><PageState loading={state.loading || due.loading || coursesState.loading} error={state.error || due.error || coursesState.error}>{state.data && due.data && <ReviewPage courses={courses} reviews={state.data.filter((item) => ids.has(item.courseId))} scheduledReviews={due.data.filter((item) => ids.has(item.courseId))} onSaved={() => setRevision((value) => value + 1)} />}</PageState></AppShell>; }
function ResourcesRoute() { const { coursesState, courses } = useCoursesAndPreferences(); const state = useApiData<ResourceItem[]>(fetchResources); const ids = new Set(courses.map((course) => course.id)); return <AppShell connection={state.connection}><PageState loading={state.loading || coursesState.loading} error={state.error || coursesState.error}>{state.data && <ResourcesPage courses={courses} resources={state.data.filter((item) => ids.has(item.courseId))} />}</PageState></AppShell>; }
function NotesRoute() { const { id } = useParams(); const { coursesState, courses } = useCoursesAndPreferences(); const state = useApiData<NoteDocument[]>(fetchNotes); const ids = new Set(courses.map((course) => course.id)); return <AppShell connection={state.connection}><PageState loading={state.loading || coursesState.loading} error={state.error || coursesState.error}>{state.data && <NotesPage courses={courses} notes={state.data.filter((item) => item.isStandalone || ids.has(item.courseId))} selectedId={id} />}</PageState></AppShell>; }
function StatsRoute() { const state = useApiData<LearningStats>(fetchStats); return <AppShell connection={state.connection}><PageState loading={state.loading} error={state.error}>{state.data && <StatsPage stats={state.data} />}</PageState></AppShell>; }
function SettingsRoute() { const { coursesState } = useCoursesAndPreferences(); const state = useApiData<SettingsData>(fetchSettings); return <AppShell connection={state.connection}><PageState loading={state.loading || coursesState.loading} error={state.error || coursesState.error}>{state.data && coursesState.data && <SettingsPage settings={state.data} courses={coursesState.data.courses} />}</PageState></AppShell>; }
function CoursesRoute() { const { coursesState, courses } = useCoursesAndPreferences(); const settings = useApiData<SettingsData>(fetchSettings); const merged = courses.map((course) => ({ ...course, artifacts: settings.data?.courses.find((item) => item.id === course.id)?.artifacts })); return <AppShell connection={settings.connection}><PageState loading={settings.loading || coursesState.loading} error={settings.error || coursesState.error}><CoursesPage courses={merged} /></PageState></AppShell>; }
function CourseImportRoute() { return <AppShell connection="live"><Suspense fallback={<LoadingState />}><CourseImportPage /></Suspense></AppShell>; }
function CalendarRoute() { const now = new Date(); const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`); const state = useApiData<CalendarEvent[]>((signal) => fetchCalendar(month, signal), month); return <AppShell connection={state.connection}><PageState loading={state.loading} error={state.error}>{state.data && <CalendarPage month={month} events={state.data} onMonthChange={setMonth} />}</PageState></AppShell>; }

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<DashboardRoute />} />
        <Route path="/courses" element={<CoursesRoute />} />
        <Route path="/courses/import" element={<CourseImportRoute />} />
        <Route path="/courses/:id" element={<CourseRoute />} />
        <Route path="/courses/:id/coach" element={<CourseCoachRoute />} />
        <Route path="/courses/:id/mistakes" element={<Suspense fallback={<LoadingState />}><CourseMistakesRoute /></Suspense>} />
        <Route path="/tasks" element={<TasksRoute />} />
        <Route path="/notes" element={<NotesRoute />} />
        <Route path="/notes/:id" element={<NotesRoute />} />
        <Route path="/review" element={<ReviewRoute />} />
        <Route path="/resources" element={<ResourcesRoute />} />
        <Route path="/calendar" element={<CalendarRoute />} />
        <Route path="/stats" element={<StatsRoute />} />
        <Route path="/settings" element={<SettingsRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
