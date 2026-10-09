import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Platforms that ship a fixed in-project auxiliary program for ZIP file operations. */
export const nativeIoSupported = process.platform === "win32" || process.platform === "darwin" || process.platform === "linux";
export const nativeIoPosix = process.platform === "darwin" || process.platform === "linux";
/** A Windows link needs an explicit reparse type; a POSIX directory link does not. */
export const linkType = (): "junction" | "dir" => (process.platform === "win32" ? "junction" : "dir");
/**
 * Create a temporary directory under its canonical path. The POSIX helper binds
 * every path component with O_NOFOLLOW, so callers must hand it canonical roots:
 * on macOS the system temp directory itself sits behind the /var symlink.
 */
export async function canonicalTempRoot(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}
/** The system temporary directory under its canonical path. */
export async function canonicalTempDirectory(): Promise<string> {
  return realpath(os.tmpdir());
}
