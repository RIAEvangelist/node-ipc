# Node IPC transport-lane comparison

## Technical summary

- This Windows result contains 510 successful fresh-process samples across 13 measured transport lanes and 4 transport cohorts: Dedicated parent-child IPC, TCP loopback, Local IPC, and Authenticated TLS loopback.
- Performance is descriptive at the transport-lane level. No global, cross-transport, within-transport, or transport-effect ranking is eligible from this noisy snapshot.
- Capability fit, module-level dependency exposure, and lane-aware implementation glue are reported separately; they are not combined into a composite score.

## Post-warm-up throughput by transport cohort

### Dedicated parent-child IPC cohort — Throughput (round trips/s)

| Transport lane | Module | Protocol stack | 64 B | 4 KiB | 64 KiB |
| --- | --- | --- | ---: | ---: | ---: |
| Node child_process IPC | Node child_process IPC | node:child_process → platform IPC channel | 109,380 | 51,271 | 5,262 |

Values are medians across 1 successful fresh-process sample per available cell; — means no successful measurement was recorded.

This one-lane process IPC cohort is a descriptive baseline only. It has no same-transport comparator, so no ordinal result is calculated.

### TCP loopback cohort — Throughput (round trips/s)

| Transport lane | Module | Protocol stack | 64 B | 4 KiB | 64 KiB |
| --- | --- | --- | ---: | ---: | ---: |
| Node net over TCP | Node net | node:net → TCP4 loopback | 85,609 | 44,055 | 3,759 |
| node-ipc over TCP | node-ipc 14.0.0 | node-ipc fast framing → node:net → TCP4 loopback | 81,737 | 43,584 | 3,984 |
| ws over TCP | ws 8.21.3 | WebSocket → HTTP/1.1 → TCP4 loopback | 73,775 | 29,936 | 2,579 |
| Socket.IO over TCP | Socket.IO 4.8.3 stack | Socket.IO → Engine.IO → WebSocket → HTTP/1.1 → TCP4 loopback | 66,631 | 26,157 | 2,442 |
| ZeroMQ over TCP | ZeroMQ.js 6.6.0 | ZeroMQ → ZMTP → TCP4 loopback | 134,091 | 48,216 | 4,088 |

Values are medians across 10 successful fresh-process samples per available cell; — means no successful measurement was recorded.

### Local IPC cohort — Throughput (round trips/s)

| Transport lane | Module | Protocol stack | 64 B | 4 KiB | 64 KiB |
| --- | --- | --- | ---: | ---: | ---: |
| Node net over local IPC | Node net | node:net → windows-named-pipe | 350,255 | 60,711 | 3,641 |
| node-ipc over local IPC | node-ipc 14.0.0 | node-ipc fast framing → node:net → windows-named-pipe | 313,105 | 59,579 | 4,085 |
| ws over local IPC | ws 8.21.3 | WebSocket → HTTP/1.1 → windows-named-pipe | 206,659 | 27,663 | 1,710 |

Values are medians across 6 successful fresh-process samples per available cell; — means no successful measurement was recorded.

### Authenticated TLS loopback cohort — Throughput (round trips/s)

| Transport lane | Module | Protocol stack | 64 B | 4 KiB | 64 KiB |
| --- | --- | --- | ---: | ---: | ---: |
| Node TLS | Node tls | node:tls → TLS 1.3 → TCP4 loopback | 229,255 | 45,534 | 3,623 |
| node-ipc over TLS | node-ipc 14.0.0 | node-ipc fast framing → node:tls → TLS 1.3 → TCP4 loopback | 224,831 | 45,491 | 2,506 |
| ws over TLS | ws 8.21.3 | WebSocket → HTTPS → TLS 1.3 → TCP4 loopback | 155,576 | 23,645 | 1,497 |
| Socket.IO over TLS | Socket.IO 4.8.3 stack | Socket.IO → Engine.IO → WebSocket → HTTPS → TLS 1.3 → TCP4 loopback | 96,884 | 22,146 | 1,522 |

Values are medians across 4 successful fresh-process samples per available cell; — means no successful measurement was recorded.

Higher is faster within the same cohort and payload cell. The workload keeps up to 64 requests and no more than 8 MiB of canonical application payload outstanding. Application MiB/s counts the request payload once per completed round trip, not both request and echo.

