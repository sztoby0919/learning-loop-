// @vitest-environment node
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { rawZip } from "../test/zip-fixtures.js";

describe("existing JSZip safety capability gate", () => {
  it("proves the public file dictionary loses duplicate original entries before validation", async () => {
    const filename = "courses/course-test/course.md";
    const archive = await JSZip.loadAsync(rawZip([{ path: filename, text: "first" }, { path: filename, text: "second" }]), { createFolders: false });
    expect(Object.keys(archive.files)).toEqual([filename]);
    expect(await archive.file(filename)!.async("string")).toBe("second");
  });
  it("proves normalization collisions can erase evidence of an unsafe original path", async () => {
    const filename = "courses/course-test/course.md";
    const archive = await JSZip.loadAsync(rawZip([{ path: `../${filename}`, text: "unsafe" }, { path: filename, text: "safe" }]), { createFolders: false });
    expect(Object.keys(archive.files)).toEqual([filename]);
    expect(archive.file(filename)!.unsafeOriginalName).toBe(filename);
    expect(await archive.file(filename)!.async("string")).toBe("safe");
  });
});
