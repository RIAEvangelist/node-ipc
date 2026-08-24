# Node IPC end-to-end comparison

## Technical summary

- **The measured node-ipc fast-profile result completed 86,042 64 B round trips/s in this local Windows snapshot.** It placed 4 of 6 for that cell, but the subjects use different transports and the result is not an overall product ranking.
- **Unique resolved production dependency exposure ranges from 0 to 23 packages.** Node child_process IPC, Node net, and ws 8.21.3 (0); ZeroMQ.js 6.6.0 (2); node-ipc 14.0.0 (5); Socket.IO 4.8.3 stack (23). Counts come from the pinned production lockfile closures.
- **Adapter complexity ranges from 66 to 102 nonblank, noncomment lines.** This measures subject-specific benchmark glue for both endpoints, not intrinsic API difficulty.
- **Capability breadth changes the decision.** The version-specific matrix separates built-in or supported capabilities from manual, limited, unsupported, and unverified behavior; filter by requirements before comparing performance.

## Throughput varies materially by transport and abstraction

| Subject | 64 B | 4 KiB | 64 KiB |
| --- | ---: | ---: | ---: |
| Node child_process IPC | 126,733 | 58,337 | 5,311 |
| Node net | 91,591 | 45,499 | 3,873 |
| node-ipc 14.0.0 | 86,042 | 45,762 | 3,960 |
| Socket.IO 4.8.3 stack | 69,837 | 28,824 | 2,546 |
| ws 8.21.3 | 77,490 | 30,550 | 2,832 |
| ZeroMQ.js 6.6.0 | 129,669 | 50,532 | 4,168 |

Values are median round trips/s across 6 fresh-process samples per available cell. Unavailable cells are shown as —.

Higher is faster. The throughput workload keeps up to 64 requests and no more than 8 MiB of canonical application payload outstanding, then counts completed echoes. Transport framing and serialization overhead are not part of that cap. Application MiB/s counts the request payload once per completed round trip, not both request and echo.

## Sequential post-warm-up round-trip latency shows response cost

| Subject | 64 B | 4 KiB | 64 KiB |
| --- | ---: | ---: | ---: |
| Node child_process IPC | 24.1 | 33.1 | 247.3 |
| Node net | 31.5 | 43.1 | 284.5 |
| node-ipc 14.0.0 | 32.9 | 44.1 | 280.8 |
| Socket.IO 4.8.3 stack | 49.9 | 87.5 | 520.0 |
| ws 8.21.3 | 37.8 | 69.3 | 493.7 |
| ZeroMQ.js 6.6.0 | 82.4 | 122.3 | 446.8 |

Values are median p50 RTT, µs across 6 fresh-process samples per available cell. Unavailable cells are shown as —.

Lower is faster. Latency uses exactly one request in flight and sender-side monotonic round-trip timing. p95, p99, maximum, and per-sample distributions remain in the raw JSON.

## Dependency exposure and implementation glue are independently auditable

| Subject | Direct dependency name count | Direct edges | Unique resolved dependencies | Exposure tier | Adapter SLOC |
| --- | ---: | ---: | ---: | --- | ---: |
| Node child_process IPC | 0 | 0 | 0 | minimal | 92 |
| Node net | 0 | 0 | 0 | minimal | 102 |
| node-ipc 14.0.0 | 3 | 3 | 5 | low | 80 |
| Socket.IO 4.8.3 stack | 9 | 11 | 23 | high | 66 |
| ws 8.21.3 | 0 | 0 | 0 | minimal | 89 |
| ZeroMQ.js 6.6.0 | 2 | 2 | 2 | low | 71 |

The exposure tier is intentionally based only on unique resolved production dependency count: 0 minimal, 1–5 low, 6–15 moderate, and 16+ high. It is not a vulnerability or maintainer-quality score. A zero external npm dependency count is not zero total supply-chain risk; install scripts and native addons are recorded separately in the raw result.

