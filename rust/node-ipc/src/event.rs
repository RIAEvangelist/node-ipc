//! The language-neutral node-ipc event envelope.

use crate::json::{self, JsonError, Value};
use std::error::Error;
use std::fmt;

/// A node-ipc wire event.
///
/// Serialization always emits exactly `{"type":...,"data":...}` in that
/// order, matching the Node implementation's framed protocol.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Event {
    pub event_type: String,
    pub data: Value,
}

impl Event {
    #[must_use]
    pub fn new(event_type: impl Into<String>, data: impl Into<Value>) -> Self {
        Self {
            event_type: event_type.into(),
            data: data.into(),
        }
    }

    /// Constructs an event with the same empty-object payload used when the
    /// Node encoder is called without data.
    #[must_use]
    pub fn empty(event_type: impl Into<String>) -> Self {
        Self::new(event_type, Value::Object(Vec::new()))
    }

    pub fn from_json(input: &[u8]) -> Result<Self, EventError> {
        let mut event_type = None;
        let mut data = None;
        let was_object = json::parse_root_object_with(input, |key, value| match key.as_ref() {
            "type" => event_type = Some(value),
            "data" => data = Some(value),
            _ => {}
        })
        .map_err(EventError::from)?;

        if !was_object {
            return Self::try_from(json::parse(input).map_err(EventError::from)?);
        }

        let event_type = event_type.ok_or_else(|| EventError::new(EventErrorKind::MissingType))?;
        let Value::String(event_type) = event_type else {
            return Err(EventError::new(EventErrorKind::TypeNotString));
        };
        let data = data.ok_or_else(|| EventError::new(EventErrorKind::MissingData))?;
        Ok(Self { event_type, data })
    }

    pub fn from_json_str(input: &str) -> Result<Self, EventError> {
        Self::from_json(input.as_bytes())
    }

    #[must_use]
    pub fn event_type(&self) -> &str {
        &self.event_type
    }

    #[must_use]
    pub fn into_parts(self) -> (String, Value) {
        (self.event_type, self.data)
    }

    /// Appends the compact event envelope without an intermediate object.
    pub fn write_json(&self, output: &mut Vec<u8>) {
        output.extend_from_slice(b"{\"type\":");
        json::write_string(&self.event_type, output);
        output.extend_from_slice(b",\"data\":");
        self.data.write_json(output);
        output.push(b'}');
    }

    #[must_use]
    pub fn to_json_vec(&self) -> Vec<u8> {
        let mut output = Vec::new();
        self.write_json(&mut output);
        output
    }

    #[must_use]
    pub fn to_json_string(&self) -> String {
        String::from_utf8(self.to_json_vec()).expect("the event writer emits valid UTF-8")
    }

    #[must_use]
    pub fn into_value(self) -> Value {
        Value::Object(vec![
            ("type".to_owned(), Value::String(self.event_type)),
            ("data".to_owned(), self.data),
        ])
    }
}

impl TryFrom<Value> for Event {
    type Error = EventError;

    fn try_from(value: Value) -> Result<Self, Self::Error> {
        let Value::Object(members) = value else {
            return Err(EventError::new(EventErrorKind::RootNotObject));
        };

        // JSON.parse keeps the last value for a duplicate key. Retaining this
        // rule here keeps adversarial or unusual peers aligned with Node.
        let mut event_type = None;
        let mut data = None;
        for (key, value) in members {
            match key.as_str() {
                "type" => event_type = Some(value),
                "data" => data = Some(value),
                _ => {}
            }
        }

        let event_type = event_type.ok_or_else(|| EventError::new(EventErrorKind::MissingType))?;
        let Value::String(event_type) = event_type else {
            return Err(EventError::new(EventErrorKind::TypeNotString));
        };
        let data = data.ok_or_else(|| EventError::new(EventErrorKind::MissingData))?;

        Ok(Self { event_type, data })
    }
}

impl From<Event> for Value {
    fn from(event: Event) -> Self {
        event.into_value()
    }
}

/// The category of an event-envelope decoding failure.
#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum EventErrorKind {
    InvalidJson,
    RootNotObject,
    MissingType,
    TypeNotString,
    MissingData,
}

/// A detailed event-envelope decoding failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventError {
    kind: EventErrorKind,
    json_error: Option<JsonError>,
}

impl EventError {
    const fn new(kind: EventErrorKind) -> Self {
        Self {
            kind,
            json_error: None,
        }
    }

    #[must_use]
    pub const fn kind(&self) -> &EventErrorKind {
        &self.kind
    }

    #[must_use]
    pub const fn json_error(&self) -> Option<&JsonError> {
        self.json_error.as_ref()
    }
}

impl From<JsonError> for EventError {
    fn from(error: JsonError) -> Self {
        Self {
            kind: EventErrorKind::InvalidJson,
            json_error: Some(error),
        }
    }
}

impl fmt::Display for EventError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.kind {
            EventErrorKind::InvalidJson => match &self.json_error {
                Some(error) => write!(formatter, "received message is not valid JSON: {error}"),
                None => formatter.write_str("received message is not valid JSON"),
            },
            EventErrorKind::RootNotObject => {
                formatter.write_str("received message must be a JSON object")
            }
            EventErrorKind::MissingType => {
                formatter.write_str("received message is missing its `type` field")
            }
            EventErrorKind::TypeNotString => formatter.write_str("event type must be a string"),
            EventErrorKind::MissingData => {
                formatter.write_str("received message is missing its `data` field")
            }
        }
    }
}

impl Error for EventError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.json_error
            .as_ref()
            .map(|error| error as &(dyn Error + 'static))
    }
}
