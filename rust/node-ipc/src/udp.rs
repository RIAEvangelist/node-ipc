//! Blocking IPv4/IPv6 UDP endpoints with node-ipc per-peer framing state.

use crate::codec::{Codec, CodecConfig, Message, Profile, ProtocolError, ProtocolErrorCode};
use crate::error::{Error, Result};
use crate::event::Event;
use std::collections::{HashMap, VecDeque};
use std::io;
use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};
use std::time::Instant;

/// Covers every valid UDP payload without truncating at the receive buffer.
pub const MAX_DATAGRAM_SIZE: usize = u16::MAX as usize;

/// Default maximum number of peers that may retain an incomplete frame.
pub const DEFAULT_MAX_FRAGMENTED_PEERS: usize = 1024;

/// Default endpoint-wide ceiling for retained incomplete-frame bytes.
pub const DEFAULT_MAX_FRAGMENTED_BYTES: usize = 8 * 1024 * 1024;

/// Maximum fragment-only datagrams consumed by one blocking receive call
/// before yielding control with an endpoint backpressure error.
pub const FRAGMENT_DATAGRAM_YIELD_INTERVAL: usize = 64;

/// One blocking UDP socket with independent incremental framing per peer.
pub struct UdpEndpoint {
    socket: UdpSocket,
    encoder: Codec,
    scratch: Codec,
    peers: HashMap<SocketAddr, Codec>,
    fragmented_bytes: usize,
    max_fragmented_peers: usize,
    max_fragmented_bytes: usize,
    next_fragment_expiry: Option<Instant>,
    read_buffer: Box<[u8]>,
    write_buffer: Vec<u8>,
    pending: VecDeque<(Message, SocketAddr)>,
    deferred_error: Option<Error>,
}

impl UdpEndpoint {
    /// Validates the profile, then binds a UDP socket.
    pub fn bind<A: ToSocketAddrs>(address: A, config: CodecConfig) -> Result<Self> {
        let encoder = udp_codec(config)?;
        let socket = UdpSocket::bind(address)?;
        Ok(Self::build(socket, encoder))
    }

    /// Wraps an existing UDP socket after validating the profile.
    pub fn from_socket(socket: UdpSocket, config: CodecConfig) -> Result<Self> {
        let encoder = udp_codec(config)?;
        Ok(Self::build(socket, encoder))
    }

    fn build(socket: UdpSocket, encoder: Codec) -> Self {
        let scratch = Codec::new(encoder.config().clone())
            .expect("the UDP encoder already validated this codec configuration");
        Self {
            socket,
            encoder,
            scratch,
            peers: HashMap::new(),
            fragmented_bytes: 0,
            max_fragmented_peers: DEFAULT_MAX_FRAGMENTED_PEERS,
            max_fragmented_bytes: DEFAULT_MAX_FRAGMENTED_BYTES,
            next_fragment_expiry: None,
            read_buffer: Box::default(),
            write_buffer: Vec::new(),
            pending: VecDeque::new(),
            deferred_error: None,
        }
    }

    /// Encodes and sends one framed event as one datagram.
    pub fn send_to<A: ToSocketAddrs>(&mut self, event: &Event, target: A) -> Result<usize> {
        self.encoder.encode_into(event, &mut self.write_buffer)?;
        Ok(self.socket.send_to(&self.write_buffer, target)?)
    }

    /// Sends one raw-profile datagram without copying it into the frame buffer.
    pub fn send_raw_to<A: ToSocketAddrs>(&mut self, bytes: &[u8], target: A) -> Result<usize> {
        if matches!(self.encoder.profile(), Profile::Raw) {
            return Ok(self.socket.send_to(bytes, target)?);
        }

        // Ask the codec to produce the canonical wrong-profile error.
        self.encoder
            .encode_raw_into(bytes, &mut self.write_buffer)?;
        unreachable!("a framed codec cannot encode raw bytes")
    }

