# Node and C# interoperability gate

This repository-only gate selects both mixed Node/C# directions from the shared
behavioral runner:

- C# server with the JavaScript client
- JavaScript server with the C# client

From the repository root:

```console
node csharp/node-ipc/interop/vanilla-test.js
```

Both directions run the versioned Fast TCP transcript in
`test/behavioral/tcp-transcript.json`. The client pipelines `null`, `false`,
zero, empty-string, Unicode/control-character, array, and nested-object payloads.
Only after all seven replies does it send the finish request. Each C# encoder
must also match the canonical Fast frame byte for byte, and both peers must then
enforce the clean request half-close and response end-of-stream before they
publish exact completion records. The
harness builds the C# peer in an isolated temporary artifact directory, reserves
fresh loopback ports, enforces deadlines, and requires exactly 2/2 passing
directions.

Run `npm run test:behavioral` for the full nine-pair JavaScript/Rust/C# matrix
plus 12 trailing-frame rejection checks.
