import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import JSZip from "jszip";
import * as yauzl from "yauzl";
import { BACKUP_LIMITS, type BackupEntry, type BackupLimits, type DecodedBackupFile, type ZipCodec, type BackupDirectoryOwner } from "../shared/course-backup.js";
import { backupFileIo } from "./native-file-io.js";
import { BackupError } from "./backup-error.js";
import { sourceFilePattern } from "./course-bundle-files.js";
export { BackupError } from "./backup-error.js";

const invalidPath = () => new BackupError("ZIP 路径不在允许范围内，拒绝恢复");
const courseId = /^[a-z0-9][a-z0-9-]{0,99}$/;
const sessionName = /^(?!.*\.\.)(?!^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\.)[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,199}\.md$/i;
export function validateArchivePath(name: string): string {
  if (!name || name.includes("\\") || name.includes(":") || name.includes("\0") || name.startsWith("/") || name.split("/").some((part) => [".", "..", ""].includes(part))) throw invalidPath();
  if (name === "manifest.json") return name;
  const parts = name.split("/");
  if (parts[0] !== "courses" || !courseId.test(parts[1] ?? "")) throw invalidPath();
  if (parts.length === 3 && (/^(course|notes|reviews|resources|schedule)\.md$/.test(parts[2]) || sourceFilePattern.test(parts[2]))) return name;
  if (parts.length === 4 && parts[2] === "sessions" && sessionName.test(parts[3])) return name;
  throw invalidPath();
}
function directoryPath(name: string): void {
  if (name === "courses/") return;
  if (/^courses\/[a-z0-9][a-z0-9-]{0,99}\/(sessions\/)?$/.test(name)) return;
  throw invalidPath();
}
export function archiveFileLimit(name: string, limits: BackupLimits = BACKUP_LIMITS): number {
  validateArchivePath(name);
  if (name === "manifest.json") return limits.manifestBytes;
  if (sourceFilePattern.test(path.posix.basename(name))) return limits.sourceBytes[name.split(".").pop()!] ?? 0;
  return limits.markdownBytes;
}
export async function safeBackupDirectory(dir: string): Promise<void> {
  await backupFileIo.listDirectory(path.resolve(dir));
}
const crcTable = Array.from({ length: 256 }, (_, index) => { let value = index; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); return value >>> 0; });
function updateCrc(crc: number, chunk: Uint8Array): number { for (const byte of chunk) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]; return crc; }

export class BackupZipCodec implements ZipCodec {
  async encode(entries: AsyncIterable<BackupEntry>): Promise<Uint8Array> {
    const zip = new JSZip(); const seen = new Set<string>(); let total = 0;
    for await (const entry of entries) {
      validateArchivePath(entry.path);
      const alias = entry.path.toLowerCase();
      if (seen.has(alias)) throw new BackupError("ZIP 存在重复或大小写冲突文件");
      seen.add(alias); total += entry.bytes.length;
      if (seen.size > BACKUP_LIMITS.files || total > BACKUP_LIMITS.totalBytes || entry.bytes.length > archiveFileLimit(entry.path)) throw new BackupError("备份数量或大小超限，请分课程备份", 413);
      zip.file(entry.path, entry.bytes, { createFolders: false, binary: true });
    }
    const output = zip.generateNodeStream({ type: "nodebuffer", streamFiles: true, compression: "DEFLATE", compressionOptions: { level: 6 } });
    const stream = new Readable().wrap(output);
    const chunks: Buffer[] = []; let size = 0;
    try { for await (const chunk of stream) { size += chunk.length; if (size > BACKUP_LIMITS.compressedBytes) throw new BackupError("ZIP 压缩大小超限，请分课程备份", 413); chunks.push(chunk); } }
    finally { stream.destroy(); }
    return Buffer.concat(chunks, size);
  }

