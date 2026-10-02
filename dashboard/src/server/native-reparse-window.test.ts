// @vitest-environment node
import * as childProcess from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundFileIo } from "./native-file-io.js";
vi.mock("node:child_process", { spy: true });

const roots: string[] = []; const workers: BoundFileIo[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(workers.splice(0).map((io) => io.close()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// Test-only compiled copy inserts a real FSCTL at the exact held-parent window.
// Production accepts no helper path override or arbitrary command.
async function setup(kind: "directory" | "file" | "publish" | "finish") {
  const root = await mkdtemp(path.join(os.tmpdir(), "learning-loop-reparse-")); roots.push(root);
  const parent = path.join(root, "parent"), outside = path.join(root, "outside");
  await mkdir(parent); await mkdir(outside); await writeFile(path.join(outside, "sentinel.md"), "private");
  const target = path.join(parent, kind === "file" ? "created.md" : "created");
  const nativeRoot = fileURLToPath(new URL("./native/", import.meta.url));
  let source = await readFile(path.join(nativeRoot, "windows-file-io.cs"), "utf8");
  const hook = `
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DeviceIoControl(SafeFileHandle h,uint code,byte[] input,int size,IntPtr output,int outputSize,out uint returned,IntPtr overlapped);
  static void ReparseRace(string full) {
    if(full!=${JSON.stringify(target)}) return;
    string parent=${JSON.stringify(parent)}, outside=${JSON.stringify(outside)};
    using(SafeFileHandle h=CreateFileW(parent,Write,3,IntPtr.Zero,3,DirectoryFlag|ReparseFlag,IntPtr.Zero)) {
      if(h.IsInvalid) throw WinError();
      byte[] substitute=Encoding.Unicode.GetBytes("\\\\??\\\\"+outside), print=Encoding.Unicode.GetBytes(outside);
      byte[] data=new byte[16+substitute.Length+2+print.Length+2];
      Array.Copy(BitConverter.GetBytes(0xA0000003U),0,data,0,4);
      Array.Copy(BitConverter.GetBytes((ushort)(data.Length-8)),0,data,4,2);
      Array.Copy(BitConverter.GetBytes((ushort)substitute.Length),0,data,10,2);
      Array.Copy(BitConverter.GetBytes((ushort)(substitute.Length+2)),0,data,12,2);
      Array.Copy(BitConverter.GetBytes((ushort)print.Length),0,data,14,2);
      Array.Copy(substitute,0,data,16,substitute.Length); Array.Copy(print,0,data,18+substitute.Length,print.Length);
      uint returned; if(!DeviceIoControl(h,0x000900A4,data,data.Length,IntPtr.Zero,0,out returned,IntPtr.Zero)) throw WinError();
      File.WriteAllText(${JSON.stringify(path.join(root, "race-ran"))},"set");
    }
  }
`;
  source = source.replace("  static string Normalize(string name) {", hook + "  static string Normalize(string name) {");
  const anchor = kind === "directory" ? "current=Path.Combine(current,parts[index]);" : kind === "file" ? "lease.Leaf=Open(full," : "VerifyOwner(source,request,directory); RenameHandle";
  expect(source).toContain(anchor);
  if (kind !== "finish") source = source.replace(anchor, kind === "directory" ? anchor + " ReparseRace(current);" : kind === "file" ? "ReparseRace(full); " + anchor : "ReparseRace(destination); " + anchor);
  if (kind === "finish") {
    source = source.replace("  readonly Dictionary<string, Lease> leases", "  bool failFinish=true;\n  readonly Dictionary<string, Lease> leases");
    source = source.replace("lease.Stream.Flush();", 'if(failFinish) { failFinish=false; throw new Failure("injected native flush failure",422,"EIO"); } lease.Stream.Flush();');
  }
  const helper = path.join(root, "windows-file-io.ps1");
  await writeFile(path.join(root, "windows-file-io.cs"), source);
  await writeFile(helper, await readFile(path.join(nativeRoot, "windows-file-io.ps1")));
  const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.spyOn(childProcess, "spawn").mockImplementation((executable, args, options) => spawn(executable, args!.map((arg) => arg.endsWith("windows-file-io.ps1") ? helper : arg), options!));
  const io = new BoundFileIo(); workers.push(io);
  return { root, parent, outside, target, io };
}

describe.runIf(process.platform === "win32")("actual in-place empty-parent reparse windows", () => {
  for (const kind of ["directory", "file", "publish"] as const) {
    it(`never changes the external directory during ${kind} after its parent becomes a junction`, async () => {
      const { root, outside, target, io } = await setup(kind);
      let error: unknown;
      try {
        if (kind === "directory") await io.ensureDirectory(target, true);
        else if (kind === "file") { const writer = await io.createWriter(target, 10); await writer.write(Buffer.from("owned")); await writer.finish(); }
        else {
          const source = path.join(root, "owned"), owner = { id: randomUUID(), token: randomUUID(), newId: "course" };
          await io.createOwnedDirectory(source, owner); await io.moveDirectory(source, target, owner);
        }
      } catch (caught) { error = caught; }
      expect(await readFile(path.join(root, "race-ran"), "utf8"), String(error)).toBe("set");
      expect(await readdir(outside)).toEqual(["sentinel.md"]);
      expect(await readFile(path.join(outside, "sentinel.md"), "utf8")).toBe("private");
    }, 20000);
  }
  it("reclaims an actual native flush-failure lease and completes the next write without restarting", async () => {
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
});
