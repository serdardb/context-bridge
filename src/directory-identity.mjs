import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { BridgeError } from "./util.mjs";

const require = createRequire(import.meta.url);
let native;

function linuxTmpfsIdentity(fd) {
  if (process.platform !== "linux" || !["arm64", "x64"].includes(process.arch) || os.endianness() !== "LE") return null;
  if (!native) {
    const koffi = require("koffi"), libc = koffi.load(null);
    const stats = koffi.struct({
      type: "long", bsize: "long", blocks: "uint64_t", bfree: "uint64_t", bavail: "uint64_t",
      files: "uint64_t", ffree: "uint64_t", fsid: koffi.array("int32_t", 2),
      namelen: "long", frsize: "long", flags: "long", spare: koffi.array("long", 4),
    });
    native = { koffi, stats, statfs: libc.func("int fstatfs(int, void *)"),
      handle: libc.func("int name_to_handle_at(int, const char *, void *, void *, int)") };
  }
  const { koffi, stats, statfs, handle } = native;
  const buffer = Buffer.alloc(koffi.sizeof(stats));
  if (statfs(fd, buffer) !== 0) throw new Error(`fstatfs failed: ${koffi.errno()}`);
  const info = koffi.decode(buffer, stats);
  // Only tmpfs semantics have been reviewed: a fresh filesystem UUID and an
  // opaque inode-generation handle. Do not generalize this to network stores.
  if (Number(info.type) !== 0x01021994 || info.fsid.every((value) => value === 0)) return null;
  const bytes = Buffer.alloc(136), mount = Buffer.alloc(4);
  bytes.writeUInt32LE(128);
  if (handle(fd, "", bytes, mount, 0x1000) !== 0) {
    if ([koffi.os.errno.EOPNOTSUPP, koffi.os.errno.ENOSYS, koffi.os.errno.EOVERFLOW].includes(koffi.errno())) return null;
    throw new Error(`name_to_handle_at failed: ${koffi.errno()}`);
  }
  const length = bytes.readUInt32LE();
  if (!length || length > 128) return null;
  const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(boot)) return null;
  // Mount numbers can be recycled. tmpfs contents do not survive a boot;
  // filesystem UUID, boot and opaque handle keep separate mounts isolated.
  return "v3:linux-tmpfs:" + crypto.createHash("sha256").update(JSON.stringify([
    boot, info.fsid, bytes.readInt32LE(4), bytes.subarray(8, 8 + length).toString("hex"),
  ])).digest("hex");
}

export function isVerifiedDirectoryIdentity(value) {
  return typeof value === "string" && (/^v2:(?:0|[1-9][0-9]*):(?:0|[1-9][0-9]*):[1-9][0-9]*$/.test(value) || /^v3:linux-tmpfs:[a-f0-9]{64}$/.test(value));
}

export function directoryIdentity(directory) {
  const before = fs.statSync(directory, { bigint: true });
  if (!before.isDirectory()) return null;
  if (before.birthtimeNs > 0n) return `v2:${before.dev}:${before.ino}:${before.birthtimeNs}`;
  let fd;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("Directory replaced before opening");
    const identity = linuxTmpfsIdentity(fd);
    const after = fs.statSync(directory, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.birthtimeNs !== opened.birthtimeNs) throw new Error("Directory replaced during identity lookup");
    return identity;
  } catch (cause) {
    throw new BridgeError("Directory identity could not be verified. No existing project context was selected.", {
      code: "BRIDGE_PROJECT_IDENTITY_UNAVAILABLE", operation: "identify project", cause,
    });
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
