//! Dependency-free node-ipc framing and profile validation.

use crate::event::{Event, EventError, EventErrorKind};
use std::collections::HashSet;
use std::error::Error;
use std::fmt;
use std::str::FromStr;
use std::time::{Duration, Instant};

pub const DEFAULT_DELIMITER: &[u8] = b"\x0c";
pub const DEFAULT_MAX_MESSAGE_SIZE: usize = 1024 * 1024;
pub const DEFAULT_MAX_PENDING_BYTES: usize = 8 * 1024 * 1024;
pub const DEFAULT_MAX_EVENT_NAME_LENGTH: usize = 256;
pub const DEFAULT_MESSAGE_TIMEOUT: Duration = Duration::from_secs(30);

/// Wire event names reserved for local lifecycle notifications by node-ipc.
pub const RESERVED_EVENT_TYPES: &[&str] = &[
    "start",
    "connect",
    "disconnect",
    "destroy",
    "close",
    "socket.disconnected",
    "error",
    "data",
];

/// Object prototype names unsafe for the current Node event dispatcher.
pub const UNSAFE_EVENT_TYPES: &[&str] = &[
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
#[non_exhaustive]
pub enum Profile {
    Raw,
    #[default]
    Fast,
    Guarded,
    Assured,
}

impl Profile {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Raw => "raw",
            Self::Fast => "fast",
            Self::Guarded => "guarded",
            Self::Assured => "assured",
        }
    }

    #[must_use]
    pub const fn is_framed(self) -> bool {
        !matches!(self, Self::Raw)
    }

    #[must_use]
    pub const fn is_guarded(self) -> bool {
        matches!(self, Self::Guarded | Self::Assured)
    }
}

impl fmt::Display for Profile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for Profile {
    type Err = ProtocolError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "raw" => Ok(Self::Raw),
            "fast" => Ok(Self::Fast),
            "guarded" => Ok(Self::Guarded),
            "assured" => Ok(Self::Assured),
            _ => Err(ProtocolError::new(
                ProtocolErrorCode::InvalidConfiguration,
                "profile must be `raw`, `fast`, `guarded`, or `assured`",
            )),
        }
    }
}

/// Framing and validation settings. Defaults match node-ipc v14.
#[derive(Clone, Debug)]
#[non_exhaustive]
pub struct CodecConfig {
    pub profile: Profile,
    pub delimiter: Vec<u8>,
    pub max_message_size: usize,
    pub max_pending_bytes: usize,
    pub max_event_name_length: usize,
    pub message_timeout: Option<Duration>,
    pub allow_reserved_events: bool,
    pub allowed_events: HashSet<String>,
}

impl CodecConfig {
    #[must_use]
    pub fn raw() -> Self {
        Self {
            profile: Profile::Raw,
            ..Self::default()
        }
    }

    #[must_use]
    pub fn fast() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn guarded() -> Self {
        Self {
            profile: Profile::Guarded,
            ..Self::default()
        }
    }

    #[must_use]
    pub fn assured<I, S>(allowed_events: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            profile: Profile::Assured,
            allowed_events: allowed_events.into_iter().map(Into::into).collect(),
            ..Self::default()
        }
    }

    #[must_use]
    pub fn with_delimiter(mut self, delimiter: impl Into<Vec<u8>>) -> Self {
        self.delimiter = delimiter.into();
        self
    }
}

impl Default for CodecConfig {
    fn default() -> Self {
        Self {
            profile: Profile::Fast,
            delimiter: DEFAULT_DELIMITER.to_vec(),
            max_message_size: DEFAULT_MAX_MESSAGE_SIZE,
            max_pending_bytes: DEFAULT_MAX_PENDING_BYTES,
            max_event_name_length: DEFAULT_MAX_EVENT_NAME_LENGTH,
            message_timeout: Some(DEFAULT_MESSAGE_TIMEOUT),
            allow_reserved_events: false,
            allowed_events: HashSet::new(),
        }
    }
}

/// One callback-delivered message. Raw bytes borrow the caller's read buffer;
/// framed events own only their parsed fields.
#[derive(Debug, Eq, PartialEq)]
pub enum DecodedMessage<'a> {
    Event(Event),
    Raw(&'a [u8]),
}

