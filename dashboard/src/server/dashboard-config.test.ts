// @vitest-environment node

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadDashboardConfig } from "./dashboard-config.js";

const course = (id: string, title: string) => `---\nid: ${id}\ntitle: ${title}\nshortTitle: ${title}\naccent: "#27624B"\nupdated: 2026-08-29\norder: 1\narchived: false\n---\n# ${title}\n`;

describe("loadDashboardConfig", () => {
  it.each(["", "   ", null, 42])("拒绝空白或非字符串课程路径（%s）", async (invalidRoot) => {
    const configPath = path.join(await mkdtemp(path.join(tmpdir(), "dashboard-config-")), "dashboard.config.json");
    await writeFile(configPath, JSON.stringify({ courses: [{ root: invalidRoot }] }));
    await expect(loadDashboardConfig(configPath)).rejects.toThrow("课程 root");
  });
  it.each([null, "../compiler"])("读取启用课程，兼容绝对路径及相对于配置目录的路径（%s）", async (relativeRoot) => {
    const root = await mkdtemp(path.join(tmpdir(), "dashboard-config-"));
    const compiler = path.join(root, "compiler");
    const disabled = path.join(root, "disabled");
    await mkdir(compiler);
    await mkdir(disabled);
    await writeFile(path.join(compiler, "course.md"), course("compiler-principles", "编译原理"));
    await writeFile(path.join(disabled, "course.md"), course("hidden-course", "隐藏课程"));
    await mkdir(path.join(root, "dashboard"));
    const configPath = path.join(root, "dashboard", "dashboard.config.json");
    await writeFile(configPath, JSON.stringify({ courses: [{ root: relativeRoot ?? compiler, enabled: true }, { root: disabled, enabled: false }] }));

    const config = await loadDashboardConfig(configPath);

    expect(config.courses).toEqual([{ id: "compiler-principles", root: compiler, enabled: true }]);
  });

  it("拒绝重复课程 ID", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dashboard-config-"));
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    await mkdir(first);
    await mkdir(second);
    await writeFile(path.join(first, "course.md"), course("duplicate", "课程一"));
    await writeFile(path.join(second, "course.md"), course("duplicate", "课程二"));
    const configPath = path.join(root, "dashboard.config.json");
    await writeFile(configPath, JSON.stringify({ courses: [{ root: first, enabled: true }, { root: second, enabled: true }] }));

    await expect(loadDashboardConfig(configPath)).rejects.toThrow("重复课程 ID“duplicate”");
  });
});
