> An opt-in way to move a sealed bundle between two machines, over a loopback server you run yourself.

# Sharing sealed bundles

Sharing is optional, explicit and local-first. There is no service behind it: `bridge share serve` runs an opaque store bound to loopback, on a directory you nominate, authenticated by a token file you create.

```
bridge share serve --dir /private/store --token-file token.txt
```

The store is opaque — it holds ciphertext and content hashes, and has no way to read what it is keeping.

## Sending and fetching

`bridge share send <file> --endpoint <origin>` previews the upload; `--apply` performs it with `--token-file`. `bridge share fetch <hash>` downloads ciphertext only and requires the endpoint, the token file and an output path. `bridge share remove <hash>` previews a removal and deletes on `--apply`.

Preview-first is the rule across every command in this tool that changes something somewhere else.

## Keys do not travel with bundles

The sealed file and its key are produced as separate files for a reason, and sharing is the moment that reason matters. Send the ciphertext through this channel; send the key through a different one. If both travel the same path, the encryption has bought you nothing.

## What this is not

It is not a hosted service, a sync product, or a way to collaborate on a live session. It is a transport for a file you have already decided to hand over, with the smallest amount of machinery that makes that safe.