impl DecodedMessage<'_> {
    #[must_use]
    pub fn into_owned(self) -> Message {
        match self {
            Self::Event(event) => Message::Event(event),
            Self::Raw(bytes) => Message::Raw(bytes.to_vec()),
        }
    }
}

/// An owned decoded message returned by the convenience [`Codec::push`] API.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Message {
    Event(Event),
    Raw(Vec<u8>),
}

/// An incremental encoder/decoder for one connection.
pub struct Codec {
    config: CodecConfig,
    pending: Vec<u8>,
    partial_started_at: Option<Instant>,
}

impl Codec {
    pub fn new(mut config: CodecConfig) -> Result<Self, ProtocolError> {
        validate_config(&config)?;
        if config.message_timeout == Some(Duration::ZERO) {
            config.message_timeout = None;
        }
        if matches!(config.profile, Profile::Assured) {
            config.allow_reserved_events = false;
        }
        Ok(Self {
            config,
            pending: Vec::new(),
            partial_started_at: None,
        })
    }

    #[must_use]
    pub fn config(&self) -> &CodecConfig {
        &self.config
    }

    #[must_use]
    pub fn profile(&self) -> Profile {
        self.config.profile
    }

    /// Encodes one event and delimiter into a new buffer.
    pub fn encode(&self, event: &Event) -> Result<Vec<u8>, ProtocolError> {
        let mut output = Vec::new();
        self.encode_into(event, &mut output)?;
        Ok(output)
    }

    /// Clears and reuses `output`, serializing the event exactly once.
    pub fn encode_into(&self, event: &Event, output: &mut Vec<u8>) -> Result<(), ProtocolError> {
        output.clear();
        if matches!(self.config.profile, Profile::Raw) {
            return Err(ProtocolError::new(
                ProtocolErrorCode::WrongProfile,
                "event envelopes cannot be encoded by the raw profile",
            ));
        }

        self.validate_event_type(&event.event_type)?;
        event.write_json(output);
        if let Err(error) = self.check_frame_size(output.len()) {
            output.clear();
            return Err(error);
        }
        output.reserve(self.config.delimiter.len());
        output.extend_from_slice(&self.config.delimiter);
        Ok(())
    }

    /// Clears and reuses `output` for a raw-profile write.
    pub fn encode_raw_into(&self, bytes: &[u8], output: &mut Vec<u8>) -> Result<(), ProtocolError> {
        output.clear();
        if !matches!(self.config.profile, Profile::Raw) {
            return Err(ProtocolError::new(
                ProtocolErrorCode::WrongProfile,
                "raw bytes can only be encoded by the raw profile",
            ));
        }
        output.extend_from_slice(bytes);
        Ok(())
    }

