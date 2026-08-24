# node-ipc for C#

`node-ipc` is the dependency-free .NET 8 implementation of the canonical node-ipc event
envelope, transports, and JavaScript-shaped client/server API. It lives beside the Node.js and
Rust implementations so the protocol, release record, and interoperability evidence stay in one
repository.

The C# release line begins at `14.0.0` and intentionally keeps the familiar lowercase API names:
`config`, `of`, `server`, `serve`, `serveNet`, `connectTo`, `connectToNet`, `disconnect`, `on`,
`once`, `off`, `reset`, `emit`, and `broadcast`.

## Install

Once the aligned package is published:

```console
dotnet add package node-ipc --version 14.0.0
```

The runtime targets `net8.0`, has no NuGet dependencies, enables nullable annotations, and treats
compiler warnings as errors in this repository.

## TCP quick start

```csharp
using System.Text.Json;
using NodeIpc;

await using var serverIpc = new IPCModule();
serverIpc.config.silent = true;
var server = serverIpc.serveNet("127.0.0.1", 9763);
server.on<JsonElement>("example.request", (data, peer) =>
    server.emit(peer, "example.response", data));
server.start();

await using var clientIpc = new IPCModule();
clientIpc.config.silent = true;
clientIpc.config.stopRetrying = true;
var client = clientIpc.connectToNet("example", "127.0.0.1", 9763)!;
var response = new TaskCompletionSource<JsonElement>(
    TaskCreationOptions.RunContinuationsAsynchronously);
client.on<JsonElement>("example.response", data => response.TrySetResult(data));
await client.waitForConnectAsync();
await client.emitAsync("example.request", new { message = "hello" });
Console.WriteLine((await response.Task).GetProperty("message").GetString());
```

Use `IPC.Default` or `NodeIPC.ipc` for the process-wide singleton. Prefer a new `IPCModule` when
tests, libraries, or multiple independent configurations need isolated `config`, `of`, and
`server` state.

## JavaScript-to-C# map

| JavaScript | C# |
| --- | --- |
| default singleton | `IPC.Default` or `NodeIPC.ipc` |
| `new IPCModule()` | `new IPCModule()` |
| `ipc.config` | `ipc.config` (`Defaults`) |
| `ipc.serve(path, callback)` | `ipc.serve(path, callback)` then `server.start()` |
| `ipc.serveNet(host, port, udpType, callback)` | the matching `serveNet` overload |
| `ipc.connectTo(id, path, callback)` | the matching `connectTo` overload |
| `ipc.connectToNet(id, host, port, callback)` | the matching `connectToNet` overload |
| `ipc.of[id]` | `ipc.of[id]` |
| client `emit(type, data)` | client `emit` or awaitable `emitAsync` |
| server `emit(socket, type, data)` | server `emit` or awaitable `emitAsync` |
| server `broadcast(type, data)` | server `broadcast` or `broadcastAsync` |
| `on`, `once`, `off`, `reset`, `list` | the same event methods and snapshot property |
| `Parser`, `FastParser`, `RawParser` | the same exported class names |
| `GuardedParser`, `AssuredParser` | the same exported class names |
| `IPCProtocolError` | `IPCProtocolError` alias and `IPCProtocolException` base |
| `node-ipc/parsers/message` | `MessageParser` |

The callback overload is invoked immediately after connection work is scheduled, matching the
JavaScript facade. A write made in that callback is retained and flushed in order after the socket
opens. Empty paths/hosts, port `0`, and an empty UDP type use the JavaScript defaults. An empty
service id logs and returns `null`, matching JavaScript's aborted `undefined` result; normal calls
therefore commonly use C#'s `!` after a known nonempty id.

## Wire profiles

The default framed message is compact UTF-8 JSON followed by the configured delimiter (form feed
by default):

```text
{"type":"example","data":{"value":42}}\f
```

- `FastParser` implements canonical delimiter framing and `{type,data}` serialization.
- `RawParser` delivers transport bytes through the `data` event without JSON or framing.
- `GuardedParser` adds message, pending-write, event-name, reserved-name, and incomplete-frame
  limits with the same stable `ERR_IPC_*` codes as JavaScript.
- `AssuredParser` adds a copied nonempty event allowlist and always rejects lifecycle and unsafe
  event names.
- A custom `IParser` only has to provide `encode(type, data)` and `read(buffer, data, receive)`;
  the interface supplies safe defaults for the optional profile metadata.

`Parser.format`, `Parser.push`, `Parser.parse`, their raw counterparts, and `MessageParser` expose
the parser helpers used by the JavaScript package. `FrameBuffer` is public for custom streaming
parsers.

After a remote stream ends, `IpcPeer.incompleteFrameBytes` records any bytes
left without a delimiter. The behavioral gate uses this read-only diagnostic to
distinguish a clean Fast end-of-stream from a truncated trailing frame.

Fast and Raw use the socket's 16 KiB high-water indication: asynchronous `emit` returns `false`
once queued bytes cross that point, but the accepted write remains queued. With `sync = true`, an
accepted queued send returns `true` to match JavaScript. Guarded and Assured additionally fail
closed at `maxPendingBytes`. Await `emitAsync` when completion matters.

## Transports

| Transport | C# behavior |
| --- | --- |
| TCP | Async IPv4/IPv6 client and server, Nagle disabled, optional local address/port/family. |
| TLS | `SslStream` client/server support, normal server authentication, optional mTLS. |
| UDP4/UDP6 | Bound server endpoints, learned peers, targeted sends, broadcast, peer-scoped fragments. |
| Unix local | Unix-domain streams, private socket roots, cautious identity-checked cleanup. |
| Windows local | Async byte-mode named pipes derived from the logical node-ipc path. |

