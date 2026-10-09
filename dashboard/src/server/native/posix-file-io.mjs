// POSIX 原生安全文件操作辅助进程（macOS / Linux）。
// 与 windows-file-io.ps1 + windows-file-io.cs 使用完全相同的帧协议：
// stdin/stdout 每行一个 JSON 对象，首帧是能力握手 {ok:true,result:{protocol:1}}。
//
// 安全模型与 Windows 版等价，逐条对应：
//   1. 只接受安全的本地绝对路径，拒绝空路径、NUL、空名称与超长路径；长度、帧大小与
//      上限取值范围与 Windows 版一致。
//   2. 从根目录开始逐级打开祖先目录，每一级都用 O_NOFOLLOW 打开并立即用 lstat
//      交叉核对 dev/inode；路径被替换或出现符号链接就失败关闭，不做任何降级。
//   3. 拿到目录句柄后，所有后续操作都通过“锚点”寻址，而不是重新解析原路径：
//        macOS: /.vol/<dev>/<inode>
//        Linux: /proc/self/fd/<fd>
//      锚点由内核按对象标识解析，因此被改名、被替换或被链接接管的路径都无法把操作
//      引到别处：等价于 Windows 版持有的目录句柄。
//   4. 叶子文件用 O_NOFOLLOW 打开，必须是普通文件且 nlink === 1，拒绝硬链接别名；
//      读取与写入只经过已打开的 fd。
//   5. 写入先占用目标名（O_CREAT|O_EXCL，等价 CREATE_NEW），数据写入同目录下的随机
//      临时文件，提交时原子改名覆盖自己占用的空文件；取消、辅助进程退出或收到终止
//      信号都会删除未提交的临时文件与占用文件。
//   6. 目录发布与清理同样只通过锚点操作：发布前校验所有权标记，清理时先完整校验整棵
//      树，再自底向上删除。
//
// 能力探测：启动时先验证锚点在此文件系统上真实可用（根目录 + 临时目录上的建、写、fsync、
// 读、改名、枚举、删除），任何一步失败都不发送握手帧并直接退出；调用方据此停用 ZIP 功能，
// 普通课程、文档导入与 AI 功能不受影响。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

const Block = 65536;
const Frame = 131072;
const MaxLeases = 16;
const CleanupEntries = 4400;
const MaxDepth = 8;
const ListBatch = 128;
const IdleMs = 15000;
const StateLimit = 2097152;
const MaxFileLimit = 104857600;
const MaxPathLength = 1000;
const MarkerName = ".learning-loop-restore.json";
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_DIRECTORY } = fs.constants;

