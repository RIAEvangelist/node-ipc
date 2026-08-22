# Using TLS securely

TLS protects a connection only when certificate identities are verified. TCP and UDP do not provide authentication; services exposed beyond loopback must authenticate and authorize application messages, or use mutually authenticated TLS (mTLS).

The upcoming Assured profile adds Guarded protocol controls and an explicit event allow-list. Its network contract requires mutually authenticated TLS: clients provide a key and certificate, trust the server CA, and keep verification enabled; servers trust a client CA, request a client certificate, and reject unauthorized clients. Local Assured servers require the owner-only Unix socket-root policy; built-in Assured local service rejects Windows because node-ipc cannot prove a named-pipe ACL.

```javascript
ipc.config.parser = 'assured';
ipc.config.allowedEvents = ['hello', 'goodbye'];
ipc.config.secureSocketRoot = true;
```

Set parser and TLS configuration before creating the client or server; each endpoint selects its hot-path handlers once.

## Server requirements

A TLS server must supply its own `key` and `cert`, or the existing `private` and `public` file-path aliases. The server fails closed when they are missing; there is no bundled certificate fallback.

```javascript
ipc.config.tls = {
    private: '/secure/path/server.key',
    public: '/secure/path/server.crt',
    requestCert: true,
    rejectUnauthorized: true,
    trustedConnections: ['/secure/path/client-ca.crt']
};
```

Keep keys outside the package and source tree with owner-only permissions. Use currently valid certificates whose names match the host clients use. The certificates and private keys under `local-node-ipc-certs` are public, expired development fixtures; never use them as a network identity.

## Client verification

Assured clients must supply their own key and certificate, trust the intended server CA, and keep `rejectUnauthorized` set to `true`.

```javascript
ipc.config.tls = {
    private: '/secure/path/client.key',
    public: '/secure/path/client.crt',
    trustedConnections: ['/secure/path/server-ca.crt'],
    rejectUnauthorized: true,
    servername: 'ipc.example.internal'
};
```

Other profiles can use server-authenticated TLS without a client certificate, but that does not authenticate clients. Use mTLS or application authentication when the server must know who connected.

`rejectUnauthorized: false` disables certificate identity verification and is vulnerable to man-in-the-middle attacks. It appears in some legacy examples only so expired local fixtures can be exercised on an isolated development machine. Never copy that setting into an external or untrusted deployment.

The `basic-most-secure` and `rawBuffer-only-works-with-most-secure` examples show the shape of mTLS configuration, but you must replace every repository certificate and key path with your own valid material before running them securely.
