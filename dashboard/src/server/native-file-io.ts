import * as childProcess from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { BackupError } from "./backup-error.js";

const blockBytes = 65536;
const frameBytes = 131072;
const budgetMs = 15000;
export interface BoundEntry { name: string; kind: "file" | "directory" | "link"; }
export interface BoundWriter { write(bytes: Uint8Array): Promise<void>; finish(): Promise<void>; abort(): Promise<void>; }
export interface DirectoryOwner { id: string; token: string; newId: string; }
export class NativeIoError extends BackupError {
  constructor(message: string, status = 422, readonly code?: string) { super(message, status); }
}
interface ResponseFrame { ok: boolean; result?: Record<string, unknown>; error?: string; code?: string; status?: number; }

/** All data IO runs inside this worker, while its own ancestor handles are held. */
export class BoundFileIo {
  private child?: childProcess.ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private failed?: Error;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private pending?: { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  private incoming = Buffer.alloc(0);
  private active = 0;
  private tokens = new Set<string>();
  private idleTimer?: ReturnType<typeof setTimeout>;
  private retiring?: Promise<void>;
  get workerPid(): number | undefined { return this.child?.pid; }
  private fail(error: Error) {
    this.failed = error;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = undefined; }
    this.child?.kill();
  }
  private async start() {
    if (this.closed || this.failed) throw this.failed ?? new NativeIoError("文件辅助进程已关闭", 503);
    if (this.retiring) await this.retiring;
    if (this.starting) return this.starting;
    if (process.platform !== "win32") throw new NativeIoError("ZIP 安全文件操作仅支持 Windows", 503);
    const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = fileURLToPath(new URL("./native/windows-file-io.ps1", import.meta.url));
    this.starting = new Promise<void>((resolve, reject) => {
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const child = childProcess.spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { SystemRoot: systemRoot, windir: systemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), PATH: path.join(systemRoot, "System32") } });
      this.child = child;
      child.stderr.resume(); // Never log upstream/bootstrap stderr or its environment.
      child.once("error", () => this.fail(new NativeIoError("Windows 文件辅助进程不可用", 503)));
      child.once("exit", () => { if (!this.retiring && !this.closed) this.fail(new NativeIoError("Windows 文件辅助进程已退出，操作未继续", 503)); });
      child.stdin.on("error", () => this.fail(new NativeIoError("Windows 文件辅助进程管道已关闭", 503)));
      let ready = false;
      const timeout = setTimeout(() => { const error = new NativeIoError("Windows 文件辅助进程启动超时", 503); this.fail(error); reject(error); }, budgetMs);
      const rejectStart = () => { clearTimeout(timeout); if (!ready) reject(this.failed ?? new NativeIoError("Windows 文件辅助进程不可用", 503)); };
      child.once("error", rejectStart); child.once("exit", rejectStart);
      child.stdout.on("data", (data: Buffer) => {
        this.incoming = Buffer.concat([this.incoming, data]);
        while (true) {
          const newline = this.incoming.indexOf(10);
          if (newline < 0) { if (this.incoming.length > frameBytes) this.fail(new NativeIoError("辅助进程输出超限", 503)); break; }
          if (newline > frameBytes) { this.fail(new NativeIoError("辅助进程输出超限", 503)); break; }
          const raw = this.incoming.subarray(0, newline); this.incoming = this.incoming.subarray(newline + 1);
          let frame: ResponseFrame;
          try { frame = JSON.parse(raw.toString("utf8")); } catch { this.fail(new NativeIoError("辅助进程协议无效", 503)); break; }
          if (!ready) {
            if (!frame.ok || frame.result?.protocol !== 1) { this.fail(new NativeIoError("辅助进程能力检查失败", 503)); rejectStart(); break; }
            ready = true; clearTimeout(timeout); resolve(); continue;
          }
          const request = this.pending;
          if (!request) { this.fail(new NativeIoError("辅助进程返回未请求的数据", 503)); break; }
          this.pending = undefined; clearTimeout(request.timer);
          if (frame.ok && frame.result && typeof frame.result === "object") request.resolve(frame.result);
          else request.reject(new NativeIoError(frame.error ?? "安全文件操作失败", frame.status ?? 422, frame.code));
        }
      });
    });
    return this.starting;
  }
  private request(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    const operation = this.queue.then(async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      await this.start();
      if (this.failed || this.closed) throw this.failed ?? new NativeIoError("文件辅助进程已关闭", 503);
      const frame = Buffer.from(JSON.stringify(command) + "\n");
      if (frame.length > frameBytes) throw new NativeIoError("安全文件请求超限", 413);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => this.fail(new NativeIoError("安全文件操作超时，未继续操作", 503)), budgetMs);
        this.pending = { resolve, reject, timer }; this.child!.stdin.write(frame);
      });
    });
    const tracked = operation.then((result) => {
      if (result.token) this.tokens.add(String(result.token));
      if (["closeRead", "closeList", "finishWrite", "abortWrite", "finishState"].includes(String(command.command))) this.tokens.delete(String(command.token));
      return result;
    }).finally(() => {
      // A recoverable ENOENT/EEXIST response must retire just like a successful
      // metadata request. Otherwise the worker watchdog kills a healthy idle
      // helper after 15 seconds and permanently disables later backup requests.
      if (!this.tokens.size && !this.failed && !this.closed) {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.retire(), 2000);
      }
    });
    this.queue = tracked.catch(() => {});
    return tracked;
  }
  private retire() {
    if (this.tokens.size || this.pending || this.closed || this.failed || !this.child || this.retiring) return;
    const child = this.child;
    this.retiring = new Promise<void>((resolve) => {
      child.once("exit", () => { this.child = undefined; this.starting = undefined; this.retiring = undefined; this.incoming = Buffer.alloc(0); resolve(); });
      child.stdin.end();
    });
  }
  async available(): Promise<void> { await this.request({ command: "ping" }); }
  async readFile(filename: string, limit: number): Promise<{ bytes: Uint8Array; identity: string }> {
    const opened = await this.request({ command: "openRead", path: filename, limit });
    const token = String(opened.token); const chunks: Buffer[] = []; let total = 0;
    try {
      while (true) {
        const frame = await this.request({ command: "read", token });
        const chunk = Buffer.from(String(frame.bytes ?? ""), "base64"); total += chunk.length;
        if (chunk.length > blockBytes || total > limit) { this.fail(new NativeIoError("辅助进程读取超限", 413)); throw this.failed; }
        if (!chunk.length) break;
        chunks.push(chunk);
      }
      return { bytes: Buffer.concat(chunks, total), identity: String(opened.identity) };
    } finally { if (!this.failed && !this.closed) await this.request({ command: "closeRead", token }); }
  }
  async listDirectory(directory: string): Promise<{ identity: string; entries: BoundEntry[] }> {
    const opened = await this.request({ command: "openList", path: directory });
    const token = String(opened.token); const entries: BoundEntry[] = [];
    try {
      while (true) {
        const batch = await this.request({ command: "list", token }); entries.push(...batch.entries as BoundEntry[]);
        if (entries.length > 10000) throw new NativeIoError("目录条目数量超限", 413);
        if (batch.done) break;
      }
      return { identity: String(opened.identity), entries: entries.sort((a, b) => a.name.localeCompare(b.name)) };
    } finally { if (!this.failed && !this.closed) await this.request({ command: "closeList", token }); }
  }
  async ensureDirectory(directory: string, exclusiveLeaf = false): Promise<void> { await this.request({ command: "ensure", path: directory, exclusiveLeaf }); }
  async createWriter(filename: string, limit: number): Promise<BoundWriter> {
    if (this.active >= 16) throw new NativeIoError("活动文件数量超限", 413); this.active++;
    let opened: Record<string, unknown>;
    try { opened = await this.request({ command: "openWrite", path: filename, limit }); } catch (error) { this.active--; throw error; }
    const token = String(opened.token); let ended = false; let written = 0;
    let ending: Promise<void> | undefined;
    const end = async (commit: boolean) => {
      if (ended) return;
      if (ending) return ending;
      ending = (async () => {
        try {
          if (this.failed || this.closed) { if (commit) throw this.failed ?? new NativeIoError("文件辅助进程已关闭", 503); return; }
          try { await this.request({ command: commit ? "finishWrite" : "abortWrite", token }); }
          catch (error) {
            if (commit && !this.failed && !this.closed) {
              try { await this.request({ command: "abortWrite", token }); }
              catch { this.fail(new NativeIoError("提交失败且无法释放文件句柄，操作已停止", 503)); }
            } else if (!commit && !this.failed && !this.closed) this.fail(new NativeIoError("无法确认文件句柄已释放，操作已停止", 503));
            throw error;
          }
        } finally { ended = true; this.active--; }
      })();
      return ending;
    };
    return {
      write: async (bytes) => {
        if (ended || ending || this.failed || this.closed) throw this.failed ?? new NativeIoError("文件辅助进程或写入已关闭", 503);
        if (written + bytes.length > limit) throw new NativeIoError("实际写入大小超限", 413);
        for (let offset = 0; offset < bytes.length; offset += blockBytes) {
          const chunk = bytes.subarray(offset, offset + blockBytes);
          await this.request({ command: "write", token, bytes: Buffer.from(chunk).toString("base64") }); written += chunk.length;
        }
      }, finish: () => end(true), abort: () => end(false),
    };
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((resolve) => { const timer = setTimeout(() => { this.child?.kill(); resolve(); }, 1000); this.child!.once("exit", () => { clearTimeout(timer); resolve(); }); this.child!.stdin.end(); });
  }
  async moveDirectory(source: string, destination: string, owner: DirectoryOwner): Promise<void> { await this.request({ command: "moveDirectory", path: source, destination, owner }); }
  async removeDirectory(directory: string, owner: DirectoryOwner): Promise<void> { await this.request({ command: "removeDirectory", path: directory, owner }); }
  async createOwnedDirectory(directory: string, owner: DirectoryOwner): Promise<void> { await this.request({ command: "ownedDirectory", path: directory, owner }); }
  async replaceStateFile(filename: string, bytes: Uint8Array): Promise<void> {
    if (bytes.length > 2097152) throw new NativeIoError("状态文件大小超限", 413);
    const opened = await this.request({ command: "openState", path: filename, limit: bytes.length });
    const token = String(opened.token);
    try {
      for (let offset = 0; offset < bytes.length; offset += blockBytes) await this.request({ command: "write", token, bytes: Buffer.from(bytes.subarray(offset, offset + blockBytes)).toString("base64") });
      await this.request({ command: "finishState", token });
    } catch (error) { if (!this.failed && !this.closed) await this.request({ command: "abortWrite", token }).catch(() => {}); throw error; }
  }
}

// One worker per server process, reused for adjacent files; idle workers retire.
export const backupFileIo = new BoundFileIo();