class Failure extends Error {
  constructor(message, status = 422, code = "EIO") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const unsupported = () => new Failure("ZIP 安全文件操作暂不支持此平台", 503, "EINVAL");
const linkRefused = (message = "拒绝链接或符号链接：安全文件操作不接受链接路径") => new Failure(message, 422, "EINVAL");
const hardLinkRefused = () => new Failure("拒绝多重硬链接文件", 422, "EINVAL");
const wrongKind = () => new Failure("不是预期的普通文件或目录", 422, "EINVAL");
const unsafeHandle = () => new Failure("文件句柄路径不安全", 422, "EINVAL");

/** 把 Node 的 errno 映射成与 Windows 版一致的 code/status，供上层识别。 */
function mapped(error, label) {
  const code = error && typeof error === "object" ? error.code : undefined;
  if (code === "ENOENT") return new Failure(`${label} 不存在`, 422, "ENOENT");
  if (code === "EEXIST") return new Failure(`${label} 已存在`, 422, "EEXIST");
  if (code === "ELOOP") return linkRefused();
  if (code === "ENOTDIR") return wrongKind();
  if (code === "ENOTEMPTY" || code === "EBUSY") return new Failure("目录非空或正被占用", 422, "EBUSY");
  if (code === "EACCES" || code === "EPERM") return new Failure("安全文件操作被系统拒绝", 422, "EACCES");
  if (code === "EMFILE" || code === "ENFILE") return new Failure("活动文件数量超限", 413, "EMFILE");
  if (code === "EINVAL") return new Failure("安全文件参数无效", 422, "EINVAL");
  if (code === "ENOSPC") return new Failure("磁盘空间不足", 413, "EFBIG");
  return new Failure("POSIX 安全文件操作失败", 422, "EIO");
}

const anchorMode = process.platform === "darwin" ? "vol" : process.platform === "linux" ? "proc" : "unsupported";

/** 由已打开的目录 fd 求出锚点路径：内核按对象标识（而非名称）解析。 */
function anchorFor(fd, stat) {
  if (anchorMode === "vol") return `/.vol/${stat.dev}/${stat.ino}`;
  if (anchorMode === "proc") return `/proc/self/fd/${fd}`;
  throw unsupported();
}

function openDirectoryHandle(reference, realPath) {
  let fd;
  try {
    fd = fs.openSync(reference, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (error) {
    // macOS 对“O_DIRECTORY + 符号链接”返回 ENOTDIR 而不是 ELOOP；补一次 lstat 以区分
    // “链接被拒绝”和“确实是普通文件”，保持与 Windows 版一致的提示与失败语义。
    if (error.code === "ENOTDIR" || error.code === "ELOOP") {
      let symbolic = false;
      try {
        symbolic = fs.lstatSync(reference, { bigint: true }).isSymbolicLink();
      } catch {
        symbolic = error.code === "ELOOP";
      }
      if (symbolic) throw linkRefused();
    }
    throw mapped(error, realPath);
  }
  let stat;
  try {
    stat = fs.fstatSync(fd, { bigint: true });
  } catch (error) {
    fs.closeSync(fd);
    throw mapped(error, realPath);
  }
  if (!stat.isDirectory()) {
    fs.closeSync(fd);
    throw wrongKind();
  }
  return { fd, stat, realPath, anchor: anchorFor(fd, stat) };
}

function closeHandle(handle) {
  if (!handle) return;
  try {
    fs.closeSync(handle.fd);
  } catch {
    /* 句柄已关闭或辅助进程正在退出 */
  }
}

function closeChain(chain) {
  for (let index = chain.length - 1; index >= 0; index -= 1) closeHandle(chain[index]);
}

/** 与 Windows 的 GetFinalPathNameByHandle 核对等价：句柄必须仍对应请求路径。 */
function verifyIdentity(handle) {
  let stat;
  try {
    stat = fs.lstatSync(handle.realPath, { bigint: true });
  } catch (error) {
    throw mapped(error, handle.realPath);
  }
  if (stat.isSymbolicLink() || stat.dev !== handle.stat.dev || stat.ino !== handle.stat.ino) throw unsafeHandle();
}

function normalize(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MaxPathLength) throw new Failure("仅支持安全的本地绝对路径", 422, "EINVAL");
  if (value.includes("\0") || !path.isAbsolute(value)) throw new Failure("仅支持安全的本地绝对路径", 422, "EINVAL");
  const full = path.resolve(value);
  const name = path.basename(full);
  if (!name || name === "." || name === "..") throw new Failure("无效单级名称", 422, "EINVAL");
  return full;
}

/**
 * 逐级绑定祖先目录。每一级都相对上一级的锚点打开，因此解析过程不接受路径替换。
 * `includeLeaf` 为真时连最后一级一起打开（用于枚举与建目录）。
 */
function bindChain(full, options = {}) {
  const { create = false, exclusiveLeaf = false, includeLeaf = false } = options;
  const parts = full.split(path.sep).filter((part) => part.length > 0);
  const keep = includeLeaf ? parts.length : parts.length - 1;
  const chain = [];
  try {
    const root = openDirectoryHandle("/", "/");
    verifyIdentity(root);
    chain.push(root);
    for (let index = 0; index < keep; index += 1) {
      const parent = chain[chain.length - 1];
      const name = parts[index];
      const childPath = path.join(parent.realPath, name);
      const reference = path.join(parent.anchor, name);
      let next;
      if (create && exclusiveLeaf && index === keep - 1) {
        try {
          fs.mkdirSync(reference, { mode: 0o700 });
        } catch (error) {
          throw mapped(error, childPath);
        }
        next = openDirectoryHandle(reference, childPath);
      } else {
        try {
          next = openDirectoryHandle(reference, childPath);
        } catch (error) {
          if (!create || error.code !== "ENOENT") throw error;
          try {
            fs.mkdirSync(reference, { mode: 0o700 });
          } catch (mkdirError) {
            if (mkdirError.code !== "EEXIST") throw mapped(mkdirError, childPath);
          }
          next = openDirectoryHandle(reference, childPath);
        }
      }
      verifyIdentity(next);
      chain.push(next);
    }
    return chain;
  } catch (error) {
    closeChain(chain);
    throw error;
  }
}

/** 打开叶子文件：拒绝符号链接与硬链接，并核对句柄仍对应请求路径。 */
function openLeaf(full, chain, flags) {
  const parent = chain[chain.length - 1];
  const reference = path.join(parent.anchor, path.basename(full));
  let fd;
  try {
    fd = fs.openSync(reference, flags, 0o600);
  } catch (error) {
    throw mapped(error, full);
  }
  let stat;
  try {
    stat = fs.fstatSync(fd, { bigint: true });
  } catch (error) {
    fs.closeSync(fd);
    throw mapped(error, full);
  }
  if (!stat.isFile()) {
    fs.closeSync(fd);
    throw wrongKind();
  }
  if (stat.nlink !== 1n) {
    fs.closeSync(fd);
    throw hardLinkRefused();
  }
  let viaPath;
  try {
    viaPath = fs.lstatSync(full, { bigint: true });
  } catch (error) {
    fs.closeSync(fd);
    throw mapped(error, full);
  }
  if (viaPath.isSymbolicLink() || viaPath.dev !== stat.dev || viaPath.ino !== stat.ino) {
    fs.closeSync(fd);
    throw unsafeHandle();
  }
  return { fd, stat };
}

function identityOf(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
}

function limitOf(request) {
  if (typeof request.limit !== "number" || !Number.isSafeInteger(request.limit)) throw new Failure("缺少文件上限", 422, "EINVAL");
  if (request.limit < 0 || request.limit > MaxFileLimit) throw new Failure("文件上限无效", 413, "EFBIG");
  return request.limit;
}

function storedName(full, chain) {
  return path.join(chain[chain.length - 1].anchor, path.basename(full));
}

function exists(reference) {
  try {
    fs.lstatSync(reference);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw mapped(error, reference);
  }
}

const leases = new Map();

class Lease {
  constructor(kind) {
    this.kind = kind;
    this.chain = [];
    this.fd = undefined;
    this.count = 0;
    this.limit = 0;
    this.temporary = [];
    this.claimed = undefined;
  }

  /** 取消写入：删除临时文件与自己占用的空目标，绝不删除别人的文件。 */
  discard() {
    for (const reference of this.temporary) {
      try {
        fs.unlinkSync(reference);
      } catch {
        /* 已删除或辅助进程正在退出 */
      }
    }
    this.temporary = [];
    if (this.claimed) {
      const { reference, stat } = this.claimed;
      try {
        const current = fs.lstatSync(reference, { bigint: true });
        if (!current.isSymbolicLink() && current.dev === stat.dev && current.ino === stat.ino) fs.unlinkSync(reference);
      } catch {
        /* 目标已被替换或删除，保持原样 */
      }
      this.claimed = undefined;
    }
  }

  release(discardWrite = true) {
    if (this.fd !== undefined) {
      const fd = this.fd;
      this.fd = undefined;
      try {
        fs.closeSync(fd);
      } catch {
        /* 已关闭 */
      }
    }
    if (this.kind === "write" && discardWrite) this.discard();
    for (const handle of this.chain) closeHandle(handle);
    this.chain = [];
    closeHandle(this.directory);
    this.directory = undefined;
  }
}

function addLease(lease) {
  if (leases.size >= MaxLeases) {
    lease.release();
    throw new Failure("活动文件数量超限", 413, "EMFILE");
  }
  const token = randomUUID().replace(/-/g, "");
  leases.set(token, lease);
  return token;
}

function leaseOf(request) {
  if (typeof request.token !== "string" || !leases.has(request.token)) throw new Failure("文件句柄已关闭", 422, "EBADF");
  return leases.get(request.token);
}

function closeLease(request, discardWrite) {
  const lease = leaseOf(request);
  leases.delete(request.token);
  lease.release(discardWrite);
}

function verifyOwner(directoryHandle, request) {
  const owner = request.owner;
  if (!owner || typeof owner !== "object") throw new Failure("恢复目录所有权缺失", 422, "EINVAL");
  let raw;
  try {
    const opened = openLeaf(path.join(directoryHandle.realPath, MarkerName), [directoryHandle], O_RDONLY | O_NOFOLLOW);
    try {
      if (opened.stat.size > 1000n) throw new Failure("恢复目录所有权无效", 422, "EINVAL");
      raw = fs.readFileSync(opened.fd, "utf8");
    } finally {
      fs.closeSync(opened.fd);
    }
  } catch (error) {
    if (error instanceof Failure && error.code === "ENOENT") throw new Failure("恢复目录所有权缺失", 422, "EINVAL");
    throw error;
  }
  let actual;
  try {
    actual = JSON.parse(raw);
  } catch {
    throw new Failure("恢复目录所有权无效", 422, "EINVAL");
  }
  for (const key of ["id", "token", "newId"]) {
    if (!actual || typeof actual[key] !== "string" || actual[key] !== owner[key]) throw new Failure("恢复目录所有权校验失败", 422, "EINVAL");
  }
}

/** 校验整棵清理树；任何链接、非普通文件或超限都直接失败，不会删除任何内容。 */
function collectTree(handle, depth, collected) {
  if (depth > MaxDepth) throw new Failure("清理目录结构超限", 413, "EFBIG");
  let names;
  try {
    names = fs.readdirSync(handle.anchor);
  } catch (error) {
    throw mapped(error, handle.realPath);
  }
  for (const name of names) {
    if (collected.length >= CleanupEntries) throw new Failure("清理目录条目超限", 413, "EFBIG");
    const reference = path.join(handle.anchor, name);
    const childPath = path.join(handle.realPath, name);
    let stat;
    try {
      stat = fs.lstatSync(reference, { bigint: true });
    } catch (error) {
      throw mapped(error, childPath);
    }
    if (stat.isSymbolicLink()) throw linkRefused("拒绝链接或符号链接：清理目录包含链接");
    if (stat.isDirectory()) {
      const child = openDirectoryHandle(reference, childPath);
      try {
        collected.push({ reference, kind: "directory" });
        collectTree(child, depth + 1, collected);
      } finally {
        closeHandle(child);
      }
    } else if (stat.isFile()) {
      if (stat.nlink !== 1n) throw hardLinkRefused();
      collected.push({ reference, kind: "file" });
    } else throw wrongKind();
  }
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Failure("写入未完成", 422, "EIO");
    offset += written;
  }
}

/**
 * 能力探测：用真实操作验证锚点可用。任何一步失败都不发送握手帧。
 * 这样“按对象标识寻址”不被支持的文件系统会明确停用 ZIP，而不是退化成普通路径读写。
 */
function capabilityProbe() {
  if (anchorMode === "unsupported") throw unsupported();
  const root = openDirectoryHandle("/", "/");
  try {
    if (!fs.lstatSync(root.anchor, { bigint: true }).isDirectory()) throw unsupported();
  } catch {
    throw new Failure("ZIP 安全文件操作不可用：此文件系统不支持按对象标识寻址", 503, "EINVAL");
  } finally {
    closeHandle(root);
  }
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const directory = path.join(temporaryRoot, `.learning-loop-capability-${randomUUID()}`);
  try {
    const chain = bindChain(directory, { create: true, exclusiveLeaf: true, includeLeaf: true });
    try {
      const handle = chain[chain.length - 1];
      const file = path.join(handle.anchor, "probe");
      const renamed = path.join(handle.anchor, "renamed");
      const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
      writeAll(fd, Buffer.from("probe", "utf8"));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      if (fs.readFileSync(file, "utf8") !== "probe") throw new Failure("ZIP 安全文件操作不可用：锚点读写结果不一致", 503, "EINVAL");
      fs.renameSync(file, renamed);
      if (!fs.readdirSync(handle.anchor).includes("renamed")) throw new Failure("ZIP 安全文件操作不可用：锚点枚举结果不一致", 503, "EINVAL");
      fs.unlinkSync(renamed);
    } finally {
      closeChain(chain);
    }
    fs.rmdirSync(path.join(temporaryRoot, path.basename(directory)));
  } catch (error) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      /* 探测目录清理失败不影响结论 */
    }
    if (error instanceof Failure) throw error;
    throw new Failure("ZIP 安全文件操作不可用：辅助进程能力探测失败", 503, "EINVAL");
  }
}

