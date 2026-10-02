// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { rawZip } from "../test/zip-fixtures.js";
import { BACKUP_LIMITS } from "../shared/course-backup.js";
import { BackupZipCodec, validateArchivePath } from "./backup-zip.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function target() { const base = await mkdtemp(path.join(os.tmpdir(), "learning-loop-zip-")); roots.push(base); await writeFile(path.join(base, "sentinel"), "keep"); return { base, root: path.join(base, "extract") }; }
const filename = "courses/course-test/course.md";
function mutate(input: Uint8Array, change: (bytes: Buffer, central: number) => void) { const bytes = Buffer.from(input); const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); change(bytes, central); return bytes; }
describe("bounded backup ZIP codec", () => {
  it("extracts valid archives with actual bytes and SHA-256", async () => {
    const { root } = await target();
    const files = await new BackupZipCodec().decodeToDirectory(rawZip([{ path: filename, text: "hello" }]), root);
    expect(files).toEqual([{ path: filename, bytes: 5, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" }]);
    expect(await readFile(path.join(root, filename), "utf8")).toBe("hello");
  });
  it.each(["../courses/course-test/course.md", "/courses/course-test/course.md", "C:/evil.md", "courses\\course-test\\course.md", "courses/course-test/../course.md", "courses/course-test/.env", "courses/course-test/sessions/CON.md", "courses/course-test/sessions/a..md", "courses/course-test//course.md"])("rejects unsafe or unknown path %s without touching outside data", async (name) => {
    const { root, base } = await target();
    expect(() => validateArchivePath(name)).toThrow(/路径/);
    await expect(new BackupZipCodec().decodeToDirectory(rawZip([{ path: name, text: "evil" }]), root)).rejects.toThrow(/ZIP|路径/);
    expect(await readFile(path.join(base, "sentinel"), "utf8")).toBe("keep");
  });
  it.each([[filename, filename], ["courses/course-test/sessions/A.md", "courses/course-test/sessions/a.md"]])("rejects duplicate and Windows case alias entries", async (first, second) => {
    const { root } = await target();
    await expect(new BackupZipCodec().decodeToDirectory(rawZip([{ path: first, text: "one" }, { path: second, text: "two" }]), root)).rejects.toThrow(/重复|大小写/);
    expect(await readdir(root).catch(() => [])).toEqual([]);
  });
  it.each(["name", "method", "size", "symlink", "crc"])("rejects inconsistent headers or special files: %s", async (kind) => {
    const { root } = await target();
    const zip = mutate(rawZip([{ path: filename, text: "hello" }]), (bytes, central) => {
      if (kind === "name") bytes[30] = 0x78;
      if (kind === "method") bytes.writeUInt16LE(8, 8);
      if (kind === "size") bytes.writeUInt32LE(1, central + 24);
      if (kind === "symlink") { bytes.writeUInt16LE(3 * 256 + 20, central + 4); bytes.writeUInt32LE((0xa1ff * 65536) >>> 0, central + 38); }
      if (kind === "crc") bytes[30 + filename.length] ^= 1;
    });
    await expect(new BackupZipCodec().decodeToDirectory(zip, root)).rejects.toThrow(/ZIP|链接|校验|头部/);
  });
  it("enforces actual output before writing a chunk even when both headers understate inflated size", async () => {
    const { root } = await target();
    const contents = "x".repeat(20000); const compressed = deflateRawSync(contents);
    const original = Buffer.from(rawZip([{ path: filename, text: contents }]));
    const dataStart = 30 + filename.length; const central = dataStart + contents.length;
    const parts = [original.subarray(0, dataStart), compressed, original.subarray(central)];
    const zip = Buffer.concat(parts); const centralOffset = dataStart + compressed.length;
    zip.writeUInt16LE(8, 8); zip.writeUInt32LE(compressed.length, 18); zip.writeUInt32LE(2, 22);
    zip.writeUInt16LE(8, centralOffset + 10); zip.writeUInt32LE(compressed.length, centralOffset + 20); zip.writeUInt32LE(2, centralOffset + 24); zip.writeUInt32LE(centralOffset, zip.length - 6);
    await expect(new BackupZipCodec().decodeToDirectory(zip, root, { ...BACKUP_LIMITS, totalBytes: 8, markdownBytes: 8 })).rejects.toThrow(/超限|大小|ZIP/);
    expect(await readdir(root).catch(() => [])).toEqual([]);
  });
  it("rejects too many entries including directories and declared limits", async () => {
    const { root } = await target();
    const bytes = rawZip(Array.from({ length: 2001 }, (_, index) => ({ path: `courses/course-test/sessions/a${index}.md`, text: "" })));
    await expect(new BackupZipCodec().decodeToDirectory(bytes, root)).rejects.toThrow(/数量|文件/);
    await expect(new BackupZipCodec().decodeToDirectory(rawZip([{ path: filename, text: "hello" }]), root, { ...BACKUP_LIMITS, totalBytes: 4 })).rejects.toThrow(/超限|大小/);
  });
  it("encodes a readable bounded backup without adding implicit duplicate directories", async () => {
    const codec = new BackupZipCodec(); const { root } = await target();
    const archive = await codec.encode((async function* () { yield { path: filename, bytes: new TextEncoder().encode("hello") }; })());
    expect(await codec.decodeToDirectory(archive, root)).toEqual([expect.objectContaining({ path: filename, bytes: 5 })]);
  });
});