Local `serve` and `connectTo` automatically select Unix sockets or Windows named pipes. UDP is a
server-style API on both sides: create two `serveNet(..., "udp4")` endpoints and target a remote
endpoint with `server.peer(address, port)`.

The runnable [examples](https://github.com/RIAEvangelist/node-ipc/tree/main/csharp/node-ipc/examples)
cover TCP, local, and UDP round trips.

## TLS and Assured

Assign a `TlsOptions` instance before constructing the client or server:

```csharp
var tls = new TlsOptions
{
    certificate = serverCertificateWithPrivateKey,
    requestCert = true,
    rejectUnauthorized = true
};
tls.trustedCertificates.Add(clientCertificateAuthority);
ipc.config.tls = tls;
```

PEM values or paths can be supplied through `key`/`cert` (or the JavaScript aliases
`private`/`public`). `trustedConnections` accepts CA PEM values or paths. Certificate, trust,
callback, and policy inputs are snapshotted when a client/server is constructed; later config or
file mutation cannot silently downgrade an existing endpoint. Certificate-chain downloads are
disabled, revocation networking is not performed, and custom roots still enforce hostname and
the appropriate server/client enhanced-key usage.

Assured is deliberately a codec-plus-authenticated-transport contract:

- Network Assured requires TLS, a local identity with a private key, trusted roots, mandatory
  verification, and mutual authentication on the server.
- An accept-all certificate callback is rejected for Assured endpoints.
- UDP and plain TCP are rejected.
- Unix Assured requires `secureSocketRoot=true` and an endpoint directly inside that root. The
  built-in client does not verify root or endpoint ownership: Assured local clients must verify
  ownership themselves before connecting, then apply application authorization.
- Built-in Windows local service is rejected for Assured because this zero-dependency port does
  not invent an application ACL. `readableAll`/`writableAll` are likewise rejected on Windows.

## Lifecycle and concurrency

Event dispatch is synchronous, wildcard-first, registration-ordered, live, and mutation-safe.
Listeners appended during dispatch can run in that same dispatch; only `list` returns a snapshot.
`once` is removed before invocation so reentrant publication cannot call it twice. Local lifecycle
events include `start`, `connect`, `disconnect`, `destroy`, `close`, `socket.disconnected`,
`error`, and raw `data`.

Clients reconnect using `retry`, `maxRetries`, and `stopRetrying`. `sync=true` serializes outbound
requests and advances once for every inbound raw or framed message; unsolicited input is not
banked as credit for a future request. `disconnectAsync`, `stopAsync`, and `IAsyncDisposable`
provide deterministic shutdown while the synchronous methods remain available for API parity.

## Security and compatibility boundaries

- C# Fast requires a JSON object with a string `type` before event dispatch. JavaScript Fast only
  performs `JSON.parse` first, but a value without a usable type cannot enter C#'s typed event
  registry. This fail-closed malformed-input difference does not affect valid peers.
- Framed UTF-8 uses replacement semantics for malformed byte sequences, matching Node's streaming
  decoder behavior. Raw mode preserves arbitrary bytes.
- A custom delimiter must be identical on every peer and absent as a literal sequence from
  serialized frames.
- Fast has no inbound frame-size or incomplete-frame deadline. Use Guarded or Assured, plus
  application rate limits, for untrusted peers.
- UDP source addresses can be spoofed. Retained fragments are bounded by `maxPendingBytes`; learned
  peers are bounded by `maxConnections`, and the least-recent idle peer is evicted when capacity
  is needed.
- `secureSocketRoot=true` creates an owner-only `0700` root. A pre-existing root must already be a
  real current-user-owned `0700` directory; the library refuses to chmod an unrelated directory.
- `unlink=true` only deletes a Unix socket path after type and identity rechecks, but it cannot
  prove that another same-user listener is dead. Use a private parent and set `unlink=false` for
  supervised or multi-instance deployments where liveness is managed elsewhere.
- Existing endpoint configuration is captured when it affects parser choice, TLS trust, peer
  identification, payload logging, sync behavior, and local permissions. Change config before
  constructing the next client or server.

## Validation

From the repository root:

```console
dotnet run --project csharp/node-ipc/tests/NodeIpc.Tests -c Release
node csharp/node-ipc/interop/vanilla-test.js
npm run test:behavioral
pwsh -File csharp/node-ipc/package-smoke.ps1
```

The native suite owns its exact case count and exercises profiles, parser helpers, event semantics,
TCP, TLS, UDP, local transports, retries, sync, timeout recovery, backpressure, lifecycle, and
security gates. The focused interop harness requires both C#-server/Node-client and
Node-server/C#-client directions through the shared transcript. The full behavioral gate runs the
same ordered payload contract through all nine JavaScript, Rust, and C# pairings. CI runs both
native and behavioral suites on Windows, Linux, and macOS. The full gate also includes 12 raw
boundary checks covering complete and incomplete trailing frames in each language and role.

## Version alignment

- C#, Rust, and Node releases share the same major version.
- Minor versions remain aligned whenever shared behavior changes and whenever practical for
  language-specific work.
- Patch versions may move independently for language-specific fixes.
- Every numeric GitHub release records the verified npm, NuGet, and crates.io versions. Tags and
  release titles use the bare numeric version, such as `14.0.0`.

Do not publish the NuGet package until the native matrix, 2/2 Node interoperability gate, package
smoke test, and the corresponding Node and Rust compatibility checks pass from the tagged source.
