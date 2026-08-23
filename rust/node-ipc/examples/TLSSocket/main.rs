#[path = "../support/mod.rs"]
mod support;

use node_ipc::{CodecConfig, Connection, Event};
use std::io::{Read, Write};

fn main() {
    println!("node-ipc intentionally does not bundle a TLS implementation.");
    println!("Create and verify a TLS or mTLS stream in your application, then pass it to:");
    println!("  fast_tls_connection(stream)");
    println!("  assured_tls_connection(stream, allowed_events)");
    println!("  raw_tls_connection(stream)");
    println!("See examples/TLSSocket/README.md for the security and variant mapping.");
}

/// Wraps a server-authenticated or mutually authenticated TLS stream with the
/// Fast node-ipc codec. TLS identity verification is the caller's precondition.
pub fn fast_tls_connection<S>(verified_tls_stream: S) -> node_ipc::Result<Connection<S>>
where
    S: Read + Write,
{
    Connection::new(verified_tls_stream, CodecConfig::fast())
}

/// Wraps an already mutually authenticated TLS stream with an Assured codec.
/// This function cannot verify the transport; the caller must complete and
/// authorize the mTLS handshake before passing the stream.
pub fn assured_tls_connection<S, I, T>(
    verified_mtls_stream: S,
    allowed_events: I,
) -> node_ipc::Result<Connection<S>>
where
    S: Read + Write,
    I: IntoIterator<Item = T>,
    T: Into<String>,
{
    Connection::new(verified_mtls_stream, CodecConfig::assured(allowed_events))
}

/// Wraps an already verified TLS stream without node-ipc framing.
pub fn raw_tls_connection<S>(verified_tls_stream: S) -> node_ipc::Result<Connection<S>>
where
    S: Read + Write,
{
    Connection::new(verified_tls_stream, CodecConfig::raw())
}

/// Sends requests one at a time and waits for each response, matching the
/// ordering demonstrated by the Node `basicSync` example.
pub fn ordered_exchange<S>(
    connection: &mut Connection<S>,
    requests: &[Event],
) -> support::ExampleResult<Vec<Event>>
where
    S: Read + Write,
{
    let mut responses = Vec::with_capacity(requests.len());
    for request in requests {
        connection.send(request)?;
        connection.flush()?;
        responses.push(support::receive_event(connection)?);
    }
    Ok(responses)
}

/// Broadcasts one event to application-owned TLS connections. TLS session and
/// peer authorization remain the application's responsibility.
pub fn broadcast<S>(connections: &mut [Connection<S>], event: &Event) -> node_ipc::Result<()>
where
    S: Read + Write,
{
    for connection in connections {
        connection.send(event)?;
        connection.flush()?;
    }
    Ok(())
}
