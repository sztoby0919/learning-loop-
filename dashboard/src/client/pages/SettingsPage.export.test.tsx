import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage.js";
import { downloadAllData } from "../api.js";

vi.mock("../api.js", () => ({ downloadAllData: vi.fn() }));

it("shows an actionable error when export fails", async () => {
  vi.mocked(downloadAllData).mockRejectedValueOnce(new Error("网络连接中断"));
  render(<SettingsPage settings={{ configPath: "config.json", courses: [] }} courses={[]} />);
  await userEvent.setup().click(screen.getByRole("button", { name: /导出全部数据/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("网络连接中断");
  expect(screen.getByRole("button", { name: /重试导出/ })).toBeEnabled();
});
