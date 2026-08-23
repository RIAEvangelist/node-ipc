//! Blocking framed I/O over any byte stream.

use crate::codec::{Codec, CodecConfig, Message, Profile, ProtocolError, ProtocolErrorCode};
use crate::error::{Error, Result};
use crate::event::Event;
use std::collections::VecDeque;
use std::io::{self, Read, Write};

/// Large enough to amortize reads while staying friendly to local IPC and TCP.
/// The buffer is allocated lazily on the first receive.
pub const DEFAULT_READ_BUFFER_SIZE: usize = 64 * 1024;

/// A reusable node-ipc codec paired with one blocking byte stream.
///
/// The common one-message read path does not allocate a result collection.
/// When one stream read contains multiple messages, only the additional owned
/// messages are retained for later [`recv`](Self::recv) calls.
pub struct Connection<S> {
    inner: S,
    codec: Codec,
    read_buffer: Box<[u8]>,
    write_buffer: Vec<u8>,
    pending: VecDeque<Message>,
    deferred_error: Option<ProtocolError>,
    eof: bool,
    failed: bool,
}

impl<S> Connection<S> {
    /// Builds a connection and validates its codec configuration before I/O.
    pub fn new(inner: S, config: CodecConfig) -> Result<Self> {
        Ok(Self::with_codec(inner, Codec::new(config)?))
    }

    /// Pairs a preconfigured codec with a stream.
    #[must_use]
    pub fn with_codec(inner: S, codec: Codec) -> Self {
        Self {
            inner,
            codec,
            read_buffer: Box::default(),
            write_buffer: Vec::new(),
            pending: VecDeque::new(),
            deferred_error: None,
            eof: false,
            failed: false,
        }
    }

    #[must_use]
    pub const fn get_ref(&self) -> &S {
        &self.inner
    }

    #[must_use]
    pub const fn get_mut(&mut self) -> &mut S {
        &mut self.inner
    }

    #[must_use]
    pub const fn codec(&self) -> &Codec {
        &self.codec
    }

    /// Direct codec access is useful for inspecting or clearing partial state
    /// before another receive operation.
    #[must_use]
    pub const fn codec_mut(&mut self) -> &mut Codec {
        &mut self.codec
    }

    #[must_use]
    pub const fn is_eof(&self) -> bool {
        self.eof
    }

    /// Returns whether a protocol or write failure made further I/O unsafe.
    #[must_use]
    pub const fn is_failed(&self) -> bool {
        self.failed
    }

    #[must_use]
    pub fn pending_messages(&self) -> usize {
        self.pending.len()
    }

    /// Returns the stream, discarding codec state and any queued messages.
    #[must_use]
    pub fn into_inner(self) -> S {
        self.inner
    }
}

impl<S: Read + Write> Connection<S> {
    /// Encodes and writes one framed event without an intermediate message
    /// allocation. The write buffer is retained for the next send.
    pub fn send(&mut self, event: &Event) -> Result<()> {
        self.ensure_writable()?;
        self.codec.encode_into(event, &mut self.write_buffer)?;
        if self.codec.profile().is_guarded()
            && self.write_buffer.len() > self.codec.config().max_pending_bytes
        {
            return self.fail_now(ProtocolError::new(
                ProtocolErrorCode::Backpressure,
                "pending socket writes exceed maxPendingBytes",
            ));
        }
        match self.inner.write_all(&self.write_buffer) {
            Ok(()) => Ok(()),
            Err(error) => self.write_failed(error),
        }
    }

    /// Writes one raw-profile chunk. Raw bytes bypass the reusable frame
    /// buffer because no encoding or delimiter append is needed.
    pub fn send_raw(&mut self, bytes: &[u8]) -> Result<()> {
        self.ensure_writable()?;
        if matches!(self.codec.profile(), Profile::Raw) {
            return match self.inner.write_all(bytes) {
                Ok(()) => Ok(()),
                Err(error) => self.write_failed(error),
            };
        }

        // Ask the codec to produce the canonical wrong-profile error.
        self.codec.encode_raw_into(bytes, &mut self.write_buffer)?;
        unreachable!("a framed codec cannot encode raw bytes")
    }

