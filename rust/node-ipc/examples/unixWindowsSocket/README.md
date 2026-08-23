# Unix socket / Windows named-pipe examples

This one Cargo example mirrors the local-transport concepts in the repository's
Node examples. On Unix it uses `node_ipc::local::{LocalListener, connect}`. On
Windows it uses `node_ipc::windows_pipe::{NamedPipeListener, NamedPipeStream}`.
The protocol handlers are shared generic functions over `Read + Write`; there is
no second transport abstraction.

Run these commands from `rust/node-ipc` in this repository or from the unpacked
crate root. Run every server before its client. Each process validates the
complete exchange and exits after the expected messages. The optional
`endpoint` must be identical for every process in one example.

```text
cargo run --example unixWindowsSocket -- <basic|basicSync|rawBuffer|binaryRawBuffer|Multi-Client-Broadcast> <server|client|hello|goodbye> [endpoint]
```

## Basic request/reply

In separate terminals:

```powershell
cargo run --example unixWindowsSocket -- basic server
cargo run --example unixWindowsSocket -- basic client
```

The client sends `app.message` with `{id:"hello", message:"hello"}`; the server
validates it and replies from `world` with `hello world!`, matching the Node
local-socket envelope.

## Strict synchronous ordering

```powershell
cargo run --example unixWindowsSocket -- basicSync server
cargo run --example unixWindowsSocket -- basicSync client
```

The client completes ten strict request/reply steps in order, from `hello0`
through `hello9`. It does not send request `n + 1` before validating reply `n`.
This reproduces the observable ordering explicitly; the Rust library does not
implement Node's automatic `sync=true` emit queue.

## Raw text bytes

```powershell
cargo run --example unixWindowsSocket -- rawBuffer server
cargo run --example unixWindowsSocket -- rawBuffer client
```

This is the Rust mapping of `example/unixWindowsSocket/rawBuffer/**`. On connect
the server sends unframed `hello`; the client also sends `hello`; after
validation the server sends unframed `goodbye`.

## Raw binary bytes

```powershell
cargo run --example unixWindowsSocket -- binaryRawBuffer server
cargo run --example unixWindowsSocket -- binaryRawBuffer client
```

This maps the top-level Node `example/rawBuffer/**` concept into the same local
transport target instead of duplicating it. On connect the server sends `aa`.
The client sends exactly `00 02 00 ff ee cc`; the server validates all six bytes
and replies with exactly `0d ee`.

## Multi-client broadcast

Start the server, then start one client in each of two additional terminals. The
two clients may be started in either order.

```powershell
cargo run --example unixWindowsSocket -- Multi-Client-Broadcast server
cargo run --example unixWindowsSocket -- Multi-Client-Broadcast hello
cargo run --example unixWindowsSocket -- Multi-Client-Broadcast goodbye
```

The server requires one `hello` and one `goodbye` identity, sends a validated
direct reply to each, then sends `kill.connection` to both clients and exits.

## Endpoint selection and blocking limits

Without an endpoint argument, the program derives a per-user, per-variant name.
Unix uses a socket file under the operating system temporary directory. Windows
uses a logical path that the crate converts to a `\\.\pipe\...` name exactly as
Node node-ipc does. The default prevents collisions between these variants, but
it is not globally unique; pass an explicit endpoint when running two copies of
the same variant concurrently or when pairing Rust with a Node peer.

Unix streams receive a 30-second read/write timeout. The synchronous Windows
named-pipe helper cannot cancel or time out `connect`, `accept`, `read`, or
`flush`, so a missing or stalled peer can block indefinitely. Automation must
wrap Windows runs in an external process deadline and terminate the complete
server/client process group if that deadline expires.
