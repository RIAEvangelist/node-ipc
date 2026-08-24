# Migrating from 12.0.0 to 14.0.0

Version `13.0.0` was an internal modernization candidate and was never
published. Upgrade directly from `12.0.0` to `14.0.0`.

Node-ipc 14 is native ESM and requires Node.js 22.13 or newer. CommonJS on
supported Node releases can continue to use:

```js
const ipc = require('node-ipc').default;
```

The generated `node-ipc.cjs` bundle and its esbuild step are gone. Both
`import` and `require()` now load the same source.

## Paired Rust implementation

Version 14 introduces the dependency-free Rust crate under the same
`node-ipc` name and major version:

```toml
[dependencies]
node-ipc = "=14.0.0"
```

The Rust crate implements the same event envelope, delimiter framing, runtime
profiles, TCP, UDP, Unix sockets, and Windows named pipes. It has no runtime or
build dependencies. TLS remains application supplied so the crate does not
choose a cryptography stack or weaken certificate verification.

Node and Rust normal framed messages interoperate. Review the documented
language boundaries for malformed JSON, number precision, duplicate object
members, UTF-16 surrogate escapes, custom delimiters, and incomplete frames
before treating arbitrary language-specific values as portable.

## Aligned C# implementation

Version 14 also introduces the zero-NuGet-dependency .NET 8 package under the
same `node-ipc` name and major version:

```console
dotnet add package node-ipc --version 14.0.0
```

Unlike the lower-level blocking Rust crate, the C# port mirrors the JavaScript
facade: isolated `IPCModule` instances, lowercase config and service methods,
client registries, synchronous event subscriptions, reconnects, sync queues,
targeted replies, broadcasts, TCP/TLS/UDP, and cross-platform local service.
Valid Fast messages use the same compact `{type,data}` UTF-8 envelope and form-
feed delimiter and pass the repository's two-direction Node/C# gate.

C# endpoints capture parser, TLS trust/identity, logging, identification, sync,
and local-permission choices when constructed. Configure them before calling
`connect*()` or `serve*()`. Fast malformed input without a string event type
fails closed before C# event dispatch; normal framed messages are unaffected.
For Unix Assured clients, the built-in connector does not authenticate socket
ownership: verify the root and endpoint ownership in the application before
connecting.

The repository's shared behavioral gate runs one versioned Fast TCP transcript
through all nine JavaScript, Rust, and C# client/server pairings. It covers
falsey scalar values, Unicode and control characters, arrays, nested objects,
pipelined ordering, an exact canonical Fast frame, a separate finish barrier,
and a clean half-close/end-of-stream boundary in both directions. Run it with
`npm run test:behavioral`; language-specific malformed-input and security
boundaries remain in the native suites. The command also runs 12 raw negative
checks so every client and server language rejects complete and incomplete
frames after the finish boundary.

## Event subscriptions

Node-ipc 14 uses `event-pubsub` 6.1.0. Dispatch remains synchronous and live:
wildcard listeners run before typed listeners, and listeners appended during a
dispatch can run in that same dispatch. A `once` registration is removed before
its handler is invoked, so nested emission cannot invoke it twice. `list`
returns isolated handler-array snapshots on a null-prototype object; the real
all-events entry is exposed under `Symbol.for('event-pubsub-all')`, while the
public registration spelling remains the literal `'*'`.

Invalid public arguments still throw `TypeError`, but applications must not
depend on exact error text. Event-pubsub's sole runtime dependency remains
exact `strong-type` 2.0.0, and clean package installs verify its package-shaped
Node and unbundled-browser sibling import. The old runtime `copyfiles`
dependency is gone.

## Select a parser

`ipc.config.parser` is selected once when a client or server is created:

- `raw` — caller-owned bytes, with no node-ipc framing or parsing.
- `fast` — the default JSON event frame and malformed-JSON containment.
- `guarded` — Fast plus size, name, reserved-event, timeout, and pending-write limits.
- `assured` — Guarded plus an explicit `allowedEvents` list and mutually authenticated TLS on network transports.
- a parser class or object — implements `encode(type, data)` and
  `read(remainder, chunk, receive)`.

`rawBuffer=true` remains an alias for Raw.

Fast now preserves payloads directly. Empty strings, `null`, and objects with
an `_maxListeners` field are no longer rewritten to `{}`.

Built-in framed parsers use UTF-8 in both directions. `ipc.config.encoding`
now applies to non-Buffer Raw writes. A custom parser that owns another wire
encoding should return Buffers.

Servers no longer inspect every payload for `data.id` by default. Set
`ipc.config.identifyPeer=true` only when legacy payload-based socket IDs are
required. The option is selected once when the server is created.

The official js-message adapter is available separately:

```js
import {MessageParser} from 'node-ipc/parsers/message';

ipc.config.parser = MessageParser;
```

This compatibility parser follows js-message error-envelope behavior. Use
Guarded or Assured for untrusted peers.

## TLS and local sockets

TLS servers no longer fall back to repository fixtures. Configure
`tls.key`/`tls.cert` values or `tls.private`/`tls.public` file paths.
Clients publish `connect` only after the TLS handshake succeeds.

On Unix, the default local-socket directory is user-specific. Secure root
ownership and mode checks happen once when a local server starts. Assured local
server endpoints must be direct children of that root; clients must verify the
endpoint they connect to.
Assured local service is limited to Unix sockets because node-ipc cannot prove
a Windows named-pipe ACL. Use Assured mutual TLS or an application-owned pipe
and policy on Windows.

The example certificates remain public, expired development fixtures and are
excluded from the npm package.