function execute(request) {
  if (typeof request !== "object" || request === null || typeof request.command !== "string") throw new Failure("不支持的固定文件命令", 422, "EINVAL");
  const command = request.command;
  if (command === "ping") return { protocol: 1 };

  if (command === "ensure") {
    const full = normalize(request.path);
    const chain = bindChain(full, { create: true, exclusiveLeaf: request.exclusiveLeaf === true, includeLeaf: true });
    closeChain(chain);
    return {};
  }

  if (command === "ownedDirectory") {
    const full = normalize(request.path);
    const owner = request.owner;
    if (!owner || typeof owner !== "object") throw new Failure("缺少目录所有权", 422, "EINVAL");
    const bytes = Buffer.from(JSON.stringify(owner), "utf8");
    if (bytes.length > 1000) throw new Failure("目录所有权超限", 413, "EFBIG");
    let chain = [];
    let directoryHandle;
    let marker;
    try {
      chain = bindChain(full, {});
      try {
        fs.mkdirSync(storedName(full, chain), { mode: 0o700 });
      } catch (error) {
        throw mapped(error, full);
      }
      directoryHandle = openDirectoryHandle(storedName(full, chain), full);
      verifyIdentity(directoryHandle);
      try {
        marker = fs.openSync(path.join(directoryHandle.anchor, MarkerName), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
      } catch (error) {
        throw mapped(error, path.join(full, MarkerName));
      }
      writeAll(marker, bytes);
      fs.fsyncSync(marker);
    } finally {
      if (marker !== undefined) {
        try {
          fs.closeSync(marker);
        } catch {
          /* 已关闭 */
        }
      }
      closeHandle(directoryHandle);
      closeChain(chain);
    }
    return {};
  }

  if (command === "moveDirectory") {
    const source = normalize(request.path);
    const destination = normalize(request.destination);
    const sourceChain = bindChain(source, {});
    let destinationChain = [];
    let directoryHandle;
    try {
      destinationChain = bindChain(destination, {});
      directoryHandle = openDirectoryHandle(storedName(source, sourceChain), source);
      verifyIdentity(directoryHandle);
      verifyOwner(directoryHandle, request);
      const target = storedName(destination, destinationChain);
      // 与 Windows 版 ReplaceIfExists=0 一致：目标已存在时不覆盖。
      if (exists(target)) throw new Failure("恢复目标已存在，不会覆盖", 422, "EEXIST");
      try {
        fs.renameSync(storedName(source, sourceChain), target);
      } catch (error) {
        throw mapped(error, destination);
      }
    } finally {
      closeHandle(directoryHandle);
      closeChain(destinationChain);
      closeChain(sourceChain);
    }
    return {};
  }

  if (command === "removeDirectory") {
    const full = normalize(request.path);
    const chain = bindChain(full, {});
    let directoryHandle;
    try {
      directoryHandle = openDirectoryHandle(storedName(full, chain), full);
      verifyIdentity(directoryHandle);
      verifyOwner(directoryHandle, request);
      const collected = [];
      collectTree(directoryHandle, 0, collected);
      // 完整校验通过后才开始删除，自底向上，全部通过锚点寻址。
      for (let index = collected.length - 1; index >= 0; index -= 1) {
        const entry = collected[index];
        try {
          if (entry.kind === "directory") fs.rmdirSync(entry.reference);
          else fs.unlinkSync(entry.reference);
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw mapped(error, entry.reference);
        }
      }
      try {
        fs.rmdirSync(storedName(full, chain));
      } catch (error) {
        if (error.code === "ENOENT") return {};
        throw mapped(error, full);
      }
    } finally {
      closeHandle(directoryHandle);
      closeChain(chain);
    }
    return {};
  }

  if (command === "openRead" || command === "openWrite" || command === "openState") {
    const full = normalize(request.path);
    const limit = limitOf(request);
    const lease = new Lease(command === "openWrite" || command === "openState" ? "write" : "read");
    lease.limit = limit;
    try {
      lease.chain = bindChain(full, {});
      if (command === "openRead") {
        const opened = openLeaf(full, lease.chain, O_RDONLY | O_NOFOLLOW);
        lease.fd = opened.fd;
        lease.identity = identityOf(opened.stat);
        if (opened.stat.size > BigInt(limit)) throw new Failure("文件大小超限", 413, "EFBIG");
        return { token: addLease(lease), identity: lease.identity };
      }
      if (command === "openState") {
        if (limit > StateLimit) throw new Failure("状态文件大小超限", 413, "EFBIG");
        try {
          const existing = openLeaf(full, lease.chain, O_RDONLY | O_NOFOLLOW);
          fs.closeSync(existing.fd);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const temporary = path.join(lease.chain[lease.chain.length - 1].anchor, `${randomUUID()}.tmp`);
        lease.fd = fs.openSync(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
        lease.temporary = [temporary];
        lease.target = storedName(full, lease.chain);
        lease.identity = identityOf(fs.fstatSync(lease.fd, { bigint: true }));
        return { token: addLease(lease), identity: lease.identity };
      }
      // openWrite：目标必须不存在（等价 CREATE_NEW）。先原子占用名字，再写临时文件，
      // 提交时用原子改名覆盖自己占用的空文件，因此任何时刻都不会出现半截目标文件。
      const target = storedName(full, lease.chain);
      let claim;
      try {
        claim = fs.openSync(target, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
      } catch (error) {
        throw mapped(error, full);
      }
      const claimStat = fs.fstatSync(claim, { bigint: true });
      fs.closeSync(claim);
      if (!claimStat.isFile() || claimStat.nlink !== 1n) throw hardLinkRefused();
      lease.claimed = { reference: target, stat: claimStat };
      const temporary = path.join(lease.chain[lease.chain.length - 1].anchor, `${randomUUID()}.tmp`);
      try {
        lease.fd = fs.openSync(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
      } catch (error) {
        lease.discard();
        throw mapped(error, full);
      }
      lease.temporary = [temporary];
      lease.target = target;
      lease.identity = identityOf(claimStat);
      return { token: addLease(lease), identity: lease.identity };
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  if (command === "read") {
    const lease = leaseOf(request);
    if (lease.kind !== "read" || lease.fd === undefined) throw new Failure("读取句柄无效", 422, "EBADF");
    const buffer = Buffer.alloc(Block);
    let count;
    try {
      count = fs.readSync(lease.fd, buffer, 0, Block, null);
    } catch (error) {
      throw mapped(error, "读取");
    }
    lease.count += count;
    if (lease.count > lease.limit) throw new Failure("实际读取超限", 413, "EFBIG");
    return { bytes: buffer.subarray(0, count).toString("base64") };
  }

  if (command === "write") {
    const lease = leaseOf(request);
    if (lease.kind !== "write" || lease.fd === undefined) throw new Failure("写入句柄无效", 422, "EBADF");
    if (typeof request.bytes !== "string") throw new Failure("无效请求字段", 422, "EINVAL");
    const bytes = Buffer.from(request.bytes, "base64");
    if (bytes.length > Block || bytes.length > lease.limit - lease.count) throw new Failure("实际写入超限", 413, "EFBIG");
    try {
      writeAll(lease.fd, bytes);
    } catch (error) {
      throw mapped(error, "写入");
    }
    lease.count += bytes.length;
    return {};
  }

  if (command === "finishWrite" || command === "finishState") {
    const lease = leaseOf(request);
    if (lease.kind !== "write" || lease.fd === undefined) throw new Failure("写入句柄无效", 422, "EBADF");
    try {
      fs.fsyncSync(lease.fd);
    } catch (error) {
      throw mapped(error, "提交");
    }
    const [temporary] = lease.temporary;
    const target = lease.target;
    if (!temporary || !target) throw new Failure("状态句柄无效", 422, "EBADF");
    if (command === "finishWrite") {
      // 目标仍必须是自己占用的那个空文件，避免覆盖在此期间被替换的目标。
      try {
        const current = fs.lstatSync(target, { bigint: true });
        if (current.isSymbolicLink() || !lease.claimed || current.dev !== lease.claimed.stat.dev || current.ino !== lease.claimed.stat.ino) {
          throw new Failure("写入目标已被替换，拒绝提交", 422, "EEXIST");
        }
      } catch (error) {
        if (error instanceof Failure) throw error;
        throw mapped(error, target);
      }
    }
    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      throw mapped(error, target);
    }
    lease.temporary = [];
    lease.claimed = undefined;
    closeLease(request, false);
    return {};
  }

  if (command === "abortWrite" || command === "closeRead" || command === "closeList") {
    closeLease(request, true);
    return {};
  }

  if (command === "openList") {
    const full = normalize(request.path);
    const lease = new Lease("list");
    try {
      lease.chain = bindChain(full, { includeLeaf: true });
      const handle = lease.chain[lease.chain.length - 1];
      verifyIdentity(handle);
      lease.identity = identityOf(handle.stat);
      lease.entries = fs.readdirSync(handle.anchor).map((name) => ({ name, reference: path.join(handle.anchor, name) }));
      lease.cursor = 0;
      return { token: addLease(lease), identity: lease.identity };
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  if (command === "list") {
    const lease = leaseOf(request);
    if (lease.kind !== "list" || !lease.entries) throw new Failure("枚举句柄无效", 422, "EBADF");
    const entries = [];
    let done = false;
    for (let index = 0; index < ListBatch; index += 1) {
      if (lease.cursor >= lease.entries.length) {
        done = true;
        break;
      }
      const entry = lease.entries[lease.cursor];
      lease.cursor += 1;
      let stat;
      try {
        stat = fs.lstatSync(entry.reference, { bigint: true });
      } catch (error) {
        throw mapped(error, entry.reference);
      }
      const kind = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "file";
      entries.push({ name: entry.name, kind });
    }
    return { entries, done };
  }

  throw new Failure("不支持的固定文件命令", 422, "EINVAL");
}

function cleanupLeases() {
  for (const lease of leases.values()) lease.release();
  leases.clear();
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    cleanupLeases();
  } catch {
    /* 退出路径不再抛出 */
  }
  process.exit(code);
}

function output(value) {
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw, "utf8") > Frame) throw new Failure("响应帧超限", 413, "EFBIG");
  process.stdout.write(`${raw}\n`);
}

let lastActivity = Date.now();
const watchdog = setInterval(() => {
  if (Date.now() - lastActivity > IdleMs) shutdown(2);
}, 1000);
watchdog.unref();

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("exit", () => {
  try {
    cleanupLeases();
  } catch {
    /* 退出路径不再抛出 */
  }
});

try {
  capabilityProbe();
} catch (error) {
  // 先回一帧失败握手：调用方据此停用 ZIP，并能把具体原因显示给使用者；
  // stderr 只留给本机排查，不进入上层日志。
  const failure = error instanceof Failure ? error : new Failure("ZIP 安全文件操作不可用：辅助进程能力探测失败", 503, "EINVAL");
  process.stderr.write(`学习闭环 POSIX 文件辅助进程不可用：${failure.message}\n`);
  try {
    output({ ok: false, error: failure.message, code: failure.code, status: failure.status });
  } catch {
    /* 输出失败时只保留退出码 */
  }
  process.exit(3);
}

output({ ok: true, result: { protocol: 1 } });

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  lastActivity = Date.now();
  if (Buffer.byteLength(line, "utf8") > Frame) {
    output({ ok: false, error: "请求帧超限", code: "EFBIG", status: 413 });
    return;
  }
  try {
    const request = JSON.parse(line);
    output({ ok: true, result: execute(request) });
  } catch (error) {
    if (error instanceof Failure) output({ ok: false, error: error.message, code: error.code, status: error.status });
    else output({ ok: false, error: "POSIX 安全文件操作失败", code: "EIO", status: 422 });
  }
  lastActivity = Date.now();
});
lines.on("close", () => shutdown(0));