    /// Primary no-result-vector decode path. Complete frames are decoded
    /// directly from `chunk`; only a fragmented trailing frame is copied.
    /// Messages are delivered in wire order. If a later frame in `chunk` is
    /// invalid, callbacks for earlier complete messages have already run before
    /// this method returns `Err`.
    pub fn push_with<'a, F>(
        &mut self,
        chunk: &'a [u8],
        mut receive: F,
    ) -> Result<usize, ProtocolError>
    where
        F: FnMut(DecodedMessage<'a>),
    {
        if matches!(self.config.profile, Profile::Raw) {
            if chunk.is_empty() {
                return Ok(0);
            }
            receive(DecodedMessage::Raw(chunk));
            return Ok(1);
        }

        if !self.pending.is_empty() {
            self.check_partial_timeout()?;
        }
        if chunk.is_empty() {
            return Ok(0);
        }

        if self.pending.is_empty() {
            return self.decode_direct(chunk, &mut receive);
        }

        self.complete_partial_then_direct(chunk, &mut receive)
    }

    /// Convenience path which owns raw chunks and allocates a result vector.
    /// If any frame in `chunk` fails, the returned error discards messages
    /// already collected from that call; use [`Self::push_with`] when earlier
    /// messages must be delivered before a later error.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Message>, ProtocolError> {
        let mut messages = Vec::new();
        self.push_with(chunk, |message| messages.push(message.into_owned()))?;
        Ok(messages)
    }

    #[must_use]
    pub fn has_partial_frame(&self) -> bool {
        !self.pending.is_empty()
    }

    #[must_use]
    pub fn partial_len(&self) -> usize {
        self.pending.len()
    }

    #[must_use]
    pub fn partial_started_at(&self) -> Option<Instant> {
        self.partial_started_at
    }

    /// Enforces the Guarded/Assured incomplete-frame deadline without moving
    /// that deadline when later fragments arrive.
    pub fn check_partial_timeout(&self) -> Result<(), ProtocolError> {
        if !self.config.profile.is_guarded() {
            return Ok(());
        }
        let (Some(started), Some(timeout)) = (self.partial_started_at, self.config.message_timeout)
        else {
            return Ok(());
        };
        if started.elapsed() >= timeout {
            return Err(ProtocolError::new(
                ProtocolErrorCode::MessageTimeout,
                "incomplete message exceeded messageTimeout",
            ));
        }
        Ok(())
    }

    pub fn clear_partial(&mut self) {
        self.pending.clear();
        self.partial_started_at = None;
    }

    /// Reports a truncated framed message at end-of-stream.
    pub fn finish(&self) -> Result<(), ProtocolError> {
        if self.pending.is_empty() || matches!(self.config.profile, Profile::Raw) {
            Ok(())
        } else {
            Err(ProtocolError::new(
                ProtocolErrorCode::IncompleteFrame,
                "stream ended with an incomplete message",
            ))
        }
    }

    pub fn validate_event_type(&self, event_type: &str) -> Result<(), ProtocolError> {
        if !self.config.profile.is_guarded() {
            return Ok(());
        }
        if event_type.is_empty() {
            return Err(ProtocolError::new(
                ProtocolErrorCode::InvalidEvent,
                "event type must be a non-empty string",
            ));
        }
        if self.config.max_event_name_length != usize::MAX
            && event_type
                .encode_utf16()
                .take(self.config.max_event_name_length.saturating_add(1))
                .count()
                > self.config.max_event_name_length
        {
            return Err(ProtocolError::new(
                ProtocolErrorCode::EventTooLarge,
                "event type exceeds maxEventNameLength",
            ));
        }
        if is_unsafe_event_type(event_type) {
            return Err(ProtocolError::new(
                ProtocolErrorCode::InvalidEvent,
                "event type is not safe for the active event dispatcher",
            ));
        }
        if !self.config.allow_reserved_events && is_reserved_event_type(event_type) {
            return Err(ProtocolError::new(
                ProtocolErrorCode::ReservedEvent,
                "event type is reserved for local lifecycle events",
            ));
        }
        if matches!(self.config.profile, Profile::Assured)
            && !self.config.allowed_events.contains(event_type)
        {
            return Err(ProtocolError::new(
                ProtocolErrorCode::EventNotAllowed,
                "event type is not in allowedEvents",
            ));
        }
        Ok(())
    }

    fn complete_partial_then_direct<'a, F>(
        &mut self,
        chunk: &'a [u8],
        receive: &mut F,
    ) -> Result<usize, ProtocolError>
    where
        F: FnMut(DecodedMessage<'a>),
    {
        let delimiter_len = self.config.delimiter.len();

        if let Some(prefix_from_pending) =
            crossing_delimiter_prefix(&self.pending, chunk, self.config.delimiter.as_slice())
        {
            let frame_end = self.pending.len() - prefix_from_pending;
            let event = self.decode_frame(&self.pending[..frame_end]);
            let consumed = delimiter_len - prefix_from_pending;
            self.clear_partial();
            let event = event?;
            receive(DecodedMessage::Event(event));
            return self
                .decode_direct(&chunk[consumed..], receive)
                .map(|count| count + 1);
        }

        if let Some(end) = find_delimiter(chunk, self.config.delimiter.as_slice()) {
            let Some(frame_size) = self.pending.len().checked_add(end) else {
                self.clear_partial();
                return Err(frame_too_large_error());
            };
            if let Err(error) = self.check_frame_size(frame_size) {
                self.clear_partial();
                return Err(error);
            }
            self.pending.extend_from_slice(&chunk[..end]);
            let event = self.decode_frame(&self.pending);
            self.clear_partial();
            let event = event?;
            receive(DecodedMessage::Event(event));
            return self
                .decode_direct(&chunk[end + delimiter_len..], receive)
                .map(|count| count + 1);
        }

        let Some(frame_size) = self.pending.len().checked_add(chunk.len()) else {
            self.clear_partial();
            return Err(frame_too_large_error());
        };
        if let Err(error) = self.check_frame_size(frame_size) {
            self.clear_partial();
            return Err(error);
        }
        self.pending.extend_from_slice(chunk);
        // Keep the timestamp for the first fragment; later chunks do not reset it.
        Ok(0)
    }

    fn decode_direct<'a, F>(
        &mut self,
        chunk: &'a [u8],
        receive: &mut F,
    ) -> Result<usize, ProtocolError>
    where
        F: FnMut(DecodedMessage<'a>),
    {
        let delimiter = self.config.delimiter.as_slice();
        let mut frame_start = 0;
        let mut count = 0;

        while let Some(relative_end) = find_delimiter(&chunk[frame_start..], delimiter) {
            let frame_end = frame_start + relative_end;
            let event = self.decode_frame(&chunk[frame_start..frame_end])?;
            receive(DecodedMessage::Event(event));
            count += 1;
            frame_start = frame_end + delimiter.len();
        }

        if frame_start < chunk.len() {
            let remainder = &chunk[frame_start..];
            self.check_frame_size(remainder.len())?;
            self.pending.extend_from_slice(remainder);
            self.partial_started_at = (self.config.profile.is_guarded()
                && self.config.message_timeout.is_some())
            .then(Instant::now);
        } else {
            self.partial_started_at = None;
        }
        Ok(count)
    }

    fn decode_frame(&self, frame: &[u8]) -> Result<Event, ProtocolError> {
        self.check_frame_size(frame.len())?;
        let event = Event::from_json(frame).map_err(ProtocolError::from)?;
        self.validate_event_type(&event.event_type)?;
        Ok(event)
    }

    fn check_frame_size(&self, bytes: usize) -> Result<(), ProtocolError> {
        if self.config.profile.is_guarded() && bytes > self.config.max_message_size {
            return Err(frame_too_large_error());
        }
        Ok(())
    }
}

