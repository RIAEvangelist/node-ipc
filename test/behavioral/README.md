# Cross-language behavioral testing

This repository-only suite exercises the common, observable Fast TCP contract
across JavaScript, Rust, and C#. It runs every client against every server, so
the default gate contains nine directed language pairs, including both
Rust/C# directions and the three same-language baselines. Twelve raw
fault-injection cases additionally prove that every language rejects complete
and incomplete trailing frames in both its client and server roles.

The versioned transcript in `tcp-transcript.json` pipelines seven requests with
top-level `null`, `false`, zero, empty-string, Unicode/control-character, array,
and nested-object payloads. Each server must receive them in order and return
the exact semantic value under the corresponding response event. Every native
peer also byte-compares one canonical encoded frame, including its form-feed
delimiter. A separate final request/summary barrier is sent only after all seven
responses arrive. The client then half-closes its request stream. The server
rejects trailing requests before closing, while the client rejects trailing
responses and requires the server's clean end-of-stream.

The fixture itself is portable JSON: duplicate members, noncanonical or
JavaScript-unsafe numbers, lone UTF-16 surrogates, invalid UTF-8, and nesting
beyond 64 containers are rejected before a peer starts.

Run the complete matrix from the repository root:

```console
npm run test:behavioral
```

The runner builds the repository-only Rust and C# peers once in an isolated
temporary directory, reserves a fresh loopback port for each pair, enforces
readiness and process deadlines, validates machine-readable lifecycle records,
executes all 21 positive and negative cases, and removes all temporary
artifacts. The suite makes no timing assertions and is not benchmark evidence.

Language-native suites remain responsible for profile errors, raw mode, UDP,
local transports, TLS policy, reconnects, backpressure, deterministic fragmented
and coalesced parser inputs, and other APIs that do not form one identical
three-language surface. The existing two-direction Node/Rust and Node/C#
commands use this same runner with only their respective mixed-language pairs.