    /// Receives one decoded message and its peer address. Fragments from
    /// different peers never share codec state. Coalesced messages are retained
    /// and returned before another datagram is read. Complete messages before a
    /// malformed frame are returned before that peer-scoped protocol error.
    pub fn recv_from(&mut self) -> Result<(Message, SocketAddr)> {
        if !self.pending.is_empty() {
            if self.deferred_error.is_none() {
                if let Err(error) = self.check_timeouts() {
                    self.deferred_error = Some(error);
                }
            }
            return Ok(self
                .pending
                .pop_front()
                .expect("the pending message queue is not empty"));
        }
        if let Some(error) = self.deferred_error.take() {
            return Err(error);
        }

        let mut fragment_datagrams = 0;
        loop {
            self.check_timeouts()?;

            if self.read_buffer.is_empty() {
                self.read_buffer = vec![0; MAX_DATAGRAM_SIZE].into_boxed_slice();
            }

            let (bytes_read, peer) = match self.socket.recv_from(&mut self.read_buffer) {
                Ok(received) => received,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return self.read_error(error),
            };

            // Raw UDP is one message per datagram, including an empty
            // datagram. It needs neither framing state nor a peer-map entry.
            if matches!(self.encoder.profile(), Profile::Raw) {
                return Ok((Message::Raw(self.read_buffer[..bytes_read].to_vec()), peer));
            }
            if bytes_read == 0 {
                if let Some(mut codec) = self.take_peer(&peer) {
                    codec.clear_partial();
                    self.scratch = codec;
                }
                return self.peer_failure(
                    peer,
                    ProtocolError::new(
                        ProtocolErrorCode::InvalidMessage,
                        "empty framed UDP datagram carries no message",
                    ),
                    None,
                );
            }

            let first;
            if let Some(mut codec) = self.take_peer(&peer) {
                let decoded = decode_datagram(
                    &mut codec,
                    &self.read_buffer[..bytes_read],
                    peer,
                    &mut self.pending,
                );
                first = decoded.first;
                if let Some(source) = decoded.error {
                    codec.clear_partial();
                    self.scratch = codec;
                    return self.peer_failure(peer, source, first);
                }

                if codec.has_partial_frame() {
                    if let Err(source) = codec.check_partial_timeout() {
                        codec.clear_partial();
                        self.scratch = codec;
                        return self.peer_failure(peer, source, first);
                    }
                    if let Err(source) = self.retain_peer(peer, codec) {
                        return self.peer_failure(peer, source, first);
                    }
                } else {
                    // Recycle any capacity accumulated while assembling the
                    // fragment instead of dropping that decoder allocation.
                    self.scratch = codec;
                }
            } else {
                let decoded = decode_datagram(
                    &mut self.scratch,
                    &self.read_buffer[..bytes_read],
                    peer,
                    &mut self.pending,
                );
                first = decoded.first;
                if let Some(source) = decoded.error {
                    self.scratch.clear_partial();
                    return self.peer_failure(peer, source, first);
                }

                if self.scratch.has_partial_frame() {
                    if let Err(source) = self.scratch.check_partial_timeout() {
                        self.scratch.clear_partial();
                        return self.peer_failure(peer, source, first);
                    }
                    if let Err(source) = self.check_fragment_capacity(self.scratch.partial_len()) {
                        self.scratch.clear_partial();
                        return self.peer_failure(peer, source, first);
                    }
                    let replacement = Codec::new(self.encoder.config().clone())
                        .expect("the UDP encoder already validated this codec configuration");
                    let partial = std::mem::replace(&mut self.scratch, replacement);
                    if let Err(source) = self.retain_peer(peer, partial) {
                        return self.peer_failure(peer, source, first);
                    }
                }
            }

            if let Some(message) = first {
                return Ok(message);
            }
            // The fragment has moved into the peer map. Yield periodically so
            // a blocking caller can rate-limit or cancel fragment-only input.
            fragment_datagrams += 1;
            if fragment_datagrams >= FRAGMENT_DATAGRAM_YIELD_INTERVAL {
                return Err(ProtocolError::new(
                    ProtocolErrorCode::Backpressure,
                    "framed UDP receive yielded after repeated fragment-only datagrams",
                )
                .into());
            }
        }
    }

    /// Removes and reports one expired incomplete peer frame. Calls before the
    /// earliest retained deadline are constant-time.
    pub fn check_timeouts(&mut self) -> Result<()> {
        let Some(next_expiry) = self.next_fragment_expiry else {
            return Ok(());
        };
        let now = Instant::now();
        if now < next_expiry {
            return Ok(());
        }

        let expired = self.peers.iter().find_map(|(peer, codec)| {
            fragment_deadline(codec)
                .filter(|deadline| *deadline <= now)
                .and_then(|_| codec.check_partial_timeout().err())
                .map(|source| (*peer, source))
        });
        if let Some((peer, source)) = expired {
            self.take_peer(&peer);
            self.recompute_next_expiry();
            return Err(Error::peer_protocol(peer, source));
        }
        // The cached deadline may belong to a peer that completed or was
        // explicitly removed. Repair it only after that stale time arrives.
        self.recompute_next_expiry();
        Ok(())
    }

    /// Drops retained framing state for one peer.
    pub fn remove_peer(&mut self, peer: &SocketAddr) -> bool {
        self.take_peer(peer).is_some()
    }

    /// Drops all retained framing state.
    pub fn clear_peers(&mut self) {
        self.peers.clear();
        self.fragmented_bytes = 0;
        self.next_fragment_expiry = None;
    }

    /// Changes the endpoint-wide limits for incomplete framed datagrams.
    /// Existing state must already fit within the requested limits.
    pub fn set_fragment_limits(&mut self, max_peers: usize, max_bytes: usize) -> Result<()> {
        if max_peers == 0 || max_bytes == 0 {
            return Err(ProtocolError::new(
                ProtocolErrorCode::InvalidConfiguration,
                "UDP fragment limits must be greater than zero",
            )
            .into());
        }
        if self.peers.len() > max_peers || self.fragmented_bytes > max_bytes {
            return Err(ProtocolError::new(
                ProtocolErrorCode::Backpressure,
                "retained UDP fragments exceed the requested endpoint limits",
            )
            .into());
        }
        self.max_fragmented_peers = max_peers;
        self.max_fragmented_bytes = max_bytes;
        Ok(())
    }