## Post-warm-up round-trip latency by transport cohort

### Dedicated parent-child IPC cohort — Latency (p50 RTT, µs)

| Transport lane | Module | Protocol stack | 64 B | 4 KiB | 64 KiB |
| --- | --- | --- | ---: | ---: | ---: |
| Node child_process IPC | Node child_process IPC | node:child_process → platform IPC channel | 24.9 | 36.3 | 269.4 |

Values are medians across 1 successful fresh-process sample per available cell; — means no successful measurement was recorded.

This one-lane process IPC cohort is a descriptive baseline only. It has no same-transport comparator, so no ordinal result is calculated.

### TCP loopback cohort — Latency (p50 RTT, µs)

| Transport lane | Module | Protocol stack | 64 B | 4 KiB | 64 KiB |
| --- | --- | --- | ---: | ---: | ---: |
| Node net over TCP | Node net | node:net → TCP4 loopback | 34.8 | 51.5 | 300.2 |
| node-ipc over TCP | node-ipc 14.0.0 | node-ipc fast framing → node:net → TCP4 loopback | 35.0 | 50.7 | 309.6 |
| ws over TCP | ws 8.21.3 | WebSocket → HTTP/1.1 → TCP4 loopback | 50.5 | 76.2 | 525.3 |
| Socket.IO over TCP | Socket.IO 4.8.3 stack | Socket.IO → Engine.IO → WebSocket → HTTP/1.1 → TCP4 loopback | 57.0 | 95.0 | 538.8 |
| ZeroMQ over TCP | ZeroMQ.js 6.6.0 | ZeroMQ → ZMTP → TCP4 loopback | 89.0 | 125.5 | 479.7 |

Values are medians across 10 successful fresh-process samples per available cell; — means no successful measurement was recorded.

### Local IPC cohort — Latency (p50 RTT, µs)

| Transport lane | Module | Protocol stack | 64 B | 4 KiB | 64 KiB |
| --- | --- | --- | ---: | ---: | ---: |
| Node net over local IPC | Node net | node:net → windows-named-pipe | 24.1 | 37.9 | 236.8 |
| node-ipc over local IPC | node-ipc 14.0.0 | node-ipc fast framing → node:net → windows-named-pipe | 24.5 | 38.4 | 245.9 |
| ws over local IPC | ws 8.21.3 | WebSocket → HTTP/1.1 → windows-named-pipe | 29.1 | 66.1 | 462.1 |

Values are medians across 6 successful fresh-process samples per available cell; — means no successful measurement was recorded.

### Authenticated TLS loopback cohort — Latency (p50 RTT, µs)

| Transport lane | Module | Protocol stack | 64 B | 4 KiB | 64 KiB |
| --- | --- | --- | ---: | ---: | ---: |
| Node TLS | Node tls | node:tls → TLS 1.3 → TCP4 loopback | 39.6 | 60.0 | 313.4 |
| node-ipc over TLS | node-ipc 14.0.0 | node-ipc fast framing → node:tls → TLS 1.3 → TCP4 loopback | 39.1 | 54.0 | 330.8 |
| ws over TLS | ws 8.21.3 | WebSocket → HTTPS → TLS 1.3 → TCP4 loopback | 47.1 | 99.0 | 591.5 |
| Socket.IO over TLS | Socket.IO 4.8.3 stack | Socket.IO → Engine.IO → WebSocket → HTTPS → TLS 1.3 → TCP4 loopback | 62.0 | 127.6 | 624.6 |

Values are medians across 4 successful fresh-process samples per available cell; — means no successful measurement was recorded.

Lower is faster within the same cohort and payload cell. Latency uses exactly one request in flight and sender-side monotonic RTT timing. p95, p99, maximum, and every per-sample latency summary remain in the raw JSON.

## Measured transport-lane inventory

