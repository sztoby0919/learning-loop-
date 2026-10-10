import multer from "multer";
import type { Request } from "express";
import { BUNDLE_LIMITS } from "../shared/course-bundle.js";
import { CourseImportError } from "./course-import-manager.js";
/** Bounds the cumulative bytes even for chunked multipart requests. */
export function bundleUpload() {
  const totals = new WeakMap<Request, number>();
  const storage: multer.StorageEngine = {
    _handleFile(request, file, callback) {
      void (async () => {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of file.stream) {
          const bytes = Buffer.from(chunk); size += bytes.length;
          const total = (totals.get(request) ?? 0) + bytes.length; totals.set(request, total);
          if (total > BUNDLE_LIMITS.totalBytes) throw new CourseImportError("整批文件超过 200 MB，请分批追加", 413);
          chunks.push(bytes);
        }
        callback(null, { buffer: Buffer.concat(chunks, size), size });
      })().catch((error) => callback(error));
    },
    _removeFile(_request, file, callback) { delete (file as Partial<Express.Multer.File>).buffer; callback(null); },
  };
  return multer({ storage, limits: { fileSize: 100 * 1048576, files: 10, fields: 1, parts: 11 }, fileFilter: (_request, file, callback) => {
    if (!/\.(pdf|docx|md|txt|markdown|html|htm)$/i.test(file.originalname)) callback(new CourseImportError("批次包含不支持的文件", 400));
    else callback(null, true);
  } }).array("files", BUNDLE_LIMITS.files);
}