impl Default for Codec {
    fn default() -> Self {
        Self::new(CodecConfig::default()).expect("the default codec configuration is valid")
    }
}

#[must_use]
pub fn is_reserved_event_type(event_type: &str) -> bool {
    RESERVED_EVENT_TYPES.contains(&event_type)
}

#[must_use]
pub fn is_unsafe_event_type(event_type: &str) -> bool {
    UNSAFE_EVENT_TYPES.contains(&event_type)
}

fn validate_config(config: &CodecConfig) -> Result<(), ProtocolError> {
    if config.profile.is_framed() && config.delimiter.is_empty() {
        return Err(ProtocolError::new(
            ProtocolErrorCode::InvalidConfiguration,
            "delimiter must be non-empty for a framed profile",
        ));
    }
    if config.profile.is_guarded() {
        for (name, value) in [
            ("maxMessageSize", config.max_message_size),
            ("maxPendingBytes", config.max_pending_bytes),
            ("maxEventNameLength", config.max_event_name_length),
        ] {
            if value == 0 {
                return Err(ProtocolError::new(
                    ProtocolErrorCode::InvalidConfiguration,
                    format!("{name} must be a positive integer"),
                ));
            }
        }
    }
    if matches!(config.profile, Profile::Assured) && config.allowed_events.is_empty() {
        return Err(ProtocolError::new(
            ProtocolErrorCode::InvalidConfiguration,
            "allowedEvents must be non-empty for the assured profile",
        ));
    }
    Ok(())
}

fn crossing_delimiter_prefix(pending: &[u8], chunk: &[u8], delimiter: &[u8]) -> Option<usize> {
    let maximum = pending.len().min(delimiter.len().saturating_sub(1));
    (1..=maximum).rev().find(|&from_pending| {
        let from_chunk = delimiter.len() - from_pending;
        chunk.len() >= from_chunk
            && pending[pending.len() - from_pending..] == delimiter[..from_pending]
            && chunk[..from_chunk] == delimiter[from_pending..]
    })
}

