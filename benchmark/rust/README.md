# Rust and Node TCP benchmark

This harness compares the same validated node-ipc round trip across four
client-to-server lanes:

1. `node-node`
2. `node-rust`
3. `rust-node`
4. `rust-rust`

It reuses `rust/node-ipc/interop/node-peer.js` and the release build of
`rust/node-ipc/examples/tcp_roundtrip.rs`. It adds no benchmark protocol and no
runtime dependency.

## Quick smoke

```text
node benchmark/rust/test.js
node benchmark/rust/run.js --quick > quick.json
node benchmark/rust/validate.js quick.json
```

Quick mode runs one small sample per lane. It validates orchestration, framing,
counts, cleanup, memory collection, package measurement, and the result schema.
Its timings are smoke output only and must not be published as performance
evidence.

## Full evidence

Full mode is fixed:

| Setting | Value |
| --- | ---: |
| Validated round trips per sample | 1,000,000 |
| Warm-up round trips | 100,000 |
| Payload | 64 bytes |
| Maximum in flight | 64 |
| Samples per lane | 5 |
| Total samples | 20 |

The client timer covers the measured phase only. Compilation, process startup,
warm-up, package measurement, garbage collection, and cleanup are outside that
timer. Server completion and final frame count are retained as liveness
diagnostics.

Tracked recording requires GitHub Actions on clean committed `main` and an
explicit artifact directory:

```text
node benchmark/rust/record.js --full --output-directory=<artifact-directory>
```

The runner automatically re-executes itself with Node garbage collection
exposed. Every sample then starts fresh client and server processes, performs
orchestrator collection before launch, uses a newly reserved loopback port, and
runs in a new isolated temporary directory. This is a repeatable process
baseline; it does not claim to flush operating-system caches or erase unrelated
system load.

## Exactness and cleanup

Each server must emit exactly `listening` then `complete`. Each client must emit
exactly one `node-ipc-roundtrip-v1` result. The harness verifies language, role,
host, reserved port, warm-up, measured count, payload, inflight window, final
server frame count, latency ordering, and wire bytes reconstructed from the
canonical event envelopes.

For every sample it also requires:

- both peers to reach `close` naturally with code zero and no signal;
- no unexpected standard error or non-JSON standard output;
- both exact peer process IDs to be absent after close;
- the exact TCP endpoint to bind again after peer exit;
- no tracked child process or harness socket to remain;
- no file in the sample-specific temporary directory; and
- bounded graceful termination followed by bounded forced termination only on
  a failing run.

A requested termination makes the run fail; accepted full evidence always has
zero forced processes. TCP `TIME_WAIT` is kernel protocol state and is not
reported as an owned socket leak.

The port reservation is closed immediately before the server binds because the
existing Node peer cannot accept an already-open listener. The endpoint rebind
gate detects leaks; it does not remove the small reserve-to-bind race inherent
in that contract.

## Memory and package footprint

The orchestrator samples child resident memory without dependencies:

- Linux: `/proc/<pid>/status` `VmRSS`;
- macOS: `/bin/ps` RSS; and
- Windows: PowerShell `Get-Process` working set.

These values are labelled sampled maxima, not exact lifetime peaks. Sampling is
outside the peer hot path but runs concurrently with the process, so use it for
footprint comparison rather than micro-timing claims. A process has no RSS after
exit; the result records post-exit RSS as unavailable and separately proves
that each PID is gone. Orchestrator RSS before collection, after collection,
and after sample cleanup is retained as supporting evidence.

`npm pack --dry-run` supplies npm compressed/unpacked size, file count, SHA-1,
and integrity. `cargo package` runs in the owned temporary root and supplies the
crate byte size, file count, and SHA-256. The release Rust binary and both peer
sources are also hashed.

## Result and append-only merge

`result-schema.json` identifies schema `node-ipc-rust-benchmark-v1`. A result
contains raw samples, recomputed lane medians, exact configuration, package
footprints, sanitized machine/runtime provenance, pre/post Git state, and
cleanup evidence. Ports, process IDs, hostnames, usernames, and absolute paths
are not retained.

Validate publishable full evidence with:

```text
node benchmark/rust/validate.js --tracked <artifact-directory>
```

Merge one complete Windows/Linux/macOS GitHub Actions batch with:

```text
node benchmark/rust/merge.js \
  --input-directory=<downloaded-artifacts> \
  --output-directory=<tracked-results>
```

The merge rejects quick, dirty, partial, mixed-runtime, duplicate, or symlinked
evidence. Before appending, it revalidates the complete retained inventory,
every result, every SHA-256, and every regenerated manifest entry. Existing
manifest entries remain an exact prefix. A validated candidate is installed
with exclusive result creation, atomic manifest replacement, and rollback on
failure.

Accepted history lives in `benchmark/rust-results/`. Validate it and regenerate
the fixed-order chart with:

```text
npm run benchmark:rust:validate:tracked
npm run benchmark:rust:chart
npm run benchmark:rust:chart:check
```

The chart reads only the newest complete three-platform batch. It preserves
Linux, macOS, Windows and Node→Node, Node→Rust, Rust→Node, Rust→Rust order; it
does not sort by timing or claim a cross-platform ranking.
