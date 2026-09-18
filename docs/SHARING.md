# Optional Remote Sharing

Local artifact operations need no server, account or network. These explicit commands
layer over `artifact seal/open`; they do not change normal handoff behavior.
The server stores ciphertext, never a decryption key. Encryption does not
establish sender identity: keep using an independently trusted Ed25519 public
key for signed artifacts.

## Operator Setup

Create a dedicated private directory and a separate private token file. Token
contents must be 32-128 cryptographically random URL-safe characters; for
example, use Node's `crypto.randomBytes(32).toString('hex')`, stored with mode
0600. Do not put tokens in command arguments, URLs, source control or logs.
The server directory must already exist with mode0700 on POSIX.
Startup acquires and releases the store's stable `.share.guard` before listening.
Missing native locking or an unusable guard refuses startup with a diagnostic;
the server does not report readiness and defer that failure to the first upload.

```sh
bridge share serve --dir /private/share-store --token-file /private/share-token --port 8787
```

This foreground server binds **127.0.0.1 only**. For remote clients, place it
behind your own authenticated operational environment and HTTPS reverse proxy.
TLS must terminate before reaching this loopback listener. The bearer token is
still required on every object request; a TLS proxy must preserve Authorization.
The server does not deploy a public endpoint or configure a firewall for you.
SIGINT/SIGTERM closes the listener and active connections.

One token defines one operator trust domain: every holder can upload, fetch and
delete any known object. This is not tenant isolation, per-recipient permissions
or an anonymous public sharing service. Rotate the token by replacing its file
and restarting the server. The decryption key is unrelated to this token.

## Sender and Recipient

```sh
bridge artifact seal report.cbctx --out /private/new-bundle
bridge share send /private/new-bundle/context.cbsealed --endpoint https://share.example.org
bridge share send /private/new-bundle/context.cbsealed --endpoint https://share.example.org --token-file /private/share-token --apply --json
bridge share fetch CIPHERTEXT_SHA256 --endpoint https://share.example.org --token-file /private/share-token --out /private/download.cbsealed
bridge artifact open /private/download.cbsealed --key-file /private/received-key.bin --out /private/new-report.cbctx
bridge artifact import /private/new-report.cbctx
```

Send only `context.cbsealed`; deliver `key.bin` separately through a trusted
channel. Never upload the bundle directory. Supply `--verify-key` to seal/open
and import for signed artifacts. Inspect the decrypted artifact and only then
choose `artifact import ... --apply` to change a project.

`share send` returns the ciphertext's SHA-256. Communicate that exact hash to
the recipient independently; fetch refuses a mismatching download. A hash
proves byte identity, not sender identity or safety of instructions in a context.
Existing local destinations are never overwritten.

## Limits and Retention

- HTTPS origins only: credentials, query strings, fragments, base paths and
  redirects are rejected. Explicit `--allow-loopback-http` permits only literal
  127.0.0.1 or ::1 for local testing. It does not allow arbitrary plain HTTP.
- Requests have a30-second deadline. Client responses and server uploads are
  bounded to24MiB. There are no automatic mutation retries; a timeout can mean
  remote completion is unknown. Repeat the same hash deliberately if needed.
- Default access lifetime is86400seconds; `share send --ttl-seconds` accepts
  1 through604800. Repeated identical uploads do not extend expiry. Expired
  objects cannot be fetched or revived by an upload; delete them explicitly
  before a new upload. Expiry restricts access, **not physical disk retention**.
- `share remove HASH --endpoint ...` previews locally. Add `--token-file ...
  --apply` to delete. This cannot revoke copies or decryption keys already held
  by a recipient. There is no remote listing or automatic garbage collector.
- Disk quota defaults to256MiB, configurable with `serve --quota-bytes` up to
  1GiB. Stored JSON encoding, retained expired objects and interrupted staging
  count toward disk use. The server refuses further uploads at quota; it never
  silently evicts context. At most four authenticated requests are active per
  process and32connections are allowed. This is a bounded small-team service,
  not a distributed or internet-scale object store.

The storage operator can see size, timing and object hashes, and can delete or
withhold data. Private staging can remain after a crash; inspect it locally
before removal. Selected native Windows interruption tests and a synthetic public
HTTPS transfer run separately in CI. Neither establishes physical power-loss
durability, resistance to every parent-path attack, or the safety of your deployed
TLS proxy and operator configuration. Successful loopback tests alone are not
proof of those conditions.
