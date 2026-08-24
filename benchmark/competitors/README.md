# End-to-end IPC competitor benchmark

This is a separate benchmark lane for public message APIs. It compares:

- Node `child_process` IPC with explicit JSON serialization;
- Node `net` over TCP loopback with canonical JSON and newline framing;
- the local node-ipc 14 checkout with its default fast profile over TCP loopback;
- ws 8.21.3 with compression and optional native accelerators disabled;
- Socket.IO plus socket.io-client 4.8.3, forced to WebSocket;
- ZeroMQ.js 6.6.0 with DEALER/ROUTER over TCP loopback.

It does not mix these results into the existing raw-client/C-oracle benchmark. Native child IPC cannot connect to that byte reflector, has no comparable public wire-byte counters, and only connects a parent to its child. Keeping the common JSON request/echo workload in its own lane makes those boundaries visible.

## Install and verify

Run this lane from its isolated package directory so comparator packages never become node-ipc production or development dependencies:

```sh
cd benchmark/competitors
npm ci --no-audit --no-fund
npm test
npm run quick
```

`npm test` checks exact payload construction, balanced planning, statistics, version-specific capability evidence, dependency closure, adapter SLOC, result validation, and a tiny end-to-end trial for all subjects.

## Record a local snapshot

For the six-subject matrix, the default full configuration uses 6 independent samples—one complete six-row Williams-derived cycle—plus 64-byte, 4-KiB, and 64-KiB canonical JSON messages and separate throughput and latency trials:

```sh
node run.js --output=./results/local-$(date +%Y%m%d).json
```

On PowerShell:

```powershell
$stamp = Get-Date -Format yyyyMMdd
node .\run.js --output=".\results\local-$stamp.json"
```

Useful development overrides include:

```sh
node run.js --quick
node run.js --samples=12 --payloads=64,4096
node run.js --subjects=native-child-process,node-ipc --workloads=latency
node validate.js ./results/result.json
node render-report.js ./results/result.json ./REPORT.md
```

Subject subsets must contain an even number of entries. Exact position and first-order carryover balance requires a complete cycle, so the sample count should be a multiple of the selected subject count. Use 6 samples for the default six-subject snapshot and at least 24 samples (four complete cycles) for publication evidence.

## Common workload contract

Each logical message is:

```json
{"payload":"...","sequence":"00000000"}
```

The ASCII payload is sized so the entire canonical JSON representation is exactly 64 bytes, 4 KiB, or 64 KiB. Stream, WebSocket, and ZMTP adapters parse and re-encode this object at the peer; node-ipc, child IPC, and Socket.IO use their public message serialization.

Every independent sample gets fresh driver and echo-peer processes. Peer readiness and shutdown use newline-delimited JSON on stdio, so the native child subject has only one IPC channel and that channel is the measured transport. Startup, connection negotiation, a content/sequence probe, and warm-up are outside the timed measurement.

Throughput uses up to 64 requests and no more than 8 MiB of canonical application payload outstanding; transport framing and serialization overhead are not part of that byte cap. Application MiB/s counts the request payload once per completed round trip, not both the request and echoed response. Latency keeps exactly one request in flight and reports sender-side round-trip percentiles. Timed replies still verify order, sequence, exact encoded size, and payload content.

The cleanup gate requires natural process exits, no private temporary files, and closed/reusable TCP endpoints. Failed or timed-out trials remain failures; the runner does not retry or delete measured outliers.

## Interpreting results

The result is deliberately `local-snapshot-noisy` and `rankingEligible: false`. Parent-child pipes, TCP, WebSocket, Socket.IO, and ZMTP have different topology and capability semantics. Compare speed only after filtering to solutions that meet the application requirements.

Implementation complexity is the subject-specific adapter's nonblank, noncomment source lines, bytes, file count, and SHA-256. The shared harness is excluded. This is an auditable implementation-glue proxy, not an intrinsic cognitive-complexity score.

Third-party dependency exposure is computed from the pinned production lockfile closure. The primary proxy is unique resolved production `name@version` packages, excluding the subject package itself. The tier is based only on that count:

- 0: minimal;
- 1–5: low;
- 6–15: moderate;
- 16 or more: high.

This proxy does not assess vulnerabilities, maintainers, provenance, signatures, vendored code, or package quality. Native Node has zero external npm dependencies, not zero supply-chain risk. ZeroMQ has a small npm closure but includes a native addon and install script.

## Current evidence

- [Technical report](./REPORT.md)
- [Windows / Node 24 raw snapshot](./results/windows-node24-20260823.json)
- [Result schema](./result-schema.json)
- [Named SQLite artifact queries](./artifact-queries.sql)

Run `npm run artifact-data` to reproduce the report's performance, dependency-exposure, and capability source inventory from the tracked raw JSON using Node's built-in SQLite JSON functions.

The tracked Windows snapshot has 6 samples per cell, completes one six-row Williams-derived cycle, and remains directional. Clean cross-platform publication should use identified idle Windows and Linux machines, exact Node versions, at least 24 blocks for the six-subject matrix, and separate JSON, binary, and local-pipe lanes.
