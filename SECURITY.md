# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 14.x    | :white_check_mark: |
| 12.x    | :white_check_mark: |
| 10.1.x  | :white_check_mark: |
| Other versions | :x: |

Version 14.x aligns the native-ESM Node.js implementation (Node.js 22.13+), the
dependency-free Rust implementation (Rust 1.85+), and the zero-NuGet-dependency
C# implementation (.NET 8+). Version 13 was never published.

The `node-ipc` JavaScript package is **Node.js-only**. It does not run in web
browsers, whether bundled or unbundled, because browsers and browser-targeted
bundles cannot supply its raw TCP, TLS, UDP, Unix-domain socket, Windows
named-pipe, filesystem, OS, process, or `Buffer` contracts. The documentation
website's browser code is separate from the npm runtime.

## 14.x Node.js security profiles

Security and performance are selected once when a client or server is created. Changing `ipc.config.parser` or a related limit after `connect*()` or `serve*()` does not reconfigure an existing endpoint.

| Profile | Built-in protocol controls | Appropriate use |
|---------|----------------------------|-----------------|
| Raw | None. Buffers pass through unchanged. | Fully trusted peers with a caller-owned protocol and validation. |
| Fast | Delimiter framing and JSON event envelopes. Malformed JSON closes a stream connection or resets UDP peer frame state. | Trusted local peers. It does not enforce Guarded limits or event-name rules. |
| Guarded | Frame and stream pending-write limits, object-envelope checks, event-name length, reserved and prototype-name rejection, and incomplete-frame timeout. | Mixed-trust local services or authenticated network services. |
| Assured | Guarded plus a required event allow-list; network clients require a key, certificate, trusted CA, and verification; servers require verified client certificates; each Unix local server endpoint must be a direct child of the secure socket root. Clients must verify local endpoint ownership. Built-in Assured local service rejects Windows because node-ipc cannot prove a named-pipe ACL. | A building block for hostile networks when combined with authorization, payload validation, rate limits, key operations, and deployment controls. |

These rows describe the Node.js runtime. They are not government, military, industry, or compliance certifications. No parser authenticates a user, authorizes a command, validates application payload schemas, prevents replay, manages certificates, or establishes a complete security program.

`ipc.config.identifyPeer=true` restores the legacy server lookup of `data.id`, selected once at server construction. That payload field is untrusted application data and must never be treated as authenticated identity.

The `node-ipc/parsers/message` compatibility parser is an explicit ecosystem option. It maps malformed envelopes to an `error` message and is not a hardened decoder. Use Guarded or Assured for the built-in protocol controls, or supply a custom parser with the policy your application requires.

## 14.x Rust security profiles

Rust exposes the same Raw, Fast, Guarded, and Assured profile names and framed
wire contract. Guarded and Assured enforce a per-frame write ceiling because
Rust writes synchronously; they do not measure Node.js-style queued socket
writes. Rust Assured adds the event allow-list, but it cannot authenticate an
arbitrary `Read + Write` transport. The application must supply and verify
mutual TLS for hostile networks, enforce an owner-only Unix socket boundary,
or create and verify an appropriate Windows named-pipe ACL. UDP is rejected by
Rust Assured. See the [Rust security boundary](https://riaevangelist.github.io/node-ipc/rust/#security-boundary) for the exact contract.

## 14.x C# security profiles

C# mirrors the JavaScript Raw, Fast, Guarded, and Assured names and high-level
service API. Parser choice, TLS material and trust, payload logging, peer
identification, sync behavior, and local permission flags are captured when an
endpoint is constructed. Fast has framing but no inbound size or timeout limit;
use Guarded or Assured for untrusted peers.

C# Assured network service requires mutually authenticated TLS, verified custom
roots, identities with private keys, hostname and enhanced-key-usage checks,
and an event allowlist. Certificate AIA downloads and revocation networking are
disabled. UDP, plain network streams, accept-all validation callbacks, and
built-in Windows local Assured service fail closed.

On Unix, an Assured server requires a current-user-owned `0700` socket root and
an endpoint directly inside it. The built-in C# client does not verify root or
endpoint ownership; Assured local clients must verify ownership themselves
before connecting. `unlink=true` type- and identity-checks the path but cannot
prove that another same-user listener is dead, so supervised or multi-instance
deployments should manage liveness and use `unlink=false`.

As in JavaScript, event and logger callbacks are synchronous application code.
Do not install handlers that throw on untrusted input; validate payload schemas,
authorize operations, rate-limit peers, and contain application failures.

See the [profile guide](https://riaevangelist.github.io/node-ipc/profiles/), [parser contract](https://riaevangelist.github.io/node-ipc/parsers/), and [deployment security guide](https://riaevangelist.github.io/node-ipc/security/).

## Reporting a Vulnerability

Report vulnerabilities through GitHub's private [Report a vulnerability](https://github.com/RIAEvangelist/node-ipc/security/advisories/new) form. Do not open a public issue or discussion containing exploit details.

Include the affected version, impact, reproduction steps or a proof of concept, and any suggested mitigation. Avoid including real credentials, private keys, or data from systems you do not own.

The report and status updates will remain in the private security advisory until a fix and coordinated disclosure are ready. If the private reporting form is unavailable, open a public issue that contains no vulnerability details and asks the maintainer to provide a private contact channel.

Reporters who want public credit should say so in the private report; otherwise the disclosure will omit identifying information.
