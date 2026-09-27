import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { usePreferences } from "./preferences.js";

afterEach(() => localStorage.clear());

function PreferenceWriter({ name }: { name: string }) {
  const [preferences, setPreferences] = usePreferences();
  return <button onClick={() => setPreferences(name === "settings" ? { ...preferences, hiddenCourseIds: ["course-1"] } : { ...preferences, theme: "dark" })}>{name}: {preferences.hiddenCourseIds.join(",") || "empty"}</button>;
}

it("synchronizes multiple preference controls before one updates another field", async () => {
  localStorage.setItem("study-dashboard.preferences.v1", JSON.stringify({ hiddenCourseIds: [], courseOrder: ["course-1"], theme: "light" }));
  render(<><PreferenceWriter name="settings" /><PreferenceWriter name="floating" /></>);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /settings/ }));
  await user.click(screen.getByRole("button", { name: /floating/ }));
  expect(JSON.parse(localStorage.getItem("study-dashboard.preferences.v1")!).hiddenCourseIds).toEqual(["course-1"]);
});
