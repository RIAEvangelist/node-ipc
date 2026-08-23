# Rust TCP examples

This one Cargo example mirrors the four Node TCP example folders while keeping
each run finite and dependency-free.

| Node folder | Rust variant | What it demonstrates |
| --- | --- | --- |
| `example/TCPSocket/basic` | `basic` | One framed `message` request and reply. |
| `example/TCPSocket/basicSync` | `basicSync` | Ten strictly ordered request/reply pairs implemented with an explicit send/receive loop; this does not emulate Node's automatic `sync=true` emit queue. |
| `example/TCPSocket/rawBuffer` | `rawBuffer` | Raw `hello`/`goodbye` bytes with no JSON or delimiter framing. |
| `example/TCPSocket/Multi-Client-Broadcast` | `Multi-Client-Broadcast` | Direct replies to `hello` and `goodbye`, followed by `kill.connection` sent to both clients. |

Run commands from `rust/node-ipc`. Host and port are optional and default to
`127.0.0.1:8000`. Start each server first, then run its client command in a
second terminal.

## Basic

```console
cargo run --example TCPSocket -- basic server
cargo run --example TCPSocket -- basic client
```

## Strictly ordered requests

```console
cargo run --example TCPSocket -- basicSync server
cargo run --example TCPSocket -- basicSync client
```

## Raw bytes

```console
cargo run --example TCPSocket -- rawBuffer server
cargo run --example TCPSocket -- rawBuffer client
```

TCP is a byte stream, so one write is not guaranteed to equal one read. The raw
demo logs every received chunk and accumulates the known demonstration payload
before validating it.

## Two clients and broadcast

Run these in three terminals:

```console
cargo run --example TCPSocket -- Multi-Client-Broadcast server
cargo run --example TCPSocket -- Multi-Client-Broadcast hello
cargo run --example TCPSocket -- Multi-Client-Broadcast goodbye
```

Append a host and port to every command to override the defaults:

```console
cargo run --example TCPSocket -- basic server 127.0.0.1 9763
cargo run --example TCPSocket -- basic client 127.0.0.1 9763
```

Every variant validates its peer's messages, applies bounded connection and I/O
waits, and exits after the demonstrated exchange. These examples intentionally
do not implement a persistent service, automatic reconnect loop, or async event
dispatcher.
