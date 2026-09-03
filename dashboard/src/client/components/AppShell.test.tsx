import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AppShell } from "./AppShell.js";

describe("AppShell", () => {
  it("显示九个可用导航入口并根据路由显示页面标题", () => {
    render(<MemoryRouter initialEntries={["/review"]}><AppShell connection="live"><p>内容</p></AppShell></MemoryRouter>);

    for (const name of ["学习总览", "课程", "任务", "笔记", "复习", "资源", "日历", "统计", "设置"]) {
      expect(screen.getAllByRole("link", { name })).not.toHaveLength(0);
    }
    expect(screen.getByRole("heading", { name: "复习", level: 1 })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "复习" })[0]).toHaveAttribute("aria-current", "page");
  });
});
