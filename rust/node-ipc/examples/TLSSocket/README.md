# TLS stream integration

This folder maps the behaviors under `example/TLSSocket` without adding a TLS
dependency or pretending plain TCP is secure. Rust's standard library does not
provide TLS. The application must select a TLS implementation, validate the
server identity, and—when client identity matters—complete and authorize a
mutual-TLS handshake.

After that handshake, pass the resulting `Read + Write` stream to one of the
functions in `main.rs`:

- `fast_tls_connection` maps `basic` and `basic-local-only`.
- `ordered_exchange` maps `basicSync`; Rust's blocking connection is already
  ordered and needs no queue abstraction.
- `broadcast` maps `Multi-Client-Broadcast-basic` over application-owned
  connections.
- `raw_tls_connection` maps `rawBuffer-only-works-with-most-secure` after the
  TLS stream has been verified.
- `assured_tls_connection` maps the security goal of `basic-most-secure`: the
  caller supplies an authenticated and authorized mTLS stream, while the crate
  adds the explicit event allow-list and guarded protocol controls.

`basic-more-secure` deliberately has no Rust security counterpart because
requesting a certificate while accepting an unverifiable identity is not a
security level worth reproducing. Replace the repository's public, expired
development certificates with application-owned identities.

From `rust/node-ipc` in this repository or from the unpacked crate root, run this
target to print the integration boundary:

```powershell
cargo run --example TLSSocket
```
