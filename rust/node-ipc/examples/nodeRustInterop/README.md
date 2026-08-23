# Node and Rust interoperability

This folder intentionally contains both runtimes. Each pairing sends one
`node-ipc.demo.ping` event and returns one `node-ipc.demo.pong` event while
printing the exact framed JSON. The visible `\f` is node-ipc's form-feed frame
delimiter. No timing or throughput is measured.

Run every command below from the repository root. Start the server before its
client. The server intentionally waits for one connection; automation must
impose an external process deadline and terminate both peers if the client is
missing or stalls.

## Node client to Rust server

```powershell
cargo run --manifest-path rust/node-ipc/Cargo.toml --example nodeRustInterop -- server 127.0.0.1 9763
```

```powershell
node ./rust/node-ipc/examples/nodeRustInterop/node-peer.js client 127.0.0.1 9763
```

## Rust client to Node server

```powershell
node ./rust/node-ipc/examples/nodeRustInterop/node-peer.js server 127.0.0.1 9763
```

```powershell
cargo run --manifest-path rust/node-ipc/Cargo.toml --example nodeRustInterop -- client 127.0.0.1 9763
```
