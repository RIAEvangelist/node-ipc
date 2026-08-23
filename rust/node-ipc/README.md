# node-ipc for Rust

`node-ipc` is the zero-dependency Rust implementation of the canonical
node-ipc event envelope and delimiter framing. It is developed in the same
repository as the Node.js package so protocol changes, release records,
interoperability evidence, and performance evidence stay paired.

## Install

```toml
[dependencies]
node-ipc = "14.0.0"
```

The production crate requires Rust 1.85 or newer and has no third-party runtime
or build dependencies. Its packaged native correctness suite pins the
dependency-free `vanilla-test` 2.1.0 crate as its only development dependency.

## Blocking TCP quick start

```rust,no_run
use node_ipc::{tcp, CodecConfig, Connection, Event, Message};

fn main() -> node_ipc::Result<()> {
    let stream = tcp::connect(("127.0.0.1", 9763))?;
    let mut connection = Connection::new(stream, CodecConfig::fast())?;

    connection.send(&Event::new("example.request", "hello"))?;
    if let Some(Message::Event(response)) = connection.recv()? {
        println!(
            "{}: {}",
            response.event_type(),
            response.data.to_json_string()
        );
    }
    Ok(())
}
```

Servers use `tcp::bind` and `tcp::accept`, then wrap each accepted stream in a
`Connection`. The same `Connection<S>` works with Unix streams, Windows named
pipes, or an application-supplied TLS stream because `S` only needs `Read +
Write`.

## Examples

The crate ships native Rust counterparts for the repository's TCP, UDP,
Unix-socket/Windows-pipe, raw-buffer, ordered blocking, multi-client broadcast,
and Unix worker-sharing examples. It also ships a generic TLS-stream integration
boundary, because Rust's standard library cannot create a TLS session. The
[`examples/README.md`](examples/README.md) matrix maps the behavior folders and
documents those limits. A separate repository-only `nodeRustInterop` example
keeps the Node.js and Rust peers together and prints their exact framed messages
in either direction.

## Profiles and transports

| Profile or transport | Rust behavior |
| --- | --- |
| Raw | Passes bytes without framing, JSON parsing, or event validation. |
| Fast | Uses the canonical `{type,data}` JSON envelope and delimiter framing. |
| Guarded | Adds frame, event-name, reserved-name, backpressure, and incomplete-frame time limits. |
| Assured | Adds an event allow-list. Transport authentication remains the application's responsibility. |
| TCP | Blocking standard-library TCP with Nagle buffering disabled. |
| UDP | IPv4/IPv6 datagrams with independent fragment state per peer. Assured is rejected. |
| Unix local | Standard-library Unix streams plus conservative endpoint cleanup. |
| Windows local | Blocking byte-mode named pipes through narrow direct Win32 bindings. |
| TLS | Supply a verified TLS stream from the application; this crate does not include or reimplement cryptography. |

### Assured is a transport-plus-codec contract

`CodecConfig::assured(...)` validates the envelope, guarded limits, reserved
names, and event allow-list. It cannot prove who owns an arbitrary `Read +
Write` stream.

- Network Assured use requires caller-supplied, mutually authenticated TLS and
  application authorization. Plain TCP plus an Assured codec is not Assured.
- Unix Assured use requires an owner-only parent directory, an endpoint directly
  inside that directory, and client-side endpoint ownership verification. The
  local helpers do not establish those properties for the caller.
- The Windows pipe helper rejects remote clients and limits client
  impersonation, but still uses the operating system's default security
  descriptor. Do not treat it as Assured unless the application creates and
  verifies an appropriate ACL outside this crate.
- UDP cannot provide the required authenticated stream and is rejected for the
  Assured profile.

## Blocking timeout boundary

Guarded and Assured codecs measure incomplete-message time while the decoder has
control. A generic blocking `read` or `recv_from` cannot wake itself when that
deadline passes. Applications that require a hard wall-clock deadline must set
an operating-system read timeout (or use nonblocking polling) and call
`Connection::check_timeout` or `UdpEndpoint::check_timeouts` as appropriate.
The synchronous Windows named-pipe helper does not expose cancellation or a
read timeout and can block indefinitely in connect, accept, read, or flush;
supervise it from a deadline-aware thread or process when that boundary is
required.

