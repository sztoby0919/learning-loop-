export interface BackupManifest {
  format: "learning-loop-backup";
  version: 1;
  exportedAt: string;
  courses: Array<{ id: string; title: string; sourceIncluded: boolean; warnings: string[]; files: Array<{ path: string; bytes: number; sha256: string }> }>;
}
export interface BackupEntry { path: string; bytes: Uint8Array }
export interface BackupLimits { compressedBytes: number; totalBytes: number; files: number; courses: number; markdownBytes: number; manifestBytes: number; sourceBytes: Record<string, number> }
export const BACKUP_LIMITS: BackupLimits = { compressedBytes: 250 * 1048576, totalBytes: 500 * 1048576, files: 2000, courses: 50, markdownBytes: 10 * 1048576, manifestBytes: 2 * 1048576, sourceBytes: { pdf: 100 * 1048576, docx: 50 * 1048576, html: 20 * 1048576, htm: 20 * 1048576, md: 10 * 1048576, markdown: 10 * 1048576, txt: 10 * 1048576 } };
export interface DecodedBackupFile { path: string; bytes: number; sha256: string }
export interface BackupDirectoryOwner { id: string; token: string; newId: string }
export interface ZipCodec { encode(entries: AsyncIterable<BackupEntry>): Promise<Uint8Array>; decodeToDirectory(bytes: Uint8Array, root: string, limits?: BackupLimits, owner?: BackupDirectoryOwner): Promise<DecodedBackupFile[]> }
export interface RestorePreview { id: string; expiresAt: number; courses: Array<{ originalId: string; newId: string; title: string; fileCount: number; sourceIncluded: boolean; warnings: string[] }> }
