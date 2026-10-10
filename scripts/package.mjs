import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "dashboard/package.json"));
const JSZip = require("jszip");
const flags = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (!key.startsWith("--") || !value || value.startsWith("--")) throw new Error(`缺少参数值：${key}`);
  flags.set(key.slice(2), value);
}
const allowedFlags = new Set(["team", "leader", "phone", "work", "output-dir", "description", "evidence", "report", "video"]);
for (const key of flags.keys()) if (!allowedFlags.has(key)) throw new Error(`未知参数：${key}`);
const team = flags.get("team") ?? process.env.TEAM_NAME;
const leader = flags.get("leader") ?? process.env.LEADER_NAME;
const phone = flags.get("phone") ?? process.env.LEADER_PHONE;
const work = flags.get("work") ?? process.env.WORK_NAME;
const description = flags.get("description");
const evidence = flags.get("evidence");
if (![team, leader, phone, work, description, evidence].every(Boolean)) throw new Error("必填：--team --leader --phone --work --description --evidence；可选 --report --video --output-dir");
for (const name of [team, leader, phone, work]) {
  if (/[<>:"/\\|?*\r\n]/.test(name) || name.endsWith(".") || name.endsWith(" ")) throw new Error("团队及作品名称包含非法文件名字符");
}
if (!/^\d{11}$/.test(phone)) throw new Error("手机号应为 11 位数字");
const top = `${team}-${leader}-${phone}-${work}`;
const outputDir = path.resolve(root, flags.get("output-dir") ?? process.env.OUTPUT_DIR ?? "dist/submissions");
await mkdir(outputDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const output = path.join(outputDir, `${top}-${stamp}.zip`);
const zip = new JSZip();
const files = new Map();
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function add(dest, source) {
  const stat = await lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`材料必须是普通文件：${dest}`);
  if (files.has(dest)) throw new Error(`重复材料：${dest}`);
  files.set(dest, await readFile(source));
}
const ignoredNames = new Set(["node_modules", "dist", "test-results", "playwright-report", "mcp", ".git", ".env", ".learning-loop", "learning-journal"]);
async function addDirectory(relative) {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (ignoredNames.has(entry.name) || entry.name.endsWith(".tsbuildinfo")) continue;
    const next = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`不打包链接：${next}`);
    if (entry.isDirectory()) await addDirectory(next);
    else if (entry.isFile()) await add(`源代码/${next}`, path.join(root, next));
  }
}
for (const file of ["package.json", "package-lock.json", "README.md", "LICENSE", "SKILL.md", ".gitignore", ".env.example", "dashboard.config.example.json"]) await add(`源代码/${file}`, path.join(root, file));
for (const file of ["package.json", "index.html", "vite.config.ts", "vitest.config.ts", "playwright.config.ts", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json"]) await add(`源代码/dashboard/${file}`, path.join(root, "dashboard", file));
for (const dir of ["dashboard/src", "dashboard/tests", "dashboard/scripts", "references", "templates", "agents", "scripts"]) await addDirectory(dir);

// Committed public examples only. Never copy later local learning sessions or edit originals.
const examplePaths = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", "examples/demo-course"], { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
if (!examplePaths.length) throw new Error("缺少已登记的示例课程");
for (const relative of examplePaths) {
  if (!/^examples\/demo-course\/[a-zA-Z0-9_./-]+\.md$/.test(relative) || relative.includes("..")) throw new Error("示例路径不符合允许范围");
  files.set(`源代码/${relative}`, execFileSync("git", ["show", `HEAD:${relative}`], { cwd: root }));
}
files.set("源代码/examples/README.md", Buffer.from("# 演示数据说明\n\n本目录使用版本库已登记的公开演示课程，不包含本机后续新增学习会话。示例日期、成绩与掌握度用于演示，不能作为团队真实学习效果的证据。运行诊断后产生的 Mock 记录也是演示数据。\n"));
await add("作品说明.docx", path.resolve(root, description));
await add("作品说明.md", path.join(root, "作品说明.md"));
await add("附件/湛卢使用证据.zip", path.resolve(root, evidence));
await add("附件/录制脚本.md", path.join(root, "演示视频脚本.md"));
for (const name of ["2026-10-03-moma-reliability-repair.md", "2026-10-03-moma-live-acceptance.md", "2026-10-03-moma-browser-acceptance.md", "2026-10-07-pdf-chapter-fallback.md", "2026-10-07-course-management.md", "2026-10-07-multi-file-course-import.md"]) {
  await add(`源代码/docs/superpowers/reports/${name}`, path.join(root, "docs/superpowers/reports", name));
}
await add("附件/历史MoMA验收/结果.json", path.join(root, ".superpowers/live-moma-browser-repair-result.json"));
for (const [name, source] of [
  ["test.log", ".superpowers/course-management-test.log"],
  ["build.log", ".superpowers/course-management-build.log"],
  ["browser.log", ".superpowers/course-management-browser.log"],
  ["edit-form.png", ".superpowers/course-management-browser/edit-form.png"],
]) await add(`附件/本次更新/${name}`, path.join(root, source));
for (const name of ["granularity-related-test.log", "granularity-build.log", "granularity-browser.log"]) {
  await add(`附件/阶段划分/${name}`, path.join(root, "submission-prep", name));
}
for (const [name, source] of [
  ["test.log", ".superpowers/course-bundles-test.log"],
  ["build.log", ".superpowers/course-bundles-build.log"],
  ["browser.log", ".superpowers/course-bundles-browser.log"],
  ["result.json", ".superpowers/course-bundles-browser/result.json"],
  ["01-multi-file-preview.png", ".superpowers/course-bundles-browser/01-multi-file-preview.png"],
  ["02-append-preview.png", ".superpowers/course-bundles-browser/02-append-preview.png"],
  ["03-appended-course.png", ".superpowers/course-bundles-browser/03-appended-course.png"],
]) await add(`附件/多课件导入/${name}`, path.join(root, source));
await add("更新说明.md", path.join(root, "submission-prep/更新说明.md"));
if (flags.get("report")) {
  await add("验收记录.md", path.resolve(root, flags.get("report")));
  for (const name of ["install-check.log", "build-check.log", "test-check.log", "test-recheck.log", "browser-check.log"]) {
    await add(`附件/本次验收/${name}`, path.join(root, "submission-prep", name));
  }
  for (const name of ["smoke-result.json", "01-dashboard.png", "02-diagnosis-preview.png", "03-backup-restored.png"]) {
    await add(`附件/本次验收/${name}`, path.join(root, "submission-prep/acceptance-smoke-output", name));
  }
  for (const name of ["acceptance-smoke.mjs", "verify-submission.mjs"]) {
    await add(`附件/本次验收/${name}`, path.join(root, "submission-prep", name));
  }
}
if (flags.get("video")) {
  const video = flags.get("video");
  if (!/\.(mp4|mov|webm)$/i.test(video)) throw new Error("视频需为 MP4、MOV 或 WebM");
  await add(`演示视频${path.extname(video).toLowerCase()}`, path.resolve(root, video));
}
for (const [name, bytes] of files) {
  if (name.split("/").some((part) => ignoredNames.has(part)) || /(^|\/)\.env(?!\.example$)/.test(name)) throw new Error(`禁止材料：${name}`);
  // Bounded screening; no credential values are printed.
  if (/\.(md|json|ya?ml|[cm]?js|tsx?|ps1|sh|cs)$/i.test(name) && !/\.test\.[cm]?[jt]sx?$/.test(name)) {
    const text = bytes.toString("utf8");
    if (/\bsk-[A-Za-z0-9_-]{32,}\b/.test(text) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) throw new Error(`材料出现疑似凭证，请人工核对：${name}`);
  }
}
const evidenceZip = await JSZip.loadAsync(files.get("附件/湛卢使用证据.zip"), { checkCRC32: true });
for (const name of Object.keys(evidenceZip.files)) {
  if (name.includes("\\") || name.startsWith("/") || name.split("/").includes("..")) throw new Error("证据附件路径无效");
  if (/(^|\/)(\.env(?:\.[^/]+)?|[^/]+\.(?:sqlite|db))$/.test(name) && !name.endsWith(".env.example")) throw new Error("证据附件包含禁止文件");
}
files.set("提交包说明.md", Buffer.from(`# ${work}\n\n团队：${team}，队长：${leader}。\n\n## 阅读顺序\n\n1. 作品说明.docx：正式作品介绍与团队分工。\n2. 运行说明.md：从本包安装和启动的步骤。\n3. 源代码/：完整项目结构与离线示例。\n4. 附件/湛卢使用证据.zip：解压后打开 index.html，可离线阅读使用记录。\n${flags.has("report") ? "5. 验收记录.md：本包对应源码的安装、构建、测试与流程检查。\n" : ""}\n${flags.has("video") ? "本包已包含演示视频。\n" : "本包未包含演示视频；附件中的录制脚本不是视频成片。\n"}\n默认不配置模型凭证即可离线演示。不包含个人学习档案、真实密钥、依赖安装目录、浏览器缓存或未申报 MCP 原型。\n`));
await add("运行说明.md", path.join(root, "submission-prep/运行说明.md"));
const manifest = { formatVersion: 1, createdAt: new Date().toISOString(), archiveRoot: top, videoIncluded: flags.has("video"), files: [...files].map(([name, bytes]) => ({ path: name, size: bytes.length, sha256: sha(bytes) })) };
for (const [name, bytes] of files) zip.file(`${top}/${name}`, bytes);
zip.file(`${top}/manifest-sha256.json`, JSON.stringify(manifest, null, 2) + "\n");
const data = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, streamFiles: true });
if (data.length > 3_000_000_000) throw new Error("压缩包超过 3 GB");
await writeFile(output, data, { flag: "wx" });
const reread = await JSZip.loadAsync(await readFile(output), { checkCRC32: true });
for (const entry of manifest.files) {
  const item = reread.file(`${top}/${entry.path}`);
  if (!item || sha(await item.async("nodebuffer")) !== entry.sha256) throw new Error(`归档校验失败：${entry.path}`);
}
await writeFile(path.join(outputDir, "latest-package.json"), JSON.stringify({ archive: output, sha256: sha(data), bytes: data.length, fileCount: manifest.files.length + 1, videoIncluded: flags.has("video") }, null, 2) + "\n");
console.log(JSON.stringify({ archive: output, sha256: sha(data), bytes: data.length, fileCount: manifest.files.length + 1, videoIncluded: flags.has("video") }, null, 2));
