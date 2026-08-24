# End-to-end IPC transport-lane benchmark

This isolated suite compares public message APIs with the same exact canonical JSON request/echo payload. Transport is a first-class dimension: a module can have several independently measured lanes, and results are grouped by transport cohort rather than collapsed into a module leaderboard.

The executable schema-v2 lanes are:

- Node `child_process` on its dedicated parent-child IPC channel;
- Node `net`, node-ipc, `ws`, Socket.IO, and ZeroMQ.js on TCP loopback where implemented;
- Node `net`, node-ipc, and `ws` on local IPC (Windows named pipes or Unix-domain sockets);
- Node `tls`, node-ipc, `ws`, and Socket.IO on mutually authenticated TLS 1.3 over TCP loopback.

UDP support is documented in the capability evidence but is not part of this stream request/echo suite. A supported-but-unmeasured or unsupported transport is scope metadata, not a failed performance sample.

The suite does not mix these measurements into the existing raw-client/C-oracle benchmark. Native child IPC cannot connect to that byte reflector, exposes no comparable public wire-byte counter, and only connects a parent to its direct child.

## Install and verify

Run from the isolated package directory so comparator packages never become node-ipc production or development dependencies:

```sh
cd benchmark/competitors
npm ci --no-audit --no-fund
npm test
npm run quick
```

`npm test` checks exact payload construction, even/odd Williams-derived planning, statistics, capability and transport evidence, dependency closure, adapter SLOC, schema-v1 compatibility, schema-v2 dimension integrity, SQLite query cardinality, report language, TLS fixture validity and peer authentication, and small end-to-end trials.

The certificates in `fixtures/tls/` are deterministic benchmark-only fixtures. They are valid from 2026-01-01 through 2036-01-01 and must not be reused outside this suite. Tests parse the CA, server, and client certificates, check that the benchmark date is covered, verify the server names `localhost` and `127.0.0.1`, and require every measured TLS lane to report an authorized TLS 1.3 session.

## Record a local schema-v2 snapshot

The default full run uses one complete cohort-local order cycle per transport:

| Cohort | Measured lanes | Default blocks | Publication starting point (four cycles) |
| --- | ---: | ---: | ---: |
| Dedicated process IPC | 1 | 1 | 4 |
| TCP | 5 | 10 | 40 |
| Local IPC | 3 | 6 | 24 |
| TLS | 4 | 4 | 16 |

The odd-sized TCP and local cohorts need twice their lane count for first-order carryover balance. Exact position and first-order carryover balance applies only to complete cohort cycles. The quick mode uses one block per cohort for lifecycle validation and is not balanced evidence.

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
node run.js --quick --transports=tls --payloads=64
node run.js --quick --lanes=native-net:tcp,native-net:local
node run.js --lanes=native-net:tcp,node-ipc:tcp --samples=2 --payloads=64,4096
node run.js --samples=60 --payloads=64,4096
node validate.js ./results/result.json
node render-report.js ./results/result.json ./REPORT.md
node artifact-data.js ./results/result.json
```

`--lanes`, `--transports`, and legacy `--subjects` selectors are mutually exclusive. A non-quick explicit `--samples=N` applies the same block count to every selected cohort, so it must be divisible by every selected cohort's cycle. The default chooses the minimum complete cycle separately for each cohort.

## Common workload contract

Each logical message is:

```json
{"payload":"...","sequence":"00000000"}
```

The ASCII payload is sized so the entire canonical JSON representation is exactly 64 bytes, 4 KiB, or 64 KiB. Stream, WebSocket, and ZMTP adapters parse and re-encode this object at the peer; node-ipc, child IPC, and Socket.IO use their public message serialization.

Every independent sample gets fresh driver and echo-peer processes. Peer readiness and shutdown use newline-delimited JSON on stdio, so the native child lane has only one IPC channel and that channel is the measured transport. Startup, connection negotiation, a content/sequence probe, and warm-up are outside the timed measurement. Cold-start observations remain in the raw result.

Throughput uses up to 64 requests and no more than 8 MiB of canonical application request payload outstanding; framing and serialization overhead are not part of that cap. Application MiB/s counts the request payload once per completed RTT, not both request and echo. Latency keeps exactly one request in flight and reports sender-side round-trip percentiles. Timed replies still verify order, sequence, exact encoded size, and payload content.

The cleanup gate requires natural process exits, no private temporary artifacts, and closed or released endpoints. Failed or timed-out trials remain failures; the runner does not retry or delete measured outliers. The raw JSON preserves every sample and its reported distributions.

## Interpreting results

Every result is deliberately `local-snapshot-noisy` with all comparison-eligibility flags set to false. A transport lane is the descriptive measurement unit. Performance tables preserve configured lane order within each transport cohort; no global, cross-transport, within-transport, or transport-effect rank is produced. The one-lane process IPC cohort is a descriptive baseline with no ordinal comparator.

Filter by capability, topology, security, and interoperability requirements first. Parent-child IPC, TCP, local IPC, TLS, WebSocket, Socket.IO, and ZMTP differ materially and must not be pooled into a universal winner.

Implementation complexity records the adapter's nonblank, noncomment source lines, bytes, file count, and SHA-256. Complexity may be module-level when one adapter supplies several lanes or lane-level when implementations are separate. Shared harness code is excluded. This is auditable implementation glue, not intrinsic cognitive complexity.

Adapter and package-lock SHA-256 values normalize CRLF line endings to LF before hashing, so the same Git content verifies consistently on Windows and POSIX checkouts.

Dependency exposure is deduplicated at the module level even when a module has several lanes. The raw evidence records both direct dependency name count and the pinned production lockfile closure. The primary supply-chain proxy is unique resolved production `name@version` dependencies, excluding the subject package itself. Its tier is based only on that count:

- 0: minimal;
- 1–5: low;
- 6–15: moderate;
- 16 or more: high.

This proxy does not assess vulnerabilities, maintainers, provenance, signatures, vendored code, or package quality. Native Node has zero external npm dependencies, not zero total supply-chain risk. Install scripts and native addons remain separately visible evidence.

## Schemas, evidence, and reproducible artifact data

- [Technical report](./REPORT.md)
- [Current Windows / Node 24 transport snapshot](./results/windows-node24-transports-20260824.json)
- [Immutable schema-v1 Windows / Node 24 snapshot](./results/windows-node24-20260823.json)
- [Schema v1](./result-schema.json)
- [Schema v2](./result-schema-v2.json)
- [Named SQLite artifact queries](./artifact-queries.sql)

`validate.js` dispatches by `schemaVersion`: the tracked v1 snapshot remains renderable without rewriting historical evidence, while new runs emit v2 transport and lane dimensions. The tracked v1 snapshot has six samples per cell and one complete six-subject cycle; it remains a directional historical snapshot, not current multi-transport evidence.

Run `node artifact-data.js <result.json>` (or `npm run artifact-data -- <result.json>`) to execute the named SQLite JSON queries against any selected schema-v1 or schema-v2 result. The output records the source's absolute path, result ID, schema version, and SHA-256 so derived rows remain traceable to exact raw input. The queries emit performance per lane, dependency exposure once per module, feature and transport capability evidence once per module, and a transport-lane inventory without join multiplication.

For publication, record identified idle Windows and Linux hosts with exact Node and package versions and at least four complete cycles per selected cohort. Report uncertainty within each transport cohort and retain the raw JSON; do not pool transport cohorts into an overall rank.
