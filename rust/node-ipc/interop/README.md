# Node/Rust TCP interoperability and performance harness

Run every command in this guide from the repository root.

## Raw ping-pong example

For a plain one-message example with the exact framed JSON shown on both sides,
use the mixed-language `examples/nodeRustInterop/` folder. It supports either
runtime as the server or client.

```powershell
cargo run --manifest-path rust/node-ipc/Cargo.toml --example nodeRustInterop -- server
```

```powershell
node ./rust/node-ipc/examples/nodeRustInterop/node-peer.js client
```

Swap `server` and `client` between the two commands to run Rust to Node. The
visible `\f` at the end of each `SEND RAW` and `RECV RAW` line represents the
default node-ipc form-feed frame delimiter. This example reports no timing or
throughput data.

This harness sends the normal node-ipc wire envelope in both directions:

```text
{"type":"node-ipc.bench.request","data":{"sequence":0,"payload":"xxx"}}\f
```

The server validates each request and returns the same `data` under
`node-ipc.bench.response`. The client validates every response before reporting
latency or throughput. The Rust peer uses the crate's public TCP and codec APIs;
the Node peer imports this checkout's `node-ipc.js`. Neither harness adds a
dependency or a second protocol wrapper.

These are examples and measurement tools, not a substitute for the required
Rust `vanilla-test` correctness suite.

For the focused JavaScript `vanilla-test` interoperability suite, run:

```powershell
node ./rust/node-ipc/interop/vanilla-test.js
```

It builds the dependency-free Rust example once, then validates five sequential
ping-pong messages with a 17-byte payload in both directions: Node client to
Rust server and Rust client to Node server. The suite uses debug builds because
this is a correctness gate, not performance evidence; the measurement commands
below still require `--release`.

## Common command-line contract

Both peers accept the same options:

```text
--mode <server|client>
--host <address>          default: 127.0.0.1
--port <number>           default: 9763
--warmup <count>          default: 1000
--count <count>           default: 100000
--payload-bytes <count>   default: 64
--inflight <count>        default: 1
--json
```

The server and client must receive matching `warmup`, `count`, and
`payload-bytes` values. A server accepts one connection and exits after the
expected frames have been validated and echoed. `--json` emits one JSON object
per line using schema `node-ipc-roundtrip-v1`. Numeric arguments use unsigned
decimal notation and are capped at JavaScript's safe-integer range.

Use `--inflight 1` for round-trip latency. Use a bounded pipeline such as
`--inflight 64` for throughput. Always build the Rust example with `--release`
before treating its timings as performance evidence. The peers intentionally
have no second, competing timeout policy; automation must impose an external
process deadline so a missing or stalled peer cannot hang a run indefinitely.

## Rust server, Node client

Terminal 1:

```powershell
cargo run --release --manifest-path rust/node-ipc/Cargo.toml --example tcp_roundtrip -- --mode server --warmup 1000 --count 100000 --payload-bytes 64 --inflight 1
```

Terminal 2:

```powershell
node ./rust/node-ipc/interop/node-peer.js --mode client --warmup 1000 --count 100000 --payload-bytes 64 --inflight 1
```

## Node server, Rust client

Terminal 1:

```powershell
node ./rust/node-ipc/interop/node-peer.js --mode server --warmup 1000 --count 100000 --payload-bytes 64 --inflight 1
```

Terminal 2:

```powershell
cargo run --release --manifest-path rust/node-ipc/Cargo.toml --example tcp_roundtrip -- --mode client --warmup 1000 --count 100000 --payload-bytes 64 --inflight 1
```

## Same-language baselines

Run the same server/client pairing with two Rust processes and then two Node
processes. Those baselines separate wire interoperability from client/server
role costs. Change the port when running pairings concurrently.

For machine-readable evidence, append `--json` to both processes and retain the
client's completed result plus the server's `listening` and `complete` JSONL
records. Only the client record is a performance measurement. Server duration
is a liveness diagnostic because the two runtimes use different server timing
boundaries. `wire_bytes_per_second` counts application envelope and delimiter
bytes in both directions; it excludes TCP/IP and link-layer overhead.

Record the OS, CPU, Node version, Rust version, release profile, payload size,
pipeline depth, warmup, measured count, and external deadline with any
published comparison.
