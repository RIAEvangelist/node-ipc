#![doc = include_str!("../README.md")]

pub mod codec;
pub mod error;
pub mod event;
pub mod json;
#[cfg(unix)]
pub mod local;
pub mod stream;
pub mod tcp;
pub mod udp;
#[cfg(windows)]
pub mod windows_pipe;

pub use codec::{
    Codec, CodecConfig, DecodedMessage, Message, Profile, ProtocolError, ProtocolErrorCode,
};
pub use error::{Error, Result};
pub use event::{Event, EventError, EventErrorKind};
pub use json::{JsonError, JsonErrorKind, Number, Object, Value as JsonValue};
pub use stream::Connection;
pub use udp::UdpEndpoint;
