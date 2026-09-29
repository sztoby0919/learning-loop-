import { expect, test } from "@playwright/test";

test("手工课程的真实空引用响应不显示失效来源入口", async ({ page }) => {
  await page.goto("/notes/calculus-101");
  await expect(page.getByRole("heading", { name: "极限与连续", level: 2 })).toBeVisible();
  await expect(page.getByRole("link", { name: /打开原文件/ })).toHaveCount(0);
});

test("浏览器显示 PDF 页码、估算位置与 AI 待核对，来源链接可键盘聚焦", async ({ page }) => {
  // The server separately verifies managed files; this route fixture isolates browser presentation.
  await page.route("**/api/courses/calculus-101/source-references", (route) => route.fulfill({ json: [
    {
      artifact: "course", headingIndex: 0, heading: "极限", kind: "pdf-page", position: 7,
      sourceUrl: "/api/courses/calculus-101/source#page=7", verifiedExcerpt: "经核验的原文", aiDerived: false,
    },
    {
      artifact: "notes", headingIndex: 0, heading: "极限与连续", kind: "pdf-page", position: 7,
      sourceUrl: "/api/courses/calculus-101/source#page=7", verifiedExcerpt: null, aiDerived: false,
    },
    {
      artifact: "notes", headingIndex: 1, heading: "导数", kind: "virtual-position", position: 3,
      sourceUrl: "/api/courses/calculus-101/source", verifiedExcerpt: "不能声称已核验", aiDerived: true,
    },
  ] }));

  await page.goto("/courses/calculus-101");
  await expect(page.getByText("原 PDF 第 7 页")).toBeVisible();
  await expect(page.getByText("原文摘录：经核验的原文")).toBeVisible();
  const courseSource = page.getByRole("link", { name: "打开原文件：极限" });
  await expect(courseSource).toHaveAttribute("href", "/api/courses/calculus-101/source#page=7");
  await courseSource.focus();
  await expect(courseSource).toBeFocused();

  await page.goto("/notes/calculus-101");
  await expect(page.getByText("原 PDF 第 7 页")).toBeVisible();
  await expect(page.getByText("第 3 段文本（估算位置）")).toBeVisible();
  await expect(page.getByText("待核对")).toBeVisible();
  await expect(page.getByRole("link", { name: "打开原文件：导数" })).toHaveAttribute("href", "/api/courses/calculus-101/source");
  await expect(page.getByText(/原文摘录/)).toHaveCount(0);
});
