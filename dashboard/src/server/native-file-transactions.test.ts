// @vitest-environment node
import { mkdir, readFile, readdir, rm, symlink, writeFile, link } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalTempRoot, linkType, nativeIoSupported } from "./native-test-support.js";
import { BoundFileIo, type DirectoryOwner } from "./native-file-io.js";
const roots: string[] = []; const workers: BoundFileIo[] = [];
const owner: DirectoryOwner = { id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", token: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", newId: "new-course" };
afterEach(async () => { await Promise.all(workers.splice(0).map((io) => io.close())); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await canonicalTempRoot("learning-loop-native-txn-"); roots.push(root); const io = new BoundFileIo(); workers.push(io);
  const source = path.join(root, "stage", "course"); const destination = path.join(root, "journal", "new-course");
  await mkdir(source, { recursive: true }); await mkdir(path.dirname(destination));
  await writeFile(path.join(source, ".learning-loop-restore.json"), JSON.stringify(owner)); await writeFile(path.join(source, "course.md"), "keep");
  return { root, io, source, destination };
}
describe.runIf(nativeIoSupported)("bound publication and owned cleanup", () => {
  it("publishes and rolls back the owned directory without rewriting its files", async () => {
    const { io, source, destination } = await setup(); await io.moveDirectory(source, destination, owner);
    expect(await readFile(path.join(destination, "course.md"), "utf8")).toBe("keep");
    await io.moveDirectory(destination, source, owner); expect(await readFile(path.join(source, "course.md"), "utf8")).toBe("keep");
  }, 20000);
  it("never overwrites an existing destination", async () => {
    const { io, source, destination } = await setup(); await mkdir(destination); await writeFile(path.join(destination, "original.md"), "original");
    await expect(io.moveDirectory(source, destination, owner)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path.join(destination, "original.md"), "utf8")).toBe("original"); expect(await readFile(path.join(source, "course.md"), "utf8")).toBe("keep");
  }, 20000);
  it("refuses removal if the actual bound directory has another ownership marker", async () => {
    const { io, source } = await setup(); await expect(io.removeDirectory(source, { ...owner, token: "wrong" })).rejects.toThrow(/所有权/);
    expect(await readFile(path.join(source, "course.md"), "utf8")).toBe("keep");
  }, 20000);
  it("refuses a linked child before deleting any owned files, never follows the external target", async () => {
    const { root, io, source } = await setup(); const outside = path.join(root, "outside"); await mkdir(outside); await writeFile(path.join(outside, "sentinel.md"), "private");
    await symlink(outside, path.join(source, "linked"), linkType()); await expect(io.removeDirectory(source, owner)).rejects.toThrow(/链接|reparse/);
    expect(await readFile(path.join(source, "course.md"), "utf8")).toBe("keep"); expect(await readFile(path.join(outside, "sentinel.md"), "utf8")).toBe("private");
  }, 20000);
  it("removes an owned tree via its held handles", async () => {
    const { io, source } = await setup(); await mkdir(path.join(source, "sessions")); await writeFile(path.join(source, "sessions", "one.md"), "session");
    await io.removeDirectory(source, owner); expect(await readdir(path.dirname(source))).toEqual([]);
  }, 20000);
  it("cleans an owned preparation containing both extracted and staged copies within the ZIP limits", async () => {
    const { io, source } = await setup();
    for (const name of ["extracted", "staged"]) {
      const directory = path.join(source, name); await mkdir(directory);
      for (let offset = 0; offset < 1100; offset += 50) await Promise.all(Array.from({ length: Math.min(50, 1100 - offset) }, (_, index) => writeFile(path.join(directory, `${offset + index}.md`), "x")));
    }
    await io.removeDirectory(source, owner); expect(await readdir(path.dirname(source))).toEqual([]);
  }, 20000);
  it("refuses a replaced destination parent junction without publishing outside", async () => {
    const { root, io, source } = await setup(); const outside = path.join(root, "outside"); await mkdir(outside); await writeFile(path.join(outside, "sentinel.md"), "private");
    const parent = path.join(root, "redirect"); await symlink(outside, parent, linkType());
    await expect(io.moveDirectory(source, path.join(parent, "new-course"), owner)).rejects.toThrow(/链接|reparse/);
    expect(await readdir(outside)).toEqual(["sentinel.md"]); expect(await readFile(path.join(source, "course.md"), "utf8")).toBe("keep");
  }, 20000);
  it("atomically replaces state and leaves no temporary files", async () => {
    const { io, root } = await setup(); const filename = path.join(root, "state.json"); await writeFile(filename, "old");
    await io.replaceStateFile(filename, Buffer.from("new")); expect(await readFile(filename, "utf8")).toBe("new");
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  }, 20000);
  it("rejects hard-linked state targets without modifying the outside alias", async () => {
    const { io, root } = await setup(); const filename = path.join(root, "state.json"); await writeFile(filename, "old"); await link(filename, path.join(root, "outside.json"));
    await expect(io.replaceStateFile(filename, Buffer.from("new"))).rejects.toThrow(/硬链接/);
    expect(await readFile(path.join(root, "outside.json"), "utf8")).toBe("old");
  }, 20000);
});
