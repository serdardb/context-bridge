// Install in a fresh child before the first mutation loads the native backend.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

export function observeKernelContention(callback) {
  const koffi = require("koffi");
  const load = koffi.load;
  koffi.load = (...args) => {
    const lib = load(...args), func = lib.func;
    const observed = (...args) => {
      const call = func.call(lib, ...args);
      const signature = args[0];
      if (signature.includes(" flock(")) return (...values) => {
        const result = call(...values), code = koffi.errno();
        if (result !== 0 && [koffi.os.errno.EAGAIN, koffi.os.errno.EWOULDBLOCK].includes(code)) callback();
        koffi.errno(code);
        return result;
      };
      if (signature.includes(" LockFileEx(")) {
        const get = func.call(lib, "uint32_t __stdcall GetLastError()");
        const set = func.call(lib, "void __stdcall SetLastError(uint32_t)");
        return (...values) => {
          const result = call(...values), code = get();
          if (!result && code === 33) callback();
          set(code);
          return result;
        };
      }
      return call;
    };
    return { func: observed };
  };
}