## Capability breadth—not a composite score—should drive fit

| Subject | Built in or supported | Manual, separate, or limited | Unsupported or unverified |
| --- | --- | --- | --- |
| Node child_process IPC | Direct parent-child IPC; Socket/server handle passing | Unix socket / Windows named pipe (internal); Named events (manual); Request/reply primitive (manual); Broadcast or pub/sub (manual); Automatic reconnect (manual); Queueing / backpressure controls (manual) | Unrelated local processes; Remote TCP/IP; UDP; Authenticated encrypted transport; Browser-compatible client; Cross-language protocol |
| Node net | Unrelated local processes; Remote TCP/IP; Unix socket / Windows named pipe; Queueing / backpressure controls | Direct parent-child IPC (manual); UDP (separate-core-module); Authenticated encrypted transport (separate-core-module); Named events (manual); Request/reply primitive (manual); Broadcast or pub/sub (manual); Automatic reconnect (manual); Cross-language protocol (manual) | Browser-compatible client; Socket/server handle passing |
| node-ipc 14.0.0 | Direct parent-child IPC; Unrelated local processes; Remote TCP/IP; Unix socket / Windows named pipe; UDP; Authenticated encrypted transport; Named events; Broadcast or pub/sub; Automatic reconnect; Cross-language protocol | Request/reply primitive (manual); Queueing / backpressure controls (profile-dependent) | Browser-compatible client; Socket/server handle passing |
| Socket.IO 4.8.3 stack | Direct parent-child IPC; Unrelated local processes; Remote TCP/IP; Authenticated encrypted transport; Named events; Request/reply primitive; Broadcast or pub/sub; Automatic reconnect; Queueing / backpressure controls; Browser-compatible client; Cross-language protocol | — | Unix socket / Windows named pipe; UDP; Socket/server handle passing |
| ws 8.21.3 | Direct parent-child IPC; Unrelated local processes; Remote TCP/IP; Unix socket / Windows named pipe; Authenticated encrypted transport; Browser-compatible client; Cross-language protocol | Named events (manual); Request/reply primitive (manual); Broadcast or pub/sub (manual); Automatic reconnect (manual); Queueing / backpressure controls (manual) | UDP; Socket/server handle passing |
| ZeroMQ.js 6.6.0 | Direct parent-child IPC; Unrelated local processes; Remote TCP/IP; Authenticated encrypted transport; Request/reply primitive; Broadcast or pub/sub; Automatic reconnect; Queueing / backpressure controls; Cross-language protocol | Unix socket / Windows named pipe (platform-limited); UDP (partial); Named events (manual) | Browser-compatible client; Socket/server handle passing |

Capability cells are version-specific and source-linked in the raw result. “Manual” means the transport can carry an application implementation; it does not mean the library supplies the feature.

## Scope, data, and metric definitions

- Snapshot generated August 23, 2026 at 9:52 PM CDT (America/Chicago) on Windows (win32/x64), Node v24.18.0, Intel(R) Core(TM) Ultra 9 275HX (24 logical processors).
- Payload matrix: 64 B, 4 KiB, 64 KiB exact canonical JSON bytes. Each message is `{"payload":"…","sequence":"00000000"}`; the ASCII payload length is adjusted so the whole JSON message is exactly the stated size.
- 6 independent samples per subject × payload × workload, 216 successful samples total.
- Throughput: completed request/echo round trips per second with bounded pipelining. The 8 MiB cap covers canonical application payload only, and application MiB/s counts the request payload once per completed round trip—not both request and echo. Latency: one-in-flight sender-side RTT percentiles.
- Startup, connection negotiation, the correctness probe, and warm-up are outside the timed measurement. Cold-start observations remain in the raw result.
- All subjects parse and re-emit the same logical object. Raw stream/WebSocket/ZMTP adapters explicitly decode and re-encode JSON; Node IPC, child IPC, and Socket.IO use their public message serialization.