    /// Returns the number of peers currently retaining a fragmented frame.
    #[must_use]
    pub fn peer_count(&self) -> usize {
        self.peers.len()
    }

    /// Returns the total bytes retained across incomplete peer frames.
    #[must_use]
    pub const fn fragmented_bytes(&self) -> usize {
        self.fragmented_bytes
    }

    /// Returns `(maximum peers, maximum bytes)` for retained fragments.
    #[must_use]
    pub const fn fragment_limits(&self) -> (usize, usize) {
        (self.max_fragmented_peers, self.max_fragmented_bytes)
    }

    #[must_use]
    pub fn pending_messages(&self) -> usize {
        self.pending.len()
    }

    #[must_use]
    pub const fn codec(&self) -> &Codec {
        &self.encoder
    }

    #[must_use]
    pub const fn socket(&self) -> &UdpSocket {
        &self.socket
    }

    #[must_use]
    pub const fn socket_mut(&mut self) -> &mut UdpSocket {
        &mut self.socket
    }

    #[must_use]
    pub fn into_socket(self) -> UdpSocket {
        self.socket
    }

    fn read_error<T>(&mut self, error: io::Error) -> Result<T> {
        if matches!(
            error.kind(),
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
        ) {
            self.check_timeouts()?;
        }
        Err(Error::Io(error))
    }

    fn peer_failure(
        &mut self,
        peer: SocketAddr,
        source: ProtocolError,
        first: Option<(Message, SocketAddr)>,
    ) -> Result<(Message, SocketAddr)> {
        let error = Error::peer_protocol(peer, source);
        if let Some(message) = first {
            debug_assert!(self.deferred_error.is_none());
            self.deferred_error = Some(error);
            Ok(message)
        } else {
            debug_assert!(self.pending.is_empty());
            Err(error)
        }
    }

    fn take_peer(&mut self, peer: &SocketAddr) -> Option<Codec> {
        let codec = self.peers.remove(peer)?;
        debug_assert!(self.fragmented_bytes >= codec.partial_len());
        self.fragmented_bytes = self.fragmented_bytes.saturating_sub(codec.partial_len());
        if self.peers.is_empty() {
            self.next_fragment_expiry = None;
        }
        Some(codec)
    }

    fn retain_peer(
        &mut self,
        peer: SocketAddr,
        codec: Codec,
    ) -> std::result::Result<(), ProtocolError> {
        debug_assert!(codec.has_partial_frame());
        debug_assert!(!self.peers.contains_key(&peer));
        let bytes = codec.partial_len();
        self.check_fragment_capacity(bytes)?;

        self.fragmented_bytes += bytes;
        if let Some(deadline) = fragment_deadline(&codec) {
            self.next_fragment_expiry = Some(
                self.next_fragment_expiry
                    .map_or(deadline, |current| current.min(deadline)),
            );
        }
        let previous = self.peers.insert(peer, codec);
        debug_assert!(previous.is_none());
        Ok(())
    }

    fn check_fragment_capacity(
        &self,
        additional_bytes: usize,
    ) -> std::result::Result<(), ProtocolError> {
        if additional_bytes > self.max_fragmented_bytes
            || self.peers.len() >= self.max_fragmented_peers
            || self.fragmented_bytes > self.max_fragmented_bytes.saturating_sub(additional_bytes)
        {
            return Err(ProtocolError::new(
                ProtocolErrorCode::Backpressure,
                "UDP fragmented-frame retention exceeded endpoint limits",
            ));
        }
        Ok(())
    }

    fn recompute_next_expiry(&mut self) {
        self.next_fragment_expiry = self.peers.values().filter_map(fragment_deadline).min();
    }
}

struct DatagramDecode {
    first: Option<(Message, SocketAddr)>,
    error: Option<ProtocolError>,
}

fn decode_datagram(
    codec: &mut Codec,
    datagram: &[u8],
    peer: SocketAddr,
    pending: &mut VecDeque<(Message, SocketAddr)>,
) -> DatagramDecode {
    let mut first = None;
    let error = codec
        .push_with(datagram, |message| {
            let message = (message.into_owned(), peer);
            if first.is_none() {
                first = Some(message);
            } else {
                pending.push_back(message);
            }
        })
        .err();
    DatagramDecode { first, error }
}

fn udp_codec(config: CodecConfig) -> Result<Codec> {
    let codec = Codec::new(config)?;
    if matches!(codec.profile(), Profile::Assured) {
        return Err(ProtocolError::new(
            ProtocolErrorCode::AssuredTransport,
            "the assured profile requires a verified TLS stream and cannot use UDP",
        )
        .into());
    }
    Ok(codec)
}

fn fragment_deadline(codec: &Codec) -> Option<Instant> {
    if !codec.profile().is_guarded() {
        return None;
    }
    codec
        .partial_started_at()?
        .checked_add(codec.config().message_timeout?)
}
