# Migrating to 13.0.0

Node-ipc 13 is native ESM and requires Node.js 22.12 or newer. CommonJS on
supported Node releases can continue to use:

```js
const ipc = require('node-ipc').default;
```

The generated `node-ipc.cjs` bundle and its esbuild step are gone. Both
`import` and `require()` now load the same source.

## Event subscriptions

Node-ipc 13 uses `event-pubsub` 6.1.0. Dispatch remains synchronous and live:
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
ownership and mode checks happen once when a local server starts.
Assured local service is limited to Unix sockets because node-ipc cannot prove
a Windows named-pipe ACL. Use Assured mutual TLS or an application-owned pipe
and policy on Windows.

The example certificates remain public, expired development fixtures and are
excluded from the npm package.