| Transport lane | Module | Transport cohort | Topology | Serialization | Security mode |
| --- | --- | --- | --- | --- | --- |
| Node child_process IPC | Node child_process IPC | Dedicated parent-child IPC | parent to direct child | Node JSON IPC serialization | platform process IPC; no benchmark-layer encryption |
| Node net over TCP | Node net | TCP loopback | unrelated processes | canonical JSON with newline framing | none |
| Node net over local IPC | Node net | Local IPC | unrelated processes | canonical JSON with newline framing | platform endpoint permissions; no benchmark-layer encryption |
| Node TLS | Node tls | Authenticated TLS loopback | unrelated processes | canonical JSON with newline framing | mutual TLS 1.3 with CA peer verification |
| node-ipc over TCP | node-ipc 14.0.0 | TCP loopback | unrelated processes | node-ipc fast event framing | none |
| node-ipc over local IPC | node-ipc 14.0.0 | Local IPC | unrelated processes | node-ipc fast event framing | platform endpoint permissions; no benchmark-layer encryption |
| node-ipc over TLS | node-ipc 14.0.0 | Authenticated TLS loopback | unrelated processes | node-ipc fast event framing | mutual TLS 1.3 with CA peer verification |
| ws over TCP | ws 8.21.3 | TCP loopback | unrelated processes | canonical JSON over WebSocket text messages | none |
| ws over local IPC | ws 8.21.3 | Local IPC | unrelated processes | canonical JSON over WebSocket text messages | platform endpoint permissions; no benchmark-layer encryption |
| ws over TLS | ws 8.21.3 | Authenticated TLS loopback | unrelated processes | canonical JSON over WebSocket text messages | mutual TLS 1.3 with CA peer verification |
| Socket.IO over TCP | Socket.IO 4.8.3 stack | TCP loopback | unrelated processes | Socket.IO event serialization | none |
| Socket.IO over TLS | Socket.IO 4.8.3 stack | Authenticated TLS loopback | unrelated processes | Socket.IO event serialization | mutual TLS 1.3 with CA peer verification |
| ZeroMQ over TCP | ZeroMQ.js 6.6.0 | TCP loopback | unrelated processes | canonical JSON over ZMTP | none |

A lane is a concrete module × transport × protocol-stack implementation. Transport coverage marked supported but not measured, unsupported, or not implemented is evidence about scope—not a failed benchmark sample.

## Transport support and measurement scope

| Module | Direct process IPC | TCP loopback | Local endpoint (Windows named pipe / POSIX UDS) | Authenticated TLS |
| --- | --- | --- | --- | --- |
| Node child_process IPC | measured — Measured through the dedicated channel created by child_process.fork(). | unsupported — The child-process message channel is not a TCP transport. | unsupported — Its internal platform pipe is not exposed as a general named-pipe or UDS endpoint. | unsupported — The child-process message channel has no TLS transport API. |
| Node net | unsupported — node:net can be wired between related processes but does not create the dedicated fork channel. | measured — Measured with node:net over TCP loopback. | measured — Measured with a Windows named pipe or POSIX Unix-domain socket selected by platform. | unsupported — Authenticated TLS is represented by the separate native-tls module row. |
| Node tls | unsupported — node:tls does not create a dedicated parent-child message channel. | unsupported — This module row represents authenticated TLS, not the plaintext TCP cohort. | not-implemented — TLS can wrap an existing stream, but TLS-over-local endpoints are outside the executable local cohort. | measured — Measured as the native authenticated TLS baseline over loopback TCP. |
| node-ipc 14.0.0 | unsupported — node-ipc uses its socket client/server API rather than the dedicated child_process channel. | measured — Measured with the Fast profile over TCP loopback. | measured — Measured over a Windows named pipe or POSIX Unix-domain socket selected by platform. | measured — Measured with the Fast profile over authenticated TLS; this is distinct from the Assured parser profile. |
| ws 8.21.3 | unsupported — WebSocket does not use the dedicated child_process message channel. | measured — Measured as WebSocket over TCP loopback. | measured — The pinned API documents ws+unix URLs for POSIX UDS and Windows named pipes. | measured — Measured as WSS over an authenticated HTTPS/TLS server. |
| Socket.IO 4.8.3 stack | unsupported — Socket.IO does not use the dedicated child_process message channel. | measured — Measured over a forced WebSocket transport on TCP loopback with upgrade and reconnect disabled. | not-implemented — No portable first-class named-pipe or UDS client lane is documented; a custom Engine.IO transport would change the implementation under test. | measured — Measured over forced WSS with certificate trust and server-identity validation configured. |
| ZeroMQ.js 6.6.0 | unsupported — ZeroMQ sockets do not use the dedicated child_process message channel. | measured — Measured as ZMTP over TCP loopback with DEALER/ROUTER sockets. | supported-not-measured — ipc:// uses Unix-domain sockets and is not a Windows named-pipe transport; it is outside the executable local cohort. | unsupported — ZeroMQ CURVE is a distinct security mechanism, not authenticated TLS. |