UDP fragment retention is capped by default at 1,024 peers and 8 MiB across the
endpoint, with lower limits available through `set_fragment_limits`. A limit
hit rejects the incoming fragment with `ERR_IPC_BACKPRESSURE` and leaves other
retained peers intact. Guarded fragments expire at `message_timeout` when that
limit is enabled (30 seconds by default); Fast fragments have neither a timeout
nor a per-frame size limit, so use Guarded and rate limiting for untrusted UDP
traffic because source addresses can be spoofed. A blocking receive also
yields a backpressure error after 64 fragment-only datagrams without a complete
message; retained state remains available to the next call.

## Compatibility boundaries

Normal messages produced by either implementation interoperate. Rust keeps a
few deliberate, fail-closed boundaries for malformed or language-specific
values:

- Every framed Rust profile requires a JSON object with a string `type` and a
  present `data` field. This is stricter than Node Fast for malformed input and
  stricter than Node Guarded when `data` is absent.
- An empty framed UDP datagram returns a peer-scoped protocol error so a
  blocking receiver yields control; Raw UDP still delivers an empty datagram.
- Framed JSON must be valid UTF-8; malformed byte sequences are rejected rather
  than replaced.
- Rust strings contain Unicode scalar values, so the JSON parser rejects lone
  UTF-16 surrogate escapes that JavaScript strings can retain.
- Parsed JSON container nesting is capped at 256 in every Rust profile;
  applications should keep programmatically constructed values within a
  comparable depth before recursive serialization.
- A partial framed message at end-of-stream is
  `ERR_IPC_INCOMPLETE_FRAME`; Node currently discards its trailing buffer on
  close.
- Rust retains JSON number lexemes, while Node parses numbers as binary64.
  Precision, finite range, signed zero, and exponent underflow or overflow can
  normalize across a Node round trip. Use strings, or stay within
  `-(2^53-1)..=(2^53-1)` for exact integers.
- Rust retains and re-emits duplicate JSON object members; Node collapses them
  to the last value during parsing. Avoid duplicate member names on shared
  messages.
- Rust delimiters are bytes. A custom delimiter used with Node peers must be
  valid UTF-8, configured identically on both sides, and absent as a literal
  byte sequence from every serialized event envelope.
- `Connection` writes synchronously, so guarded `max_pending_bytes` is a
  per-frame write ceiling rather than a measurement of an asynchronous
  userspace socket queue.

## Performance design

- One JSON serialization and one delimiter append per framed send.
- Reused write buffers; stream and maximum-size UDP receive buffers are
  allocated lazily on first use.
- Direct decode from the transport buffer; only a fragmented trailing frame is
  copied.
- The common one-message receive path does not allocate a result collection.
- Complete UDP datagrams reuse one scratch decoder; bounded peer-map entries
  exist only while a fragmented frame is retained.
- Blocking standard-library transports avoid imposing an async runtime or task
  scheduler.

The repository includes a Node/Rust round-trip and throughput harness under
`interop/` and `examples/`. That harness and the mixed-runtime peer are
repository validation tooling and are excluded from the crates.io package;
the native Rust examples listed above are included.

## Version alignment

- Rust and Node releases always share the same major version.
- Minor versions remain aligned whenever shared behavior changes and whenever
  practical for language-specific work.
- Patch versions may move independently for language-specific fixes.
- Every numeric GitHub release records both the npm version and the crates.io
  version, even when only one package changed. Its tag must contain the source
  for both published artifacts. Future language ports follow the same rule.

The Rust release line begins at `14.0.0`, the first paired Node and Rust
release, rather than starting a separate `0.x` version line. Node `13.0.0`
remains the JavaScript modernization release.

## Maintainer release gate

Do not publish the crate or create the paired numeric GitHub release until the
Rust `vanilla-test` suite, Node-to-Rust and Rust-to-Node interoperability matrix,
release-mode performance measurements, MSRV checks, and package dry run all
pass. Run the native suite with `cargo test --test vanilla`; VanillaTest itself
owns the exact 38-case lifecycle and final process result: 30 portable JSON,
event, profile, codec, and in-memory connection cases plus eight public
transport cases. The transport cases exercise loopback TCP and UDP on every
native target, Unix-domain streams on Unix, and named pipes on Windows, with
bounded I/O or process deadlines and verified endpoint cleanup. Run the suite
natively on both Windows and Linux; cross-target compilation alone is not
runtime evidence. Then publish with Cargo, verify the crates.io version, and
include the verified npm and crates.io versions in the same numeric GitHub
release.
