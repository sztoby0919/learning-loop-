// @vitest-environment node
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundFileIo } from "./native-file-io.js";

const roots: string[] = []; const workers: BoundFileIo[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((io) => io.close()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "learning-loop-native-")); roots.push(root);
  const io = new BoundFileIo(); workers.push(io);
  return { root, io };
}

describe.runIf(process.platform === "win32")("Windows actual bound IO", () => {
  it("fails closed on an unsupported platform without spawning a helper", async () => {
    const { io } = await setup(); vi.stubGlobal("process", { platform: "linux" });
    try { await expect(io.available()).rejects.toMatchObject({ status: 503 }); expect(io.workerPid).toBeUndefined(); }
    finally { vi.unstubAllGlobals(); }
  });
  it("holds ancestors against rename in another process throughout actual writes", async () => {
    const { root, io } = await setup(); const parent = path.join(root, "parent"); await mkdir(parent);
    const writer = await io.createWriter(path.join(parent, "file.md"), 100);
    await expect(rename(parent, path.join(root, "moved"))).rejects.toMatchObject({ code: expect.stringMatching(/EPERM|EBUSY|EACCES/) });
    await writer.write(Buffer.from("真实写入")); await writer.finish();
    expect(await readFile(path.join(parent, "file.md"), "utf8")).toBe("真实写入");
    await rename(parent, path.join(root, "moved"));
  }, 20000);
  it("rejects a junction ancestor without touching its external sentinel", async () => {
    const { root, io } = await setup(); const outside = path.join(root, "outside"); await mkdir(outside); await writeFile(path.join(outside, "sentinel.md"), "private");
    const redirected = path.join(root, "redirected"); await symlink(outside, redirected, "junction");
    await expect(io.readFile(path.join(redirected, "sentinel.md"), 100)).rejects.toThrow(/链接|reparse|安全/i);
    await expect(io.createWriter(path.join(redirected, "new.md"), 100)).rejects.toThrow(/链接|reparse|安全/i);
    expect(await readdir(outside)).toEqual(["sentinel.md"]); expect(await readFile(path.join(outside, "sentinel.md"), "utf8")).toBe("private");
  }, 20000);
  it("rejects hard-linked leaves before returning content", async () => {
    const { root, io } = await setup(); await writeFile(path.join(root, "private.md"), "private"); await link(path.join(root, "private.md"), path.join(root, "alias.md"));
    await expect(io.readFile(path.join(root, "alias.md"), 100)).rejects.toThrow(/硬链接|hardlink|安全/i);
    expect(await readFile(path.join(root, "private.md"), "utf8")).toBe("private");
  }, 20000);
  it("rejects a too-large read before returning bytes", async () => {
    const { root, io } = await setup(); await writeFile(path.join(root, "large.md"), "12345");
    await expect(io.readFile(path.join(root, "large.md"), 4)).rejects.toMatchObject({ status: 413 });
    expect(Buffer.from((await io.readFile(path.join(root, "large.md"), 5)).bytes).toString()).toBe("12345");
  }, 20000);
  it("rejects a too-large write before output and aborts only its newly created file", async () => {
    const { root, io } = await setup(); const filename = path.join(root, "new.md"); const writer = await io.createWriter(filename, 4);
    await expect(writer.write(Buffer.from("12345"))).rejects.toMatchObject({ status: 413 }); await writer.abort();
    expect(await readdir(root)).toEqual([]);
  }, 20000);
  it("does not overwrite an existing file", async () => {
    const { root, io } = await setup(); const filename = path.join(root, "existing.md"); await writeFile(filename, "keep");
    await expect(io.createWriter(filename, 100)).rejects.toMatchObject({ code: "EEXIST" }); expect(await readFile(filename, "utf8")).toBe("keep");
  }, 20000);
  it("creates nested directories but exclusive leaf never reuses an existing directory", async () => {
    const { root, io } = await setup(); const leaf = path.join(root, "a", "b");
    await io.ensureDirectory(leaf, true); await io.ensureDirectory(leaf);
    await expect(io.ensureDirectory(leaf, true)).rejects.toMatchObject({ code: "EEXIST" });
    expect((await io.listDirectory(path.dirname(leaf))).entries).toEqual([{ name: "b", kind: "directory" }]);
  }, 20000);
  it("streams multiple blocks through one worker and yields a stable file identity", async () => {
    const { root, io } = await setup(); const filename = path.join(root, "large.md"); const bytes = Buffer.alloc(150000, 65);
    const writer = await io.createWriter(filename, bytes.length); await writer.write(bytes); await writer.finish();
    const first = await io.readFile(filename, bytes.length); const pid = io.workerPid; const second = await io.readFile(filename, bytes.length);
    expect(Buffer.from(first.bytes).equals(bytes)).toBe(true); expect(first.identity).toBe(second.identity); expect(pid).toBeGreaterThan(0); expect(io.workerPid).toBe(pid);
  }, 20000);
  it("remains available after an idle interval without retaining locks", async () => {
    const { root, io } = await setup(); const filename = path.join(root, "file.md"); await writeFile(filename, "keep");
    await io.readFile(filename, 10); await new Promise((resolve) => setTimeout(resolve, 16000));
    expect(Buffer.from((await io.readFile(filename, 10)).bytes).toString()).toBe("keep");
  }, 25000);
  it("remains available after a recoverable missing-file error followed by an idle interval", async () => {
    const { root, io } = await setup();
    await expect(io.readFile(path.join(root, "missing.md"), 10)).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 16000));
    await io.available();
    const writer = await io.createWriter(path.join(root, "after-idle.md"), 10);
    await writer.write(Buffer.from("keep")); await writer.finish();
    expect(await readFile(path.join(root, "after-idle.md"), "utf8")).toBe("keep");
  }, 25000);
  it("fails closed after the actual helper dies, without continuing ordinary path writes", async () => {
    const { root, io } = await setup(); const parent = path.join(root, "parent"); await mkdir(parent);
    const writer = await io.createWriter(path.join(parent, "partial.md"), 100); await writer.write(Buffer.from("partial"));
    process.kill(io.workerPid!); await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(writer.write(Buffer.from("after crash"))).rejects.toThrow(/辅助|helper|关闭|不可用/i);
    await rename(parent, path.join(root, "moved")); expect(await readdir(path.join(root, "moved"))).toEqual([]);
  }, 20000);
  it("bounds active handles and releases aborted outputs", async () => {
    const { root, io } = await setup(); const writers = [];
    for (let index = 0; index < 16; index++) writers.push(await io.createWriter(path.join(root, `${index}.md`), 10));
    await expect(io.createWriter(path.join(root, "extra.md"), 10)).rejects.toMatchObject({ status: 413 });
    for (const writer of writers) await writer.abort(); expect(await readdir(root)).toEqual([]);
  }, 20000);
  it("aborts the actual lease after finish fails, releases ancestors and restores all writer capacity", async () => {
    const { root, io } = await setup(); const parent = path.join(root, "parent"); await mkdir(parent);
    const writer = await io.createWriter(path.join(parent, "partial.md"), 10); await writer.write(Buffer.from("partial"));
    const boundary = io as unknown as { request(command: Record<string, unknown>): Promise<Record<string, unknown>> };
    const original = boundary.request.bind(io);
    const failure = new Error("injected native finish failure");
    const spy = vi.spyOn(boundary, "request").mockImplementation((command) => command.command === "finishWrite" ? Promise.reject(failure) : original(command));
    try { await expect(writer.finish()).rejects.toBe(failure); await writer.abort(); }
    finally { spy.mockRestore(); }
    expect(await readdir(parent)).toEqual([]);
    await rename(parent, path.join(root, "moved"));
    const writers = [];
    for (let index = 0; index < 16; index++) writers.push(await io.createWriter(path.join(root, `${index}.md`), 10));
    for (const next of writers) await next.abort();
    await io.available();
  }, 20000);
});