“Measured” identifies an executable lane in this result schema. Supported-but-unmeasured, unsupported, and not-implemented cells describe suite scope and are not failed trials.

## Dependency exposure is counted once per module

| Module | Direct dependency name count | Direct edges | Unique resolved production dependencies | Exposure tier | Install-script packages |
| --- | ---: | ---: | ---: | --- | --- |
| Node child_process IPC | 0 | 0 | 0 | minimal | none |
| Node net | 0 | 0 | 0 | minimal | none |
| Node tls | 0 | 0 | 0 | minimal | none |
| node-ipc 14.0.0 | 3 | 3 | 5 | low | none |
| ws 8.21.3 | 0 | 0 | 0 | minimal | none |
| Socket.IO 4.8.3 stack | 9 | 11 | 23 | high | none |
| ZeroMQ.js 6.6.0 | 2 | 2 | 2 | low | zeromq@6.6.0 |

A module with several measured transports appears once: its pinned production dependency closure is not multiplied by lane count. The tier uses only unique resolved production dependency count (0 minimal, 1–5 low, 6–15 moderate, 16+ high). This is a dependency-count supply-chain proxy, not a vulnerability, provenance, maintainer, or code-quality assessment. Native Node has zero external npm dependencies, not zero total supply-chain risk.

## Implementation-glue complexity is lane-aware

| Transport lane | Module | Adapter SLOC | Files | Bytes | Source |
| --- | --- | ---: | ---: | ---: | --- |
| Node child_process IPC | Node child_process IPC | 92 | 1 | 2485 | adapters/native-child-process.js |
| Node net over TCP | Node net | 114 | 1 | 3635 | adapters/native-net.js |
| Node net over local IPC | Node net | 114 | 1 | 3635 | adapters/native-net.js |
| Node TLS | Node tls | 124 | 1 | 3836 | adapters/native-tls.js |
| node-ipc over TCP | node-ipc 14.0.0 | 130 | 1 | 4124 | adapters/node-ipc.js |
| node-ipc over local IPC | node-ipc 14.0.0 | 130 | 1 | 4124 | adapters/node-ipc.js |
| node-ipc over TLS | node-ipc 14.0.0 | 130 | 1 | 4124 | adapters/node-ipc.js |
| ws over TCP | ws 8.21.3 | 137 | 1 | 4606 | adapters/ws.js |
| ws over local IPC | ws 8.21.3 | 137 | 1 | 4606 | adapters/ws.js |
| ws over TLS | ws 8.21.3 | 137 | 1 | 4606 | adapters/ws.js |
| Socket.IO over TCP | Socket.IO 4.8.3 stack | 129 | 1 | 4203 | adapters/socket-io.js |
| Socket.IO over TLS | Socket.IO 4.8.3 stack | 129 | 1 | 4203 | adapters/socket-io.js |
| ZeroMQ over TCP | ZeroMQ.js 6.6.0 | 71 | 1 | 1941 | adapters/zeromq.js |

SLOC counts nonblank, noncomment subject-specific benchmark adapter code. Shared harness code is excluded. When one adapter implements several lanes, the recorded module-level value is shown for each lane; it is an auditable glue proxy, not intrinsic API difficulty.

## Capability support is evaluated before performance

