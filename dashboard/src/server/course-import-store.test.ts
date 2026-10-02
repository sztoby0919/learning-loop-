// @vitest-environment node
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DraftEntry } from "../shared/course-import.js";
import { createBasicDraft } from "./course-import.js";
import { DraftStore } from "./course-import-store.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learning-loop-draft-store-"));
  roots.push(root);
  let now = Date.UTC(2026, 9, 1);
  const source = { title: "Course", pageCount: 2, pages: [{ page: 1, text: "Chapter text" }], outline: [{ title: "Chapter 1", page: 1 }], warnings: [], sourceFormat: "pdf" as const };
  const id = randomUUID();
  const entry: DraftEntry = { version: 1, id, courseId: `course-${id.slice(0, 8)}`, revision: 0, createdAt: now, updatedAt: now, expiresAt: now + 7 * 24 * 60 * 60 * 1000, state: "open", source, draft: createBasicDraft(source, "book.pdf"), sourceExtension: ".pdf" };
  const store = new DraftStore(root, () => now);
  return { root, entry, store, setNow: (value: number) => { now = value; }, now: () => now };
}

describe("persistent import drafts", () => {
  it("restores the saved draft and source from a fresh store instance", async () => {
    const { root, store, entry, now } = await setup();
    await store.create(entry, new Uint8Array(Buffer.from("%PDF-original")));
    const restarted = new DraftStore(root, now);
    expect(await restarted.read(entry.id)).toEqual(entry);
    expect(await fs.readFile(await restarted.sourcePath(entry.id), "utf8")).toBe("%PDF-original");
    expect(await restarted.list()).toMatchObject([{ id: entry.id, title: "Course", status: "ready", expiresAt: entry.expiresAt }]);
  });

  it("atomically replaces a revision and rejects a stale writer", async () => {
    const { store, entry } = await setup();
    await store.create(entry, new Uint8Array([1]));
    const changed = { ...entry, revision: 1, draft: { ...entry.draft, title: "Saved title" } };
    await store.replace(changed, 0);
    await expect(store.replace({ ...changed, draft: { ...changed.draft, title: "Stale title" } }, 0)).rejects.toMatchObject({ status: 409 });
    expect((await store.read(entry.id)).draft.title).toBe("Saved title");
    expect((await store.read(entry.id)).revision).toBe(1);
  });

  it("does not claim a save or damage old data when the atomic rename fails", async () => {
    const { store, entry } = await setup();
    await store.create(entry, new Uint8Array([1]));
    vi.spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error("disk failure"), { code: "EIO" }));
    await expect(store.replace({ ...entry, revision: 1, draft: { ...entry.draft, title: "Lost edit" } }, 0)).rejects.toThrow("disk failure");
    expect((await store.read(entry.id)).draft.title).toBe("Course");
    expect((await store.read(entry.id)).revision).toBe(0);
  });

  it("expires seven days after creation even after editing", async () => {
    const { store, entry, setNow } = await setup();
    await store.create(entry, new Uint8Array([1]));
    setNow(entry.expiresAt - 1);
    await store.replace({ ...entry, revision: 1, updatedAt: entry.expiresAt - 1 }, 0);
    expect((await store.read(entry.id)).expiresAt).toBe(entry.expiresAt);
    await expect(store.replace({ ...entry, revision: 2, expiresAt: entry.expiresAt + 1000 }, 1)).rejects.toMatchObject({ status: 422 });
    setNow(entry.expiresAt);
    await expect(store.read(entry.id)).rejects.toMatchObject({ status: 410 });
    await store.cleanupExpired();
    expect(await store.list()).toEqual([]);
  });

  it.each(["broken-json", "unknown-version", "bad-page", "unknown-secret", "oversized"])("isolates %s snapshots without hiding healthy drafts", async (kind) => {
    const { root, store, entry } = await setup();
    await store.create(entry, new Uint8Array([1]));
    const bad = { ...entry, id: randomUUID() };
    const dir = path.join(root, ".learning-loop", "imports", bad.id);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "source.pdf"), "source");
    const invalid: unknown = kind === "unknown-version" ? { ...bad, version: 99 }
      : kind === "bad-page" ? { ...bad, source: { ...bad.source, pages: [{ page: 3, text: "Out of range" }] } }
        : kind === "unknown-secret" ? { ...bad, apiKey: "not-a-real-secret" } : bad;
    await fs.writeFile(path.join(dir, "state.json"), kind === "broken-json" ? "{" : kind === "oversized" ? " ".repeat(32 * 1024 * 1024 + 1) : JSON.stringify(invalid));
    expect(await store.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: entry.id, status: "ready" }),
      expect.objectContaining({ id: bad.id, status: "invalid" }),
    ]));
    await expect(store.read(bad.id)).rejects.toMatchObject({ status: 422 });
    expect((await store.read(entry.id)).draft.title).toBe("Course");
  });

  it("deletes only the selected draft and never accepts path input as an ID", async () => {
    const { root, store, entry } = await setup();
    const sentinel = path.join(root, "keep.txt");
    await fs.writeFile(sentinel, "keep");
    await store.create(entry, new Uint8Array([1]));
    await expect(store.delete("../../keep.txt")).rejects.toMatchObject({ status: 400 });
    await store.delete(entry.id);
    expect(await store.list()).toEqual([]);
    expect(await fs.readFile(sentinel, "utf8")).toBe("keep");
  });

  it("cleans old legacy uploads only after the old 24-hour expiry", async () => {
    const { root, store, entry, now } = await setup();
    await store.create(entry, new Uint8Array([1]));
    const dir = path.join(root, ".learning-loop", "imports");
    const fresh = path.join(dir, `${randomUUID()}.pdf`);
    const stale = path.join(dir, `${randomUUID()}.pdf`);
    await fs.writeFile(fresh, "fresh"); await fs.writeFile(stale, "stale");
    await fs.utimes(fresh, new Date(now()), new Date(now()));
    await fs.utimes(stale, new Date(now() - 24 * 60 * 60 * 1000), new Date(now() - 24 * 60 * 60 * 1000));
    await store.cleanupExpired();
    expect(await fs.readFile(fresh, "utf8")).toBe("fresh");
    await expect(fs.stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.read(entry.id)).draft.title).toBe("Course");
  });

  it("refuses a draft directory junction and cleanup never follows it", async () => {
    const { root, store, entry, setNow } = await setup();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "learning-loop-outside-")); roots.push(outside);
    await fs.writeFile(path.join(outside, "keep.txt"), "keep");
    await store.create(entry, new Uint8Array([1]));
    const linkId = randomUUID();
    await fs.symlink(outside, path.join(root, ".learning-loop", "imports", linkId), "junction");
    await expect(store.read(linkId)).rejects.toMatchObject({ status: 422 });
    setNow(entry.expiresAt);
    await store.cleanupExpired();
    expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
  });

  it.for(["source.pdf", "state.json"])("refuses %s file links", async (filename, { skip }) => {
    const { root, store, entry } = await setup();
    await store.create(entry, new Uint8Array([1]));
    const external = path.join(root, "external.txt");
    await fs.writeFile(external, filename === "state.json" ? JSON.stringify(entry) : "external source");
    const target = path.join(root, ".learning-loop", "imports", entry.id, filename);
    await fs.rm(target);
    try { await fs.symlink(external, target, "file"); }
    catch (error) { if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return skip("Windows file symlink privilege unavailable"); throw error; }
    if (filename === "source.pdf") await expect(store.sourcePath(entry.id)).rejects.toMatchObject({ status: 422 });
    else await expect(store.read(entry.id)).rejects.toMatchObject({ status: 422 });
  });
});
