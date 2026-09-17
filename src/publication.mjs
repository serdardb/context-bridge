import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let rename;

function failure(code, nativeCode, cause) {
  return Object.assign(new Error(`Exclusive file publication failed on ${process.platform}/${process.arch}. No overwrite or copy fallback was attempted.`, { cause }), {
    expected: true, code, nativeCode, operation: "file:publish",
    nextCommand: "bridge doctor --json",
  });
}

function loadRename() {
  try {
    const koffi = require("koffi");
    if (process.platform === "win32") {
      const lib = koffi.load("kernel32.dll");
      const move = lib.func("int __stdcall MoveFileExW(str16, str16, uint32_t)");
      const lastError = lib.func("uint32_t __stdcall GetLastError()");
      return (from, to) => {
        // No REPLACE_EXISTING, COPY_ALLOWED or delayed operation.
        if (move(path.toNamespacedPath(from), path.toNamespacedPath(to), 8)) return;
        const code = lastError();
        throw failure([80, 183].includes(code) ? "EEXIST" : "BRIDGE_PUBLICATION_FAILED", code);
      };
    }
    const lib = koffi.load(null);
    let call;
    if (process.platform === "darwin") {
      const fn = lib.func("int renamex_np(const char *, const char *, unsigned int)");
      call = (from, to) => fn(from, to, 4); // RENAME_EXCL
    } else if (process.platform === "linux") {
      try {
        const fn = lib.func("int renameat2(int, const char *, int, const char *, unsigned int)");
        call = (from, to) => fn(-100, from, -100, to, 1); // AT_FDCWD, RENAME_NOREPLACE
      } catch (cause) {
        // Older musl omits the wrapper even when the kernel supports renameat2.
        // These numbers are Linux UAPI, not a weaker publication fallback.
        const number = { arm64: 276, x64: 316 }[process.arch];
        if (!number) throw cause;
        const syscall = lib.func("long syscall(long, ...)");
        call = (from, to) => syscall(number, "long", -100, "str", from, "long", -100, "str", to, "ulong", 1);
      }
    } else throw new Error("No exclusive-rename backend for this platform.");
    return (from, to) => {
      if (call(from, to) === 0) return;
      const code = koffi.errno();
      throw failure(code === koffi.os.errno.EEXIST ? "EEXIST" : "BRIDGE_PUBLICATION_FAILED", code);
    };
  } catch (cause) {
    throw failure("BRIDGE_PUBLICATION_UNAVAILABLE", null, cause);
  }
}

// A narrow native-I/O boundary, also used by process-exit fault probes.
export const publication = {
  renameExclusive(from, to) {
    rename ??= loadRename();
    return rename(path.resolve(from), path.resolve(to));
  },
};
