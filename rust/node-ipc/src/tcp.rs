use std::io;
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};

/// Connects a TCP stream and selects the same low-latency policy as node-ipc.
pub fn connect<A: ToSocketAddrs>(address: A) -> io::Result<TcpStream> {
    let stream = TcpStream::connect(address)?;
    prepare(&stream)?;
    Ok(stream)
}

/// Binds a TCP listener. Accepted streams are configured by [`accept`].
pub fn bind<A: ToSocketAddrs>(address: A) -> io::Result<TcpListener> {
    TcpListener::bind(address)
}

/// Accepts one stream and disables Nagle buffering for message latency parity.
pub fn accept(listener: &TcpListener) -> io::Result<(TcpStream, SocketAddr)> {
    let (stream, peer) = listener.accept()?;
    prepare(&stream)?;
    Ok((stream, peer))
}

/// Applies node-ipc's direct stream policy to an existing TCP socket.
pub fn prepare(stream: &TcpStream) -> io::Result<()> {
    stream.set_nodelay(true)
}
