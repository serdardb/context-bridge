import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { inspectSealedBytes, MAX_ENVELOPE_BYTES } from "./sealed-artifact.mjs";
import { readOwnedFile, writeFileExclusive, syncPublishedDirectory, BridgeError } from "./util.mjs";
import { withKernelLockSync } from "./locking.mjs";

const HASH = /^[a-f0-9]{64}$/;
const DEADLINE_MS = 30000;
const MAX_TTL = 7 * 24 * 3600;
const MAX_RECORD_BYTES = MAX_ENVELOPE_BYTES * 2;
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = message => new BridgeError(message, { code: "BRIDGE_REMOTE_ARTIFACT" });

function tokenFrom(file) {
  if (typeof file !== "string" || !file) throw fail("An explicit private --token-file is required.");
  const bytes = readOwnedFile(file, { maxBytes: 256 });
  if (process.platform !== "win32" && (fs.lstatSync(file).mode & 0o077)) throw fail("Token file must be private (mode 0600).");
  const token = bytes.toString("utf8").trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw fail("Token must contain 32 to 128 random URL-safe characters.");
  return token;
}

function endpointURL(endpoint, allowLoopbackHttp) {
  let url;
  try { url = new URL(endpoint); } catch { throw fail("A valid explicit HTTPS endpoint is required."); }
  const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(allowLoopbackHttp && loopback && url.protocol === "http:"))) {
    throw fail("Use an HTTPS origin without credentials, path, query or fragment. Plain HTTP requires explicit literal-loopback opt-in.");
  }
  return url;
}

function checkHash(hash) { if (!HASH.test(hash ?? "")) throw fail("An exact lowercase SHA-256 ciphertext hash is required."); }
function checkTtl(ttl) { if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_TTL) throw fail("Retention must be 1 to 604800 seconds."); }

async function request(url, method, token, bytes, ttl) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(url, { method, headers: {
      Authorization: `Bearer ${token}`, Connection: "close",
      ...(bytes ? { "Content-Length": bytes.length, "Content-Type": "application/octet-stream", "X-Bridge-TTL": ttl } : {}),
    } }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        finish(fail(`Remote artifact request refused (HTTP ${res.statusCode}); no redirect or retry was attempted.`));
        res.destroy(); req.destroy(); return;
      }
      let size = 0;
      const chunks = [];
      res.on("data", chunk => {
        size += chunk.length;
        if (size > MAX_ENVELOPE_BYTES) {
          finish(fail("Remote artifact response exceeds the byte limit."));
          res.destroy(); req.destroy();
        } else chunks.push(chunk);
      });
      res.on("end", () => finish(null, Buffer.concat(chunks)));
      res.on("error", () => finish(fail("Remote artifact response was interrupted.")));
    });
    const timer = setTimeout(() => {
      finish(fail("Remote artifact request exceeded its deadline; remote completion is unknown."));
      req.destroy();
    }, DEADLINE_MS);
    req.on("error", () => finish(fail("Remote artifact connection failed; no retry was attempted.")));
    req.end(bytes);
  });
}

/** Preview is entirely local. Upload accepts only a pre-existing sealed file. */
export async function sendArtifact(file, { endpoint, tokenFile, apply = false, ttl = 86400, allowLoopbackHttp = false } = {}) {
  const url = endpointURL(endpoint, allowLoopbackHttp);
  checkTtl(ttl);
  const bytes = readOwnedFile(file, { maxBytes: MAX_ENVELOPE_BYTES });
  try { inspectSealedBytes(bytes); } catch { throw fail("Only a valid sealed envelope may be sent; raw artifacts and key files are refused."); }
  const hash = digest(bytes);
  if (apply) {
    url.pathname = `/v1/artifacts/${hash}`;
    await request(url, "PUT", tokenFrom(tokenFile), bytes, ttl);
  }
  return { applied: apply, hash, bytes: bytes.length, endpoint: url.origin, retentionSeconds: ttl };
}

export async function fetchArtifact(hash, output, { endpoint, tokenFile, allowLoopbackHttp = false } = {}) {
  checkHash(hash);
  const url = endpointURL(endpoint, allowLoopbackHttp);
  url.pathname = `/v1/artifacts/${hash}`;
  const bytes = await request(url, "GET", tokenFrom(tokenFile));
  if (digest(bytes) !== hash) throw fail("Downloaded ciphertext does not match the requested hash; nothing was written.");
  try { inspectSealedBytes(bytes); } catch { throw fail("Downloaded data is not a valid sealed envelope; nothing was written."); }
  const destination = path.resolve(output);
  writeFileExclusive(destination, bytes);
  return { path: destination, hash, bytes: bytes.length, decrypted: false, imported: false };
}