| Module | Built in or supported | Manual, separate, or limited | Unsupported or unverified |
| --- | --- | --- | --- |
| Node child_process IPC | Direct parent-child IPC; Socket/server handle passing | Unix socket / Windows named pipe (internal); Named events (manual); Request/reply primitive (manual); Broadcast or pub/sub (manual); Automatic reconnect (manual); Queueing / backpressure controls (manual) | Unrelated local processes; Remote TCP/IP; UDP4 / UDP6; Authenticated encrypted transport; Browser-compatible client; Cross-language protocol |
| Node net | Unrelated local processes; Remote TCP/IP; Unix socket / Windows named pipe; Queueing / backpressure controls | Direct parent-child IPC (manual); UDP4 / UDP6 (separate-core-module); Authenticated encrypted transport (separate-core-module); Named events (manual); Request/reply primitive (manual); Broadcast or pub/sub (manual); Automatic reconnect (manual); Cross-language protocol (manual) | Browser-compatible client; Socket/server handle passing |
| Node tls | Unrelated local processes; Remote TCP/IP; Authenticated encrypted transport; Queueing / backpressure controls; Cross-language protocol | Direct parent-child IPC (manual); Unix socket / Windows named pipe (manual); Named events (manual); Request/reply primitive (manual); Broadcast or pub/sub (manual); Automatic reconnect (manual) | UDP4 / UDP6; Browser-compatible client; Socket/server handle passing |
| node-ipc 14.0.0 | Direct parent-child IPC; Unrelated local processes; Remote TCP/IP; Unix socket / Windows named pipe; UDP4 / UDP6; Authenticated encrypted transport; Named events; Broadcast or pub/sub; Automatic reconnect; Cross-language protocol | Request/reply primitive (manual); Queueing / backpressure controls (profile-dependent) | Browser-compatible client; Socket/server handle passing |
| ws 8.21.3 | Direct parent-child IPC; Unrelated local processes; Remote TCP/IP; Unix socket / Windows named pipe; Authenticated encrypted transport; Browser-compatible client; Cross-language protocol | Named events (manual); Request/reply primitive (manual); Broadcast or pub/sub (manual); Automatic reconnect (manual); Queueing / backpressure controls (manual) | UDP4 / UDP6; Socket/server handle passing |
| Socket.IO 4.8.3 stack | Direct parent-child IPC; Unrelated local processes; Remote TCP/IP; Authenticated encrypted transport; Named events; Request/reply primitive; Broadcast or pub/sub; Automatic reconnect; Queueing / backpressure controls; Browser-compatible client; Cross-language protocol | — | Unix socket / Windows named pipe; UDP4 / UDP6; Socket/server handle passing |
| ZeroMQ.js 6.6.0 | Direct parent-child IPC; Unrelated local processes; Remote TCP/IP; Authenticated encrypted transport; Request/reply primitive; Broadcast or pub/sub; Automatic reconnect; Queueing / backpressure controls; Cross-language protocol | Unix socket / Windows named pipe (platform-limited); UDP4 / UDP6 (partial); Named events (manual) | Browser-compatible client; Socket/server handle passing |

Capability cells are version-specific and source-linked in the raw result. “Manual” means the transport can carry an application implementation; it does not mean the module supplies that feature.

## Scope, data, and metric definitions

- Snapshot generated August 24, 2026 at 12:29 AM (America/Chicago; CDT) on Windows (win32/x64), Node v24.18.0, Intel(R) Core(TM) Ultra 9 275HX (24 logical processors).
- Payload matrix: 64 B, 4 KiB, 64 KiB exact canonical JSON bytes. Each message is `{"payload":"…","sequence":"00000000"}`; the ASCII payload length is adjusted so the whole JSON message is exactly the stated size.
- Every sample creates a fresh driver process and echo peer. Startup, connection negotiation, correctness probing, and warm-up are outside the timed measurement; cold-start observations remain in the raw result.
- Throughput counts completed request/echo round trips with bounded pipelining. The 8 MiB cap covers canonical application request payload only; framing and serialization overhead are outside the cap. Application MiB/s counts request payload once per RTT.
- Latency keeps one request in flight and reports sender-side RTT percentiles. Timed replies verify exact sequence, encoded size, and payload content.
- Failed or timed-out trials remain failures. Successful samples must exit naturally, leave no private temporary artifacts, and close/release their endpoint.

## Experimental order and auditability