    /// Returns one decoded message, blocking across fragmented stream reads.
    /// A clean end-of-stream is `Ok(None)`; a partial frame at EOF is a
    /// protocol error. Complete messages preceding a protocol error in the
    /// same read are returned first. Once that later error is known, writes are
    /// disabled even while those already-decoded messages are drained.
    pub fn recv(&mut self) -> Result<Option<Message>> {
        if !self.pending.is_empty() {
            if self.deferred_error.is_none() && !self.failed {
                if let Err(error) = self.codec.check_partial_timeout() {
                    self.fail_later(error);
                }
            }
            return Ok(self.pending.pop_front());
        }
        if let Some(error) = self.deferred_error.take() {
            self.failed = true;
            return Err(error.into());
        }
        if self.failed {
            return Ok(None);
        }
        if self.eof {
            if let Err(error) = self.codec.finish() {
                return self.fail_now(error);
            }
            return Ok(None);
        }

        loop {
            if let Err(error) = self.codec.check_partial_timeout() {
                return self.fail_now(error);
            }

            if self.read_buffer.is_empty() {
                self.read_buffer = vec![0; DEFAULT_READ_BUFFER_SIZE].into_boxed_slice();
            }
            let bytes_read = match self.inner.read(&mut self.read_buffer) {
                Ok(bytes_read) => bytes_read,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return self.read_error(error),
            };
            if bytes_read == 0 {
                self.eof = true;
                if let Err(error) = self.codec.finish() {
                    return self.fail_now(error);
                }
                return Ok(None);
            }

            let mut first = None;
            let decoded = {
                let pending = &mut self.pending;
                self.codec
                    .push_with(&self.read_buffer[..bytes_read], |message| {
                        let message = message.into_owned();
                        if first.is_none() {
                            first = Some(message);
                        } else {
                            pending.push_back(message);
                        }
                    })
            };
            if let Err(error) = decoded {
                if first.is_some() {
                    self.fail_later(error);
                    return Ok(first);
                }
                debug_assert!(self.pending.is_empty());
                return self.fail_now(error);
            }
            if let Err(error) = self.codec.check_partial_timeout() {
                if first.is_some() {
                    self.fail_later(error);
                    return Ok(first);
                }
                return self.fail_now(error);
            }

            if let Some(message) = first {
                return Ok(Some(message));
            }
        }
    }

    /// Checks the guarded/assured partial-frame deadline. Generic streams
    /// cannot install an OS read timeout; applications using blocking reads
    /// should configure one on the underlying socket when a hard wall-clock
    /// deadline is required.
    pub fn check_timeout(&self) -> Result<()> {
        self.codec.check_partial_timeout()?;
        Ok(())
    }

    pub fn flush(&mut self) -> Result<()> {
        self.ensure_writable()?;
        match self.inner.flush() {
            Ok(()) => Ok(()),
            Err(error) => self.write_failed(error),
        }
    }

    fn read_error<T>(&mut self, error: io::Error) -> Result<T> {
        if matches!(
            error.kind(),
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
        ) {
            if let Err(protocol_error) = self.codec.check_partial_timeout() {
                return self.fail_now(protocol_error);
            }
        }
        Err(Error::Io(error))
    }

    fn fail_later(&mut self, error: ProtocolError) {
        self.codec.clear_partial();
        self.failed = true;
        debug_assert!(self.deferred_error.is_none());
        self.deferred_error = Some(error);
    }

    fn fail_now<T>(&mut self, error: ProtocolError) -> Result<T> {
        self.codec.clear_partial();
        self.failed = true;
        Err(error.into())
    }

    fn ensure_writable(&self) -> Result<()> {
        if self.failed {
            return Err(Error::Io(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "connection is unusable after an earlier protocol or write failure",
            )));
        }
        Ok(())
    }

    fn write_failed<T>(&mut self, error: io::Error) -> Result<T> {
        // `write_all` may have emitted a frame prefix. A later write would then
        // append a new envelope to an invalid partial frame.
        self.codec.clear_partial();
        self.failed = true;
        Err(Error::Io(error))
    }
}