export async function removeRemoteArtifact(hash, { endpoint, tokenFile, apply = false, allowLoopbackHttp = false } = {}) {
  checkHash(hash);
  const url = endpointURL(endpoint, allowLoopbackHttp);
  if (apply) {
    url.pathname = `/v1/artifacts/${hash}`;
    await request(url, "DELETE", tokenFrom(tokenFile));
  }
  return { applied: apply, hash, endpoint: url.origin };
}

/** One operator trust domain, behind operator-managed TLS for remote access. */
export async function startArtifactServer({ directory, tokenFile, port = 0, quotaBytes = 256 * 1024 * 1024 } = {}) {
  const token = tokenFrom(tokenFile);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw fail("Invalid listening port.");
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 1 || quotaBytes > 1024 * 1024 * 1024) throw fail("Disk quota must be 1 to 1073741824 bytes.");
  const root = path.resolve(directory);
  const info = fs.lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077))) {
    throw fail("Sharing requires an existing private storage directory, not a symlink.");
  }
  const identity = fs.realpathSync(root);
  const guard = path.join(identity, ".share.guard");
  const assertIdentity = () => {
    const now = fs.lstatSync(root);
    if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== info.dev || now.ino !== info.ino || fs.realpathSync(root) !== identity) {
      throw fail("Sharing storage identity changed; operation refused.");
    }
  };
  const owned = fn => {
    assertIdentity();
    return withKernelLockSync(guard, () => { assertIdentity(); return fn(); });
  };
  // Do not announce readiness when the store's ownership mechanism is unusable.
  owned(() => {});
  const read = hash => {
    const bytes = readOwnedFile(path.join(identity, hash), { maxBytes: MAX_RECORD_BYTES, missing: true });
    if (!bytes) return null;
    const record = JSON.parse(bytes);
    if (record.version !== 1 || !Number.isSafeInteger(record.expiresAt) || typeof record.envelope !== "string") throw fail("Invalid stored object.");
    const envelope = Buffer.from(record.envelope, "base64");
    if (envelope.toString("base64") !== record.envelope || digest(envelope) !== hash) throw fail("Stored object hash mismatch.");
    inspectSealedBytes(envelope);
    return { bytes: envelope, expiresAt: record.expiresAt };
  };
  let active = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader("Connection", "close");
    res.setHeader("Cache-Control", "no-store");
    const received = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) { res.writeHead(401).end(); return; }
    const match = /^\/v1\/artifacts\/([a-f0-9]{64})$/.exec(req.url ?? "");
    if (!match || !["GET", "PUT", "DELETE"].includes(req.method)) { res.writeHead(404).end(); return; }
    if (active >= 4) { res.writeHead(503).end(); return; }
    active++;
    const timer = setTimeout(() => { req.destroy(); res.destroy(); }, DEADLINE_MS);
    res.once("close", () => { clearTimeout(timer); active--; });
    try {
      const hash = match[1];
      if (req.method === "PUT") {
        const ttl = Number(req.headers["x-bridge-ttl"]);
        checkTtl(ttl);
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_ENVELOPE_BYTES) { res.writeHead(413).end(); return; }
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        if (digest(bytes) !== hash) { res.writeHead(422).end(); return; }
        inspectSealedBytes(bytes);
        const status = owned(() => {
          const prior = read(hash);
          if (prior) return prior.expiresAt > Date.now() ? 200 : 409;
          const record = Buffer.from(JSON.stringify({ version: 1, expiresAt: Date.now() + ttl * 1000, envelope: bytes.toString("base64") }));
          let used = 0;
          const names = fs.readdirSync(identity);
          if (names.length > 10000) return 507;
          for (const name of names) {
            if (name === ".share.guard") continue;
            const stat = fs.lstatSync(path.join(identity, name));
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail("Unsafe sharing store entry.");
            used += stat.size;
          }
          if (used + record.length > quotaBytes) return 507;
          writeFileExclusive(path.join(identity, hash), record);
          return 201;
        });
        res.writeHead(status).end();
      } else {
        const record = owned(() => {
          const entry = read(hash);
          if (req.method === "DELETE" && entry) {
            fs.unlinkSync(path.join(identity, hash));
            syncPublishedDirectory(path.join(identity, hash));
          }
          return entry;
        });
        if (req.method === "DELETE") { res.writeHead(204).end(); return; }
        if (!record || record.expiresAt <= Date.now()) { res.writeHead(404).end(); return; }
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": record.bytes.length }).end(record.bytes);
      }
    } catch {
      if (!res.headersSent) res.writeHead(400).end();
      else res.destroy();
    }
  });
  server.maxConnections = 32;
  server.maxHeadersCount = 20;
  server.headersTimeout = 10000;
  server.requestTimeout = DEADLINE_MS;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, endpoint: `http://127.0.0.1:${server.address().port}` };
}
