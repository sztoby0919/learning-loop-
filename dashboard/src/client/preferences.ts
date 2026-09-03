import { useCallback, useState } from "react";

const KEY = "study-dashboard.preferences.v1";

export interface DashboardPreferences {
  hiddenCourseIds: string[];
  courseOrder: string[];
}
const EMPTY: DashboardPreferences = { hiddenCourseIds: [], courseOrder: [] };

export function readPreferences(): DashboardPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<DashboardPreferences> | null;
    return { hiddenCourseIds: Array.isArray(value?.hiddenCourseIds) ? value.hiddenCourseIds : [], courseOrder: Array.isArray(value?.courseOrder) ? value.courseOrder : [] };
  } catch { return EMPTY; }
}

export function usePreferences() {
  const [preferences, setValue] = useState<DashboardPreferences>(readPreferences);
  const setPreferences = useCallback((next: DashboardPreferences) => {
    localStorage.setItem(KEY, JSON.stringify(next));
    setValue(next);
    window.dispatchEvent(new CustomEvent("dashboard-preferences"));
  }, []);
  return [preferences, setPreferences] as const;
}
