import { expect, test } from "@playwright/test";

function textPdf(): Buffer {
  const stream = "BT /F1 18 Tf 50 750 Td (Chapter 1 Limits and derivatives) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let raw = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(raw));
    raw += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(raw);
  raw += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(raw, "ascii");
}

test("PDF upload shows an editable preview and can be cancelled without creating a course", async ({ page }) => {
  await page.goto("/courses");
  await page.getByRole("link", { name: "从 PDF 创建课程" }).click();
  await page.getByLabel("选择 PDF 文件").setInputFiles({ name: "limits.pdf", mimeType: "application/pdf", buffer: textPdf() });
  await expect(page.getByLabel("课程名称")).toHaveValue("limits");
  await expect(page.getByText("公式、表格和图片可能无法从 PDF 文字层准确提取，请对照原文核查。")).toBeVisible();
  await page.getByLabel("课程名称").fill("我的极限课程");
  await page.getByRole("button", { name: "更新预览" }).click();
  await page.locator(".import-preview details").first().evaluate((element) => { (element as HTMLDetailsElement).open = true; });
  await expect(page.locator(".import-preview pre").first()).toContainText("我的极限课程");
  await page.getByRole("button", { name: "取消导入" }).click();
  await expect(page).toHaveURL(/\/courses$/);
  await expect(page.getByText("我的极限课程")).toHaveCount(0);
});
