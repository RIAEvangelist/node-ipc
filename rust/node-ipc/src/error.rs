//! Errors shared by the framed stream and datagram transports.

use crate::codec::ProtocolError;
use std::error::Error as StdError;
use std::fmt;
use std::io;
use std::net::SocketAddr;

/// A transport or wire-protocol failure.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    Io(io::Error),
    Protocol(ProtocolError),
    /// A protocol failure tied to one UDP peer.
    PeerProtocol {
        peer: SocketAddr,
        source: ProtocolError,
    },
}

impl Error {
    pub(crate) const fn peer_protocol(peer: SocketAddr, source: ProtocolError) -> Self {
        Self::PeerProtocol { peer, source }
    }

    /// Returns the protocol error, when this is a local or peer protocol
    /// failure.
    #[must_use]
    pub const fn protocol_error(&self) -> Option<&ProtocolError> {
        match self {
            Self::Protocol(error) | Self::PeerProtocol { source: error, .. } => Some(error),
            Self::Io(_) => None,
        }
    }

    /// Returns the UDP peer associated with a peer protocol failure.
    #[must_use]
    pub const fn peer(&self) -> Option<SocketAddr> {
        match self {
            Self::PeerProtocol { peer, .. } => Some(*peer),
            Self::Io(_) | Self::Protocol(_) => None,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "I/O error: {error}"),
            Self::Protocol(error) => error.fmt(formatter),
            Self::PeerProtocol { peer, source } => {
                write!(formatter, "protocol error from UDP peer {peer}: {source}")
            }
        }
    }
}

impl StdError for Error {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Protocol(error) => Some(error),
            Self::PeerProtocol { source, .. } => Some(source),
        }
    }
}

impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<ProtocolError> for Error {
    fn from(error: ProtocolError) -> Self {
        Self::Protocol(error)
    }
}

pub type Result<T> = std::result::Result<T, Error>;
