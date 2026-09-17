// Kernel ownership lives on a stable file, never on the disposable PID marker.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const entered = new Set();
let backend;

function nativeError(operation, number) {
  const error = new Error(`Kernel lock ${operation} failed on ${process.platform}/${process.arch} (native error ${number}).`);
  error.code = "BRIDGE_LOCK_FAILED";
  error.nativeCode = number;
  error.expected = true;
  error.operation = `kernel-lock:${operation}`;
  error.nextCommand = "bridge doctor --json";
  return error;
}

function lockBackend() {
  if (backend) return backend;
  try { return loadBackend(); }
  catch (cause) {
    const error = new Error(`Native locking is unavailable on ${process.platform}/${process.arch}; mutation refused. Reinstall context-bridge with optional dependencies enabled for this platform, then run bridge doctor --json. Read-only inspection remains available.`, { cause });
    error.code = "BRIDGE_LOCK_UNAVAILABLE";
    error.expected = true;
    error.operation = "kernel-lock:initialize";
    error.nextCommand = "bridge doctor --json";
    throw error;
  }
}

function loadBackend() {
  // Inspection commands must not need to load native code. Mutations fail
  // closed if the platform binary is unavailable, never fall back to PID races.
  const koffi = require("koffi");
  if (process.platform === "win32") {
    const lib = koffi.load("kernel32.dll");
    const open = lib.func("intptr_t __stdcall CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, intptr_t)");
    const lock = lib.func("int __stdcall LockFileEx(intptr_t, uint32_t, uint32_t, uint32_t, uint32_t, void *)");
    const close = lib.func("int __stdcall CloseHandle(intptr_t)");
    const lastError = lib.func("uint32_t __stdcall GetLastError()");
    const overlapped = koffi.struct({ Internal: "uintptr_t", InternalHigh: "uintptr_t",
      Offset: "uint32_t", OffsetHigh: "uint32_t", hEvent: "intptr_t" });
    backend = {
      open(file) {
        // Shared reads/writes, but no FILE_SHARE_DELETE: ownership cannot be
        // detached from its pathname by another cooperating Windows writer.
        const handle = open(path.toNamespacedPath(file), 0xc0000000, 3, null, 4, 0x200080, 0);
        if (handle === -1 || handle === -1n) throw nativeError("open", lastError());
        return handle;
      },
      tryLock(handle) {
        if (lock(handle, 3, 0, 1, 0, Buffer.alloc(koffi.sizeof(overlapped)))) return true;
        const code = lastError();
        if (code === 33) return false; // ERROR_LOCK_VIOLATION, not arbitrary I/O failure
        throw nativeError("acquire", code);
      },
      close(handle) { if (!close(handle)) throw nativeError("close", lastError()); },
    };
  } else if (["darwin", "linux", "freebsd", "openbsd"].includes(process.platform)) {
    const lib = koffi.load(null);
    const flock = lib.func("int flock(int fd, int operation)");
    backend = {
      open(file) {
        try { return fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600); }
        catch (error) { throw nativeError("open", error.code); }
      },
      tryLock(fd) {
        for (;;) {
          if (flock(fd, 2 | 4) === 0) return true; // LOCK_EX | LOCK_NB
          const code = koffi.errno();
          if (code === koffi.os.errno.EINTR) continue;
          if (code === koffi.os.errno.EAGAIN || code === koffi.os.errno.EWOULDBLOCK) return false;
          throw nativeError("acquire", code);
        }
      },
      close(fd) {
        try { fs.closeSync(fd); } catch (error) { throw nativeError("close", error.code); }
      },
    };
  } else {
    throw new Error(`Kernel locking is not supported on ${process.platform}; mutation refused.`);
  }
  return backend;
}

/** Probe outside the project/store, in a bounded process, including release/reacquire. */
export function kernelLockHealth() {
  const platform = process.platform, arch = process.arch;
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-lock-health-"));
    const script = `
      import { withKernelLockSync } from ${JSON.stringify(import.meta.url)};
      try {
        for (let i = 0; i < 2; i++) withKernelLockSync(${JSON.stringify(path.join(dir, "guard"))}, () => {});
        console.log(JSON.stringify({ ok: true }));
      } catch (error) {
        console.log(JSON.stringify({ ok: false, code: error.expected ? error.code : "BRIDGE_LOCK_FAILED",
          detail: error.expected ? error.message : "Native lock probe failed; check temporary-directory permissions and native runtime installation.",
          nativeCode: error.nativeCode, operation: error.operation }));
        process.exitCode = 1;
      }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
    });
    if (result.error || result.signal) return { ok: false, platform, arch,
      code: result.error?.code === "ETIMEDOUT" ? "BRIDGE_LOCK_PROBE_TIMEOUT" : "BRIDGE_LOCK_PROBE_FAILED",
      detail: "Native lock probe could not complete; mutations are not verified. Check the native runtime and run bridge doctor --json again." };
    const report = JSON.parse(result.stdout);
    if (report.ok === true && result.status === 0) return { ok: true, platform, arch, detail: "Native lock acquisition, release and reacquisition succeeded." };
    return { ...report, ok: false, platform, arch };
  } catch {
    return { ok: false, platform, arch, code: "BRIDGE_LOCK_PROBE_FAILED",
      detail: "Cannot complete the native lock probe; check temporary-directory permissions and native runtime installation." };
  } finally {
    if (dir) {
      try { fs.rmSync(dir, { recursive: true, force: true }); }
      catch { return { ok: false, platform, arch, code: "BRIDGE_LOCK_PROBE_CLEANUP_FAILED",
        detail: "Cannot remove the temporary native lock probe; check temporary-directory permissions." }; }
    }
  }
}

/** Run a synchronous critical section. The guard file must NEVER be unlinked. */
export function withKernelLockSync(file, fn) {
  const native = lockBackend();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let key = path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  let existing;
  try { existing = fs.lstatSync(key); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
    throw new Error(`Unsafe kernel lock file: ${key}`);
  }
  if (existing) key = fs.realpathSync(key);
  if (entered.has(key)) throw new Error(`Recursive kernel lock acquisition refused: ${key}`);
  const handle = native.open(key);
  entered.add(key);
  try {
    while (!native.tryLock(handle)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    const current = fs.lstatSync(key);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) throw new Error(`Unsafe kernel lock file: ${key}`);
    if (process.platform !== "win32") {
      const opened = fs.fstatSync(handle);
      if (opened.dev !== current.dev || opened.ino !== current.ino) throw new Error(`Kernel lock path changed: ${key}`);
    }
    return fn();
  } finally {
    entered.delete(key);
    native.close(handle);
  }
}
