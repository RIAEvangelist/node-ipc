# UDP socket examples

This Cargo example mirrors the three Node.js UDP folders without mixing Node
source into the Rust example tree:

| Rust selector | Node.js example | Behavior |
| --- | --- | --- |
| `basic` | `example/UDPSocket/basic` | One framed `message` request and one direct framed reply. |
| `rawBuffer` | `example/UDPSocket/rawBuffer` | One raw `hello` datagram and one raw `goodbye` datagram. |
| `Multi-Client-Broadcast` | `example/UDPSocket/Multi-Client-Broadcast` | Separate `hello` and `goodbye` endpoints receive direct replies and one explicit fan-out message. |

Run commands from `rust/node-ipc`. Every process exits after validating its
finite exchange. Reads and writes have 30-second deadlines.

## Basic framed request and reply

Start the server, then the client in another terminal:

```text
cargo run --example UDPSocket -- basic server
cargo run --example UDPSocket -- basic client
```

The client binds `127.0.0.1:8001`, sends its framed `Hello` event to the server
at `127.0.0.1:8000`, validates `Hello world!`, and exits.

## Raw buffer

Start the raw-profile server, then the client:

```text
cargo run --example UDPSocket -- rawBuffer server
cargo run --example UDPSocket -- rawBuffer client
```

Raw UDP preserves datagram boundaries: the bytes in one datagram are one raw
message. There is no node-ipc JSON envelope or delimiter in this mode.

## Multi-client broadcast

Start the server first, then start the two clients in either order:

```text
cargo run --example UDPSocket -- Multi-Client-Broadcast server
cargo run --example UDPSocket -- Multi-Client-Broadcast hello
cargo run --example UDPSocket -- Multi-Client-Broadcast goodbye
```

UDP has no connected client collection. The server learns the sender
`SocketAddr` from each validated `hello` and `goodbye` datagram, sends a direct
reply to that address, and then implements broadcast as two explicit
`send_to` calls. The payload `id` values are demo routing labels, not
authenticated identities. Both clients remain open until they validate their
direct reply and the fan-out message.

## Addresses and ports

The full command shape is:

```text
cargo run --example UDPSocket -- <basic|rawBuffer|Multi-Client-Broadcast> <server|client|hello|goodbye> [host] [server-port] [local-port]
```

- `host` defaults to `127.0.0.1`; only IPv4 loopback addresses (or
  `localhost`) are accepted so the demo cannot accidentally bind externally.
- `server-port` defaults to `8000`.
- `client` and `hello` default to local port `8001`; `goodbye` defaults to
  `8002`.
- The optional `local-port` is meaningful only for a client role.

The selector spellings intentionally preserve the existing Node example
folder concepts. `rawBuffer` is only the legacy folder/CLI name; the Rust code
uses the explicit `CodecConfig::raw()` profile.