fn find_delimiter(haystack: &[u8], delimiter: &[u8]) -> Option<usize> {
    if delimiter.len() == 1 {
        return haystack.iter().position(|byte| *byte == delimiter[0]);
    }
    if haystack.len() < delimiter.len() {
        return None;
    }

    let last_start = haystack.len() - delimiter.len();
    let first = delimiter[0];
    let mut offset = 0;
    while offset <= last_start {
        let relative = haystack[offset..=last_start]
            .iter()
            .position(|byte| *byte == first)?;
        let candidate = offset + relative;
        if haystack[candidate..candidate + delimiter.len()] == *delimiter {
            return Some(candidate);
        }
        offset = candidate + 1;
    }
    None
}

fn frame_too_large_error() -> ProtocolError {
    ProtocolError::new(
        ProtocolErrorCode::FrameTooLarge,
        "message exceeds maxMessageSize",
    )
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[non_exhaustive]
pub enum ProtocolErrorCode {
    InvalidConfiguration,
    InvalidJson,
    InvalidMessage,
    InvalidEvent,
    EventTooLarge,
    ReservedEvent,
    EventNotAllowed,
    FrameTooLarge,
    Backpressure,
    MessageTimeout,
    AssuredTransport,
    IncompleteFrame,
    WrongProfile,
}

impl ProtocolErrorCode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidConfiguration => "ERR_IPC_INVALID_CONFIGURATION",
            Self::InvalidJson => "ERR_IPC_INVALID_JSON",
            Self::InvalidMessage => "ERR_IPC_INVALID_MESSAGE",
            Self::InvalidEvent => "ERR_IPC_INVALID_EVENT",
            Self::EventTooLarge => "ERR_IPC_EVENT_TOO_LARGE",
            Self::ReservedEvent => "ERR_IPC_RESERVED_EVENT",
            Self::EventNotAllowed => "ERR_IPC_EVENT_NOT_ALLOWED",
            Self::FrameTooLarge => "ERR_IPC_FRAME_TOO_LARGE",
            Self::Backpressure => "ERR_IPC_BACKPRESSURE",
            Self::MessageTimeout => "ERR_IPC_MESSAGE_TIMEOUT",
            Self::AssuredTransport => "ERR_IPC_ASSURED_TRANSPORT",
            Self::IncompleteFrame => "ERR_IPC_INCOMPLETE_FRAME",
            Self::WrongProfile => "ERR_IPC_WRONG_PROFILE",
        }
    }
}

impl fmt::Display for ProtocolErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug)]
pub struct ProtocolError {
    code: ProtocolErrorCode,
    message: String,
    event_error: Option<EventError>,
}

impl ProtocolError {
    pub fn new(code: ProtocolErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            event_error: None,
        }
    }

    #[must_use]
    pub const fn code(&self) -> ProtocolErrorCode {
        self.code
    }

    #[must_use]
    pub fn code_str(&self) -> &'static str {
        self.code.as_str()
    }

    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl From<EventError> for ProtocolError {
    fn from(error: EventError) -> Self {
        let (code, message) = match error.kind() {
            EventErrorKind::InvalidJson => (
                ProtocolErrorCode::InvalidJson,
                "received message is not valid JSON",
            ),
            EventErrorKind::RootNotObject => (
                ProtocolErrorCode::InvalidMessage,
                "received message must be a JSON object",
            ),
            EventErrorKind::MissingType | EventErrorKind::TypeNotString => (
                ProtocolErrorCode::InvalidEvent,
                "event type must be a non-empty string",
            ),
            EventErrorKind::MissingData => (
                ProtocolErrorCode::InvalidMessage,
                "received message must contain `type` and `data`",
            ),
        };
        Self {
            code,
            message: message.to_owned(),
            event_error: Some(error),
        }
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl Error for ProtocolError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.event_error
            .as_ref()
            .map(|error| error as &(dyn Error + 'static))
    }
}
