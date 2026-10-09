// @vitest-environment node
import * as childProcess from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalTempRoot, nativeIoPosix } from "./native-test-support.js";
import { BoundFileIo } from "./native-file-io.js";
vi.mock("node:child_process", { spy: true });

const roots: string[] = []; const workers: BoundFileIo[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(workers.splice(0).map((io) => io.close()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// Test-only patched copy of the helper injects a real path swap at the exact window
// where the production helper holds an opened ancestor. Production accepts no helper
// path override and no arbitrary command: the swap only happens in this copy.
async function setup(kind: "directory" | "file" | "publish" | "finish" | "probe") {
  const root = await canonicalTempRoot("learning-loop-posix-window-"); roots.push(root);
  const parent = path.join(root, "parent"), outside = path.join(root, "outside");
  await mkdir(parent); await mkdir(outside); await writeFile(path.join(outside, "sentinel.md"), "private");
  const moved = path.join(root, "moved");
  const target = kind === "file" ? path.join(parent, "created.md") : path.join(parent, "created");
  const marker = path.join(root, "race-ran");
  const nativeRoot = fileURLToPath(new URL("./native/", import.meta.url));
  let source = await readFile(path.join(nativeRoot, "posix-file-io.mjs"), "utf8");
  const hook = `
function raceSwap(observed, observedParent) {
  if (observed !== ${JSON.stringify(kind === "publish" ? path.join(parent, "created") : target)}) return;
  if (observedParent !== ${JSON.stringify(parent)}) return;
  fs.renameSync(${JSON.stringify(parent)}, ${JSON.stringify(moved)});
  fs.symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(parent)});
  fs.writeFileSync(${JSON.stringify(marker)}, "set");
}
`;
  source = source.replace("class Failure extends Error {", `${hook}\nclass Failure extends Error {`);
  if (kind === "directory") {
    expect(source).toContain("      verifyIdentity(next);");
    source = source.replace("      verifyIdentity(next);", "      verifyIdentity(next);\n      raceSwap(childPath, path.dirname(childPath));");
  } else if (kind === "file") {
    expect(source).toContain("        claim = fs.openSync(target, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);");
    source = source.replace("        claim = fs.openSync(target,", "        raceSwap(full, path.dirname(full));\n        claim = fs.openSync(target,");
  } else if (kind === "publish") {
    expect(source).toContain("        fs.renameSync(storedName(source, sourceChain), target);");
    source = source.replace("        fs.renameSync(storedName(source, sourceChain), target);", "        raceSwap(destination, path.dirname(destination));\n        fs.renameSync(storedName(source, sourceChain), target);");
  } else if (kind === "finish") {
    expect(source).toContain("    const [temporary] = lease.temporary;");
    source = source.replace("    const [temporary] = lease.temporary;", "    if (!globalThis.__injectedFlushFailure) { globalThis.__injectedFlushFailure = true; throw new Failure(\"injected native flush failure\", 422, \"EIO\"); }\n    const [temporary] = lease.temporary;");
  } else {
    expect(source).toContain("  capabilityProbe();");
    source = source.replace("  capabilityProbe();", "  throw new Failure(\"ZIP 安全文件操作不可用：此文件系统不支持按对象标识寻址\", 503, \"EINVAL\");");
  }
  const helper = path.join(root, "posix-file-io.mjs");
  await writeFile(helper, source);
  const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.spyOn(childProcess, "spawn").mockImplementation((executable, args, options) =>
    spawn(executable, (args as string[]).map((arg) => (arg.endsWith("posix-file-io.mjs") ? helper : arg)), options as never));
  const io = new BoundFileIo(); workers.push(io);
  return { root, parent, outside, moved, target, marker, io };
}

describe.runIf(nativeIoPosix)("actual in-place path swaps while the helper holds the ancestor", () => {
  it("keeps creating a directory inside the bound parent after the parent path is taken over", async () => {
    const { parent, outside, moved, marker, io } = await setup("directory");
    await io.ensureDirectory(path.join(parent, "created"), true);
    expect(await readFile(marker, "utf8")).toBe("set");
    expect(await readdir(outside)).toEqual(["sentinel.md"]);
    expect(await readFile(path.join(outside, "sentinel.md"), "utf8")).toBe("private");
    expect(await readdir(path.join(moved, "created"))).toEqual([]);
  }, 20000);
  it("keeps writing into the bound parent after the parent path is taken over", async () => {
    const { parent, outside, moved, marker, io } = await setup("file");
    const writer = await io.createWriter(path.join(parent, "created.md"), 100);
    await writer.write(Buffer.from("owned")); await writer.finish();
    expect(await readFile(marker, "utf8")).toBe("set");
    expect(await readdir(outside)).toEqual(["sentinel.md"]);
    expect(await readFile(path.join(moved, "created.md"), "utf8")).toBe("owned");
  }, 20000);
  it("keeps publishing into the bound destination parent after that path is taken over", async () => {
    const { root, parent, outside, moved, marker, io } = await setup("publish");
    const owner = { id: randomUUID(), token: randomUUID(), newId: "course" };
    const source = path.join(root, "owned");
    await mkdir(source); await writeFile(path.join(source, ".learning-loop-restore.json"), JSON.stringify(owner)); await writeFile(path.join(source, "course.md"), "keep");
    await io.moveDirectory(source, path.join(parent, "created"), owner);
    expect(await readFile(marker, "utf8")).toBe("set");
    expect(await readdir(outside)).toEqual(["sentinel.md"]);
    expect(await readFile(path.join(moved, "created", "course.md"), "utf8")).toBe("keep");
  }, 20000);
  it("reclaims an actual native flush failure and completes the next write without restarting", async () => {
    const { root, parent, io } = await setup("finish");
    const writer = await io.createWriter(path.join(parent, "partial.md"), 10); await writer.write(Buffer.from("partial"));
    const pid = io.workerPid;
    await expect(writer.finish()).rejects.toThrow("injected native flush failure"); await writer.abort();
    expect(await readdir(parent)).toEqual([]);
    await rename(parent, path.join(root, "moved"));
    const writers = [];
    for (let index = 0; index < 16; index++) writers.push(await io.createWriter(path.join(root, `${index}.md`), 10));
    for (const next of writers) await next.abort();
    const next = await io.createWriter(path.join(root, "next.md"), 10); await next.write(Buffer.from("success")); await next.finish();
    expect(Buffer.from((await io.readFile(path.join(root, "next.md"), 10)).bytes).toString()).toBe("success");
    expect(io.workerPid).toBe(pid);
  }, 20000);
  it("disables ZIP with the helper's own reason when the anchor probe fails", async () => {
    const { io } = await setup("probe");
    await expect(io.available()).rejects.toMatchObject({ status: 503 });
    await expect(io.available()).rejects.toThrow(/对象标识|能力/);
  }, 20000);
});