  async decodeToDirectory(bytes: Uint8Array, root: string, limits: BackupLimits = BACKUP_LIMITS, ownership?: BackupDirectoryOwner): Promise<DecodedBackupFile[]> {
    await backupFileIo.available();
    if (bytes.length > limits.compressedBytes) throw new BackupError("ZIP 压缩大小超限", 413);
    const owner = ownership ?? { id: randomUUID(), token: randomUUID(), newId: "extracted" };
    let zip: yauzl.ZipFile | undefined; let owned = false;
    try {
      zip = await yauzl.fromBufferPromise(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
      if (zip.entryCount > limits.files + 1 + 2 * limits.courses) throw new BackupError("ZIP 文件与目录数量超限", 413);
      await backupFileIo.createOwnedDirectory(root, owner); owned = true;
      const entries: yauzl.Entry[] = [];
      for await (const entry of zip.eachEntry()) entries.push(entry);
      if (entries.filter((entry) => !entry.fileName.endsWith("/")).length > limits.files) throw new BackupError("ZIP 文件数量超限", 413);
      const seen = new Set<string>(); const courses = new Set<string>(); const sourceCourses = new Set<string>();
      const files: DecodedBackupFile[] = []; let total = 0; let declared = 0;
      for (const entry of entries) {
        const name = entry.fileName;
        if (!entry.fileNameRaw.equals(Buffer.from(name, "utf8")) || entry.extraFields.some((field) => field.id === 0x7075)) throw invalidPath();
        const isDirectory = name.endsWith("/");
        if (isDirectory) directoryPath(name); else validateArchivePath(name);
        const alias = name.toLowerCase().replace(/\/$/, "");
        if (seen.has(alias)) throw new BackupError("ZIP 存在重复或大小写冲突条目");
        seen.add(alias);
        const unixType = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (unixType && unixType !== (isDirectory ? 0x4000 : 0x8000)) throw new BackupError("ZIP 包含链接或特殊文件");
        if (entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)) throw new BackupError("ZIP 加密或压缩方式不支持");
        const header = await zip.readLocalFileHeaderPromise(entry);
        if (!header.fileName.equals(entry.fileNameRaw) || header.generalPurposeBitFlag !== entry.generalPurposeBitFlag || header.compressionMethod !== entry.compressionMethod || (!(entry.generalPurposeBitFlag & 8) && (header.crc32 !== entry.crc32 || header.compressedSize !== entry.compressedSize || header.uncompressedSize !== entry.uncompressedSize))) throw new BackupError("ZIP 本地与中央头部不一致");
        if (isDirectory) { if (entry.uncompressedSize !== 0 || entry.compressedSize !== 0) throw new BackupError("ZIP 目录不能包含文件数据"); continue; }
        const parts = name.split("/");
        if (parts[0] === "courses") courses.add(parts[1]);
        if (parts[2]?.startsWith("source.")) { if (sourceCourses.has(parts[1])) throw new BackupError("ZIP 每门课程最多一个来源文件"); sourceCourses.add(parts[1]); }
        declared += entry.uncompressedSize;
        const limit = archiveFileLimit(name, limits);
        if (files.length >= limits.files || courses.size > limits.courses) throw new BackupError("ZIP 文件或课程数量超限", 413);
        if (entry.uncompressedSize > limit || declared > limits.totalBytes) throw new BackupError("ZIP 声明大小超限", 413);
        const destination = path.join(root, ...parts);
        await backupFileIo.ensureDirectory(path.dirname(destination));
        const output = await backupFileIo.createWriter(destination, limit);
        let stream: Awaited<ReturnType<yauzl.ZipFile["openReadStreamPromise"]>> | undefined;
        let actual = 0; let crc = 0xffffffff; const hash = createHash("sha256");
        try {
          stream = await zip.openReadStreamPromise(entry);
          for await (const chunk of stream) {
            actual += chunk.length; total += chunk.length;
            if (actual > limit || total > limits.totalBytes) throw new BackupError("ZIP 实际解压大小超限", 413);
            crc = updateCrc(crc, chunk); hash.update(chunk);
            await output.write(chunk); // guard precedes every write; never buffer an entire decoded file
          }
          if (actual !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) throw new BackupError("ZIP 大小或 CRC 校验错误");
          await output.finish();
        } finally { stream?.destroy(); await output.abort(); }
        files.push({ path: name, bytes: actual, sha256: hash.digest("hex") });
      }
      if (!files.length) throw new BackupError("ZIP 是空归档，未包含课程文件");
      return files;
    } catch (cause) {
      if (owned) await backupFileIo.removeDirectory(root, owner);
      if (cause instanceof BackupError) throw cause;
      throw new BackupError("ZIP 损坏、文件大小不一致或无法安全解压");
    } finally { zip?.close(); }
  }
}
