# Rust examples

The native Rust examples mirror the maintained behavior groups that Rust's
standard library can implement under the repository's Node `example/` tree,
without copying each client and server into a separate crate. Each transport is
one Cargo example target; the original Node subfolder names select the behavior
and role. TLS is documented separately as an integration boundary because the
standard library has no TLS provider.

| Node example folder | Rust target and selector |
| --- | --- |
| `TCPSocket/basic` | `TCPSocket -- basic` |
| `TCPSocket/basicSync` | `TCPSocket -- basicSync` |
| `TCPSocket/rawBuffer` | `TCPSocket -- rawBuffer` |
| `TCPSocket/Multi-Client-Broadcast` | `TCPSocket -- Multi-Client-Broadcast` |
| `UDPSocket/basic` | `UDPSocket -- basic` |
| `UDPSocket/rawBuffer` | `UDPSocket -- rawBuffer` |
| `UDPSocket/Multi-Client-Broadcast` | `UDPSocket -- Multi-Client-Broadcast` |
| `unixWindowsSocket/basic` | `unixWindowsSocket -- basic` |
| `unixWindowsSocket/basicSync` | `unixWindowsSocket -- basicSync` |
| `unixWindowsSocket/rawBuffer` | `unixWindowsSocket -- rawBuffer` |
| top-level `rawBuffer` | `unixWindowsSocket -- binaryRawBuffer` |
| `unixWindowsSocket/Multi-Client-Broadcast` | `unixWindowsSocket -- Multi-Client-Broadcast` |
| `clusterUnixSocket` | `clusterUnixSocket` |
| `TLSSocket/basic`, `basic-local-only`, `basicSync`, `Multi-Client-Broadcast-basic`, `rawBuffer-only-works-with-most-secure`, and the security goal of `basic-most-secure` | `TLSSocket` generic verified-stream boundary; `basic-more-secure` is deliberately not reproduced |

Read each runnable transport target's README for its finite server/client
commands:

- `TCPSocket/`
- `UDPSocket/`
- `unixWindowsSocket/`
- `clusterUnixSocket/`

`TLSSocket/` documents the generic verified-stream boundary and has a printable
integration target, not a TLS server/client exchange.

The `basicSync` mappings reproduce strict observable ordering with an explicit
send/receive loop; they do not add another queue or claim to implement Node's
automatic `sync=true` emit scheduling. Broadcast is an example-level iteration
across validated connections or learned UDP peer addresses; it does not add
state to the library.

## Node and Rust together

The repository-only `nodeRustInterop/` folder contains both a Rust peer and a
Node.js peer. Either runtime can be server or client, and both print the exact
framed ping and pong messages. The repository-only release-performance
round-trip harness remains in `tcp_roundtrip.rs` and `../interop/`; both are
intentionally excluded from the published crate and kept separate from these
human-facing native examples.

## Deliberate boundaries

- The Rust crate has no TLS dependency. `TLSSocket` shows how to wrap an
  application-supplied, already verified TLS or mTLS stream and does not fake a
  handshake with plain TCP.
- `clusterUnixSocket` uses worker threads sharing cloned Unix-listener handles.
  The standard library has no portable dependency-free equivalent of Node's
  process-level cluster listener handoff.
- These are native examples. This repository currently has no Rust WASM ABI,
  browser transport adapter, WASM build, or browser test path, so none of these
  examples claim browser support.
