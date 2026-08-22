# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 12.x    | :white_check_mark: |
| 10.1.x  | :white_check_mark: |
| Other versions | :x: |

The `main` branch is the upcoming 13.x line and requires Node.js 22.12 or newer. Main-branch tests describe development code; they do not extend support to an unpublished release.

## Upcoming 13.x security profiles

Security and performance are selected once when a client or server is created. Changing `ipc.config.parser` or a related limit after `connect*()` or `serve*()` does not reconfigure an existing endpoint.

| Profile | Built-in protocol controls | Appropriate use |
|---------|----------------------------|-----------------|
| Raw | None. Buffers pass through unchanged. | Fully trusted peers with a caller-owned protocol and validation. |
| Fast | Delimiter framing and JSON event envelopes. Malformed JSON closes a stream connection or resets UDP peer frame state. | Trusted local peers. It does not enforce Guarded limits or event-name rules. |
| Guarded | Frame and stream pending-write limits, object-envelope checks, event-name length, reserved and prototype-name rejection, and incomplete-frame timeout. | Mixed-trust local services or authenticated network services. |
| Assured | Guarded plus a required event allow-list; network clients require a key, certificate, trusted CA, and verification; servers require verified client certificates; each Unix local server endpoint must be a direct child of the secure socket root. Clients must verify local endpoint ownership. Built-in Assured local service rejects Windows because node-ipc cannot prove a named-pipe ACL. | A building block for hostile networks when combined with authorization, payload validation, rate limits, key operations, and deployment controls. |

These names describe node-ipc runtime profiles. They are not government, military, industry, or compliance certifications. No parser authenticates a user, authorizes a command, validates application payload schemas, prevents replay, manages certificates, or establishes a complete security program.

`ipc.config.identifyPeer=true` restores the legacy server lookup of `data.id`, selected once at server construction. That payload field is untrusted application data and must never be treated as authenticated identity.

The `node-ipc/parsers/message` compatibility parser is an explicit ecosystem option. It maps malformed envelopes to an `error` message and is not a hardened decoder. Use Guarded or Assured for the built-in protocol controls, or supply a custom parser with the policy your application requires.

See the [profile guide](https://riaevangelist.github.io/node-ipc/profiles/), [parser contract](https://riaevangelist.github.io/node-ipc/parsers/), and [deployment security guide](https://riaevangelist.github.io/node-ipc/security/).

## Reporting a Vulnerability

Report vulnerabilities through GitHub's private [Report a vulnerability](https://github.com/RIAEvangelist/node-ipc/security/advisories/new) form. Do not open a public issue or discussion containing exploit details.

Include the affected version, impact, reproduction steps or a proof of concept, and any suggested mitigation. Avoid including real credentials, private keys, or data from systems you do not own.

The report and status updates will remain in the private security advisory until a fix and coordinated disclosure are ready. If the private reporting form is unavailable, open a public issue that contains no vulnerability details and asks the maintainer to provide a private contact channel.

Reporters who want public credit should say so in the private report; otherwise the disclosure will omit identifying information.
