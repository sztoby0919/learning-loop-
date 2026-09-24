// 文件操作工具
// 提供原子写入、哈希检查、冲突检测

import { createHash } from "node:crypto";
import { readFile, writeFile, rename, stat } from "node:fs/promises";
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
  operations: Array<{ filePath: string; content: string; expectedHash?: string }>,
): Promise<FileOperationResult> {
  const results: Array<{ filePath: string; hash?: string; success: boolean }> = [];

  for (const op of operations) {
    // 如果提供了预期哈希，先检查冲突
    if (op.expectedHash) {
      const hasConflict = await checkFileConflict(op.filePath, op.expectedHash);
      if (hasConflict) {
        return {
          success: false,
          conflict: true,
          error: `文件冲突：${op.filePath} 已被外部修改`,
        };
      }
    }

    const result = await atomicWriteFile(op.filePath, op.content);
    if (!result.success) {
      return result;
    }
    results.push({ filePath: op.filePath, hash: result.hash, success: true });
  }

  return {
    success: true,
    hash: results.map((r) => r.hash).join(","),
  };
}