## Methodology preserves fairness without pretending the transports are identical

- Every sample creates a fresh driver process and a fresh echo peer. The peer reports readiness and shutdown over stdio, so native child IPC is measured on its only IPC channel rather than sharing it with the harness control plane.
- A deterministic Williams-derived order reduces position and first-order carryover bias. Exact balance requires complete 6-row cycles; this 6-block snapshot completes whole cycles. Throughput and latency run in separate fresh-process trials.
- A content-and-sequence probe runs before warm-up. Timed messages still verify exact sequence, total encoded size, and payload content; failures, timeouts, duplicates, or reordering fail the sample.
- TCP endpoints must be closed and immediately reusable, peer and worker exits must be natural, and the private temporary directory must remain empty.
- `ws` compression and optional native accelerators are disabled. Socket.IO is forced to WebSocket without upgrade/reconnect. ZeroMQ uses DEALER/ROUTER so bounded pipelining is possible. node-ipc uses its default fast profile over loopback TCP.

## Limitations, uncertainty, and robustness checks

- This is classified `local-snapshot-noisy`; the repository state was dirty at capture. The result retains the commit and a status SHA-256 without publishing or characterizing changed paths.
- 6 samples are useful for a directional snapshot, not narrow confidence claims. The raw JSON preserves medians, IQR, MAD, min/max, and every sample; it does not delete timing outliers.
- The subjects intentionally retain their native transport semantics: platform IPC channel, TCP loopback, ZeroMQ over TCP loopback, WebSocket over TCP loopback, and Socket.IO over WebSocket and TCP loopback. A single overall “winner” would erase capability and topology differences.
- Only the common JSON request/echo lane is measured here. Binary/advanced-serialization, local Unix-domain socket, Windows named-pipe, TLS, UDP, broadcast, reconnect, multi-client scaling, CPU, and peak-RSS lanes remain future work.
- Results are host-, OS-, Node-version-, package-version-, and power-state-specific. Cross-platform publication should use clean commits on identified idle Windows and Linux machines with complete subject-count cycles.

## Recommended next steps

1. Use this suite as the reproducible common-denominator baseline, not as a universal leaderboard.
2. Add separate local-pipe and binary lanes where subjects genuinely support those semantics; keep them out of the TCP/JSON table.
3. Record clean Windows and Linux runs with at least 24 blocks (four complete 6-row cycles) before making narrow percentage claims.
4. Choose a solution by the minimum capability set first, then compare speed, adapter SLOC, and dependency exposure within that eligible set.

## Further questions

- Does the target require unrelated processes, remote hosts, browser clients, cross-language peers, UDP, authenticated encryption, or pub/sub?
- Is the dominant payload JSON or binary, and what are the real concurrency and backpressure limits?
- Should install scripts/native binaries count as a separate supply-chain dimension in addition to dependency count?

## Source and artifact inventory

- Raw result: [windows-node24-20260823.json](results/windows-node24-20260823.json)
- Reproducible code: `run.js`, `worker.js`, `peer.js`, `protocol.js`, `dependencies.js`, `complexity.js`, and `adapters/` in this directory.
- https://nodejs.org/download/release/v24.18.0/docs/api/child_process.html
- https://nodejs.org/download/release/v24.18.0/docs/api/net.html
- https://nodejs.org/download/release/v24.18.0/docs/api/dgram.html
- https://nodejs.org/download/release/v24.18.0/docs/api/tls.html
- https://github.com/RIAEvangelist/node-ipc/blob/9bdeca134d4b98ac4c3a819d06fa81fed8170be7/README.md
- https://github.com/websockets/ws/blob/8.21.3/README.md
- https://github.com/websockets/ws/blob/8.21.3/doc/ws.md#ipc-connections
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
- https://zeromq.github.io/zeromq.js/classes/Socket.html
- https://github.com/zeromq/zeromq.js/blob/v6.6.0/package.json
- https://rfc.zeromq.org/spec/23/