- Dedicated parent-child IPC: 1 cohort-local block for one descriptive lane; order balancing is not applicable.
- TCP loopback: 10 cohort-local blocks across 5 lanes. The deterministic Williams-derived cycle is 10 blocks; exact position and first-order carryover balance applies only to complete cycles, which this configuration contains.
- Local IPC: 6 cohort-local blocks across 3 lanes. The deterministic Williams-derived cycle is 6 blocks; exact position and first-order carryover balance applies only to complete cycles, which this configuration contains.
- Authenticated TLS loopback: 4 cohort-local blocks across 4 lanes. The deterministic Williams-derived cycle is 4 blocks; exact position and first-order carryover balance applies only to complete cycles, which this configuration contains.
- Throughput and latency use separate fresh-process trials. Complete-cycle requirements describe order balance only; they do not make a local noisy snapshot inferential evidence.
- The raw JSON preserves every sample and the reported distributions (median, IQR, MAD, minimum, and maximum); the renderer does not discard timing outliers.

## Limitations

- This result is classified `local-snapshot-noisy`; repository state at capture was clean. Host load, scheduler state, power state, and page-cache state are uncontrolled.
- Transport cohorts have different topology, framing, security, and protocol semantics. Values from different cohorts are not exchangeable and must not be used as a leaderboard.
- A singleton process IPC cohort is useful as a descriptive baseline but cannot support an ordinal comparison. One local snapshot cannot estimate a transport effect.
- Results are host-, OS-, Node-version-, package-version-, endpoint-implementation-, and power-state-specific. Publication evidence should use identified idle Windows and Linux hosts and repeated complete cohort cycles.

## Recommended next steps

1. Filter modules and transport lanes by required topology, security, browser/cross-language interoperability, reconnect, backpressure, and binary semantics before examining timing.
2. For publication evidence, record at least four complete cycles per cohort (Dedicated parent-child IPC 4; TCP loopback 40; Local IPC 24; Authenticated TLS loopback 16) on each identified host; report uncertainty without pooling transports.
3. Treat dependency count, install scripts/native addons, capability support, and implementation-glue SLOC as separate decision dimensions.

## Source and artifact inventory

- Raw result: [windows-node24-transports-20260824.json](results/windows-node24-transports-20260824.json)
- Validation and rendering: `validate.js` and `render-report.js`.
- Reproducible artifact data: `node artifact-data.js <result.json>` executes the named SQLite queries in `artifact-queries.sql` against the selected raw result and records its path, schema version, ID, and SHA-256.
- Benchmark implementation: `run.js`, `worker.js`, `peer.js`, `protocol.js`, `plan.js`, `dependencies.js`, `complexity.js`, `lanes.js`, and `adapters/`.
- https://nodejs.org/download/release/v24.18.0/docs/api/child_process.html
- https://nodejs.org/download/release/v24.18.0/docs/api/net.html
- https://nodejs.org/download/release/v24.18.0/docs/api/dgram.html
- https://nodejs.org/download/release/v24.18.0/docs/api/tls.html
- https://github.com/RIAEvangelist/node-ipc/blob/9bdeca134d4b98ac4c3a819d06fa81fed8170be7/README.md
- https://github.com/websockets/ws/blob/8.21.3/README.md
- https://github.com/websockets/ws/blob/8.21.3/doc/ws.md#ipc-connections
- https://github.com/websockets/ws/blob/8.21.3/README.md#external-https-server
- https://socket.io/docs/v4/
- https://socket.io/docs/v4/client-options/#transports
- https://socket.io/docs/v4/server-initialization/
- https://socket.io/docs/v4/emitting-events/
- https://socket.io/docs/v4/rooms/
- https://socket.io/docs/v4/client-options/
- https://socket.io/docs/v4/client-offline-behavior/
- https://github.com/socketio/socket.io/blob/socket.io-client%404.8.3/packages/socket.io-client/package.json
- https://socket.io/docs/v4/socket-io-protocol/
- https://github.com/zeromq/libzmq/blob/v4.3.5/doc/zmq_socket.txt
- https://github.com/zeromq/libzmq/blob/v4.3.5/doc/zmq_ipc.txt
- https://github.com/zeromq/libzmq/blob/v4.3.5/doc/zmq_udp.txt
- https://github.com/zeromq/libzmq/blob/v4.3.5/doc/zmq_curve.txt
- https://github.com/zeromq/zeromq.js/blob/v6.6.0/src/index.ts
- https://github.com/zeromq/zeromq.js/blob/v6.6.0/package.json
- https://rfc.zeromq.org/spec/23/
