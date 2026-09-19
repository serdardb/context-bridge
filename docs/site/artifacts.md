> Context you can carry somewhere else: a redacted, hashed bundle, optionally signed, optionally encrypted.

# Portable and sealed context

A `.cbctx` artifact is an explicit, redacted context package with a schema and an integrity hash. It is never native session state, and it is never produced by accident — you ask for it.

## Export and import

`bridge artifact export <file>` writes one. `--sign-key <pem>` adds an Ed25519 signature.

`bridge artifact import <file>` verifies it; `--verify-key <pem>` requires that it was signed by a key you trust, and `--apply` stages it into the project. Verification and application are separate steps on purpose: checking what something is should not commit you to using it.

`bridge artifact cache <file>` verifies and stores by content hash outside the project, for a bundle you want to keep but not apply.

## Sealing

`bridge artifact seal <file> --out <new-directory>` validates the artifact and creates a private directory containing `context.cbsealed` and a separate `key.bin`.

Share only the encrypted file. Deliver the key through an independent channel, and never upload the whole bundle — a sealed bundle with its key beside it is a plaintext file with extra steps.

`bridge artifact open context.cbsealed --key-file key.bin --out <new-file>` authenticates, decrypts and validates before publishing a new file. It does not import or initialise a project.

Version 1 uses a fresh random key and nonce per AES-256-GCM envelope, accepts up to 16 MiB of plaintext, and refuses overwrites. Parent directories must already exist.

Encryption establishes neither sender identity nor any ability to revoke copies already received. Signing is what establishes identity, and it is a separate flag at both ends.

## What is in these files

Redaction is heuristic: it masks nested project paths, shares a list of sensitive keys across text and objects, and recognises common credential and private-key formats. It is a reduction of risk, not a guarantee, and a bundle is worth reading before it leaves your machine.
