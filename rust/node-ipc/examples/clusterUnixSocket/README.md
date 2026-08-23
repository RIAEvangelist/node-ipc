# Unix socket worker sharing

This is the dependency-free Rust counterpart to
`example/clusterUnixSocket`. Multiple Rust worker threads accept connections
from cloned handles to one Unix listener, so the output shows which worker
handled each request.

Node's `cluster` module distributes a shared listener across processes. The
Rust standard library does not expose a portable process-level descriptor
handoff, so this example preserves the shared-listener and worker-distribution
behavior with threads instead of pretending to provide process clustering.

Run these commands from `rust/node-ipc` in this repository or from the unpacked
crate root.

Server:

```powershell
cargo run --example clusterUnixSocket -- server
```

Client, making four finite connections:

```powershell
cargo run --example clusterUnixSocket -- client
```

This example is Unix-only. On Windows, use the cross-platform
`unixWindowsSocket` named-pipe example.

The server intentionally blocks while accepting the requested number of
connections. Automation must impose an external process deadline and terminate
the server and client processes if a peer is missing or stalls.
