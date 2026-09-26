// 文件操作工具
// 提供原子写入、哈希检查、冲突检测

import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface FileOperationResult {
  success: boolean;
  error?: string;
  conflict?: boolean;
  hash?: string;
}

// 计算文件内容的 SHA-256 哈希
export async function computeFileHash(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

// 原子写入：先写入临时文件，再重命名
export async function atomicWriteFile(
  filePath: string,
  content: string,
): Promise<FileOperationResult> {
  const tempPath = `${filePath}.tmp-${Date.now()}`;
  try {
    // 写入临时文件
    await writeFile(tempPath, content, "utf8");
    // 原子重命名
    await rename(tempPath, filePath);
    const hash = await computeFileHash(filePath);
    return { success: true, hash };
  } catch (error) {
    // 清理临时文件
    try {
      await rename(tempPath, `${tempPath}.failed`);
    } catch {
      // 忽略清理错误
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// 检查文件是否被外部修改
export async function checkFileConflict(
  filePath: string,
  expectedHash: string,
): Promise<boolean> {
  try {
    const currentHash = await computeFileHash(filePath);
    return currentHash !== expectedHash;
  } catch {
    return true; // 文件不存在视为冲突
  }
}

// 安全读取文件（带错误处理）
export async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

// 批量原子写入（带冲突检测）
export async function batchAtomicWrite(
  operations: Array<{ filePath: string; content: string; expectedHash?: string | null }>,
): Promise<FileOperationResult> {
  const staged: Array<{ target: string; temp: string; backup: string; existed: boolean }> = [];
  const committed: typeof staged = [];
  const token = randomUUID();
  try {
    for (const op of operations) {
      const existing = await safeReadFile(op.filePath);
      const currentHash = existing === null ? null : createHash("sha256").update(existing).digest("hex");
      if (op.expectedHash !== undefined && currentHash !== op.expectedHash) {
        return { success: false, conflict: true, error: `文件冲突：${op.filePath} 已被外部修改` };
      }
    }
    for (const op of operations) {
      await mkdir(path.dirname(op.filePath), { recursive: true });
      const entry = { target: op.filePath, temp: `${op.filePath}.${token}.tmp`, backup: `${op.filePath}.${token}.bak`, existed: (await safeReadFile(op.filePath)) !== null };
      await writeFile(entry.temp, op.content, "utf8");
      staged.push(entry);
    }
    for (const op of operations) {
      if (op.expectedHash !== undefined) {
        const existing = await safeReadFile(op.filePath);
        const currentHash = existing === null ? null : createHash("sha256").update(existing).digest("hex");
        if (currentHash !== op.expectedHash) throw new Error(`文件冲突：${op.filePath} 已被外部修改`);
      }
    }
    for (const entry of staged) {
      if (entry.existed) await copyFile(entry.target, entry.backup);
      await rename(entry.temp, entry.target);
      committed.push(entry);
    }
    return { success: true, hash: createHash("sha256").update(operations.map((op) => op.content).join("\0")).digest("hex") };
  } catch (error) {
    for (const entry of committed.reverse()) {
      if (entry.existed) await copyFile(entry.backup, entry.target).catch(() => {});
      else await rm(entry.target, { force: true }).catch(() => {});
    }
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, conflict: message.startsWith("文件冲突："), error: message };
  } finally {
    for (const entry of staged) {
      await rm(entry.temp, { force: true }).catch(() => {});
      await rm(entry.backup, { force: true }).catch(() => {});
    }
  }
}
