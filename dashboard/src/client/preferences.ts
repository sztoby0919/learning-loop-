import { useCallback, useEffect, useState } from "react";

const KEY = "study-dashboard.preferences.v1";

export type ThemeMode = "light" | "dark";

export interface DashboardPreferences {
  hiddenCourseIds: string[];
  courseOrder: string[];
  theme: ThemeMode;
}
const EMPTY: DashboardPreferences = { hiddenCourseIds: [], courseOrder: [], theme: "light" };

function getSystemTheme(): ThemeMode {
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

function getStoredTheme(): ThemeMode | null {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<DashboardPreferences> | null;
    if (stored?.theme === "dark" || stored?.theme === "light") return stored.theme;
  } catch { /* ignore */ }
  return null;
}

export function readPreferences(): DashboardPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<DashboardPreferences> | null;
    const theme = getStoredTheme() ?? getSystemTheme();
    return {
      hiddenCourseIds: Array.isArray(value?.hiddenCourseIds) ? value.hiddenCourseIds : [],
      courseOrder: Array.isArray(value?.courseOrder) ? value.courseOrder : [],
      theme,
    };
  } catch { return { ...EMPTY, theme: getSystemTheme() }; }
}

export function applyThemeToDocument(theme: ThemeMode): void {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

export function usePreferences() {
  const [preferences, setValue] = useState<DashboardPreferences>(readPreferences);
  const setPreferences = useCallback((next: DashboardPreferences) => {
    localStorage.setItem(KEY, JSON.stringify(next));
    setValue(next);
    applyThemeToDocument(next.theme);
    window.dispatchEvent(new CustomEvent("dashboard-preferences"));
  }, []);

  useEffect(() => {
    const sync = () => setValue(readPreferences());
    window.addEventListener("dashboard-preferences", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("dashboard-preferences", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  // Apply theme on mount and listen for system theme changes (only if user hasn't set preference)
  useEffect(() => {
    applyThemeToDocument(preferences.theme);
    const mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mediaQuery) return;
    const handleChange = () => {
      const stored = getStoredTheme();
      if (stored === null) {
        // User hasn't explicitly set theme, follow system
        const systemTheme = mediaQuery.matches ? "dark" : "light";
        setValue((current) => ({ ...current, theme: systemTheme }));
        applyThemeToDocument(systemTheme);
        window.dispatchEvent(new CustomEvent("dashboard-preferences"));
      }
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [preferences.theme]);

  return [preferences, setPreferences] as const;
}
