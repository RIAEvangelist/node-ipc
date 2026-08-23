//! A compact, dependency-free JSON value, parser, and writer.
//!
//! Numbers retain their original wire spelling and objects retain insertion
//! order. This matters for lossless protocol inspection and predictable output.

use std::borrow::Cow;
use std::error::Error;
use std::fmt;

/// Maximum container nesting accepted by [`parse`] by default.
pub const DEFAULT_MAX_DEPTH: usize = 256;

/// An owned JSON object in wire insertion order.
pub type Object = Vec<(String, Value)>;

/// An owned JSON value.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(Number),
    String(String),
    Array(Vec<Value>),
    Object(Object),
}

impl Value {
    #[must_use]
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(value) => Some(*value),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_number(&self) -> Option<&Number> {
        match self {
            Self::Number(value) => Some(value),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_number_mut(&mut self) -> Option<&mut Number> {
        match self {
            Self::Number(value) => Some(value),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Self::Array(value) => Some(value),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_object(&self) -> Option<&[(String, Value)]> {
        match self {
            Self::Object(value) => Some(value),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_object_mut(&mut self) -> Option<&mut Object> {
        match self {
            Self::Object(value) => Some(value),
            _ => None,
        }
    }

    /// Returns the last matching member, mirroring JavaScript's handling of
    /// duplicate object keys while retaining every member in the value itself.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.as_object()?
            .iter()
            .rev()
            .find_map(|(name, value)| (name == key).then_some(value))
    }

    /// Writes compact JSON directly into `output` without an intermediate
    /// string or value transformation.
    pub fn write_json(&self, output: &mut Vec<u8>) {
        match self {
            Self::Null => output.extend_from_slice(b"null"),
            Self::Bool(true) => output.extend_from_slice(b"true"),
            Self::Bool(false) => output.extend_from_slice(b"false"),
            Self::Number(value) => output.extend_from_slice(value.as_str().as_bytes()),
            Self::String(value) => write_string(value, output),
            Self::Array(values) => {
                output.push(b'[');
                for (index, value) in values.iter().enumerate() {
                    if index != 0 {
                        output.push(b',');
                    }
                    value.write_json(output);
                }
                output.push(b']');
            }
            Self::Object(members) => {
                output.push(b'{');
                for (index, (key, value)) in members.iter().enumerate() {
                    if index != 0 {
                        output.push(b',');
                    }
                    write_string(key, output);
                    output.push(b':');
                    value.write_json(output);
                }
                output.push(b'}');
            }
        }
    }

    #[must_use]
    pub fn to_json_vec(&self) -> Vec<u8> {
        let mut output = Vec::new();
        self.write_json(&mut output);
        output
    }

    #[must_use]
    pub fn to_json_string(&self) -> String {
        String::from_utf8(self.to_json_vec()).expect("the JSON writer emits valid UTF-8")
    }
}

impl From<()> for Value {
    fn from(_: ()) -> Self {
        Self::Null
    }
}

impl From<bool> for Value {
    fn from(value: bool) -> Self {
        Self::Bool(value)
    }
}

impl From<String> for Value {
    fn from(value: String) -> Self {
        Self::String(value)
    }
}

impl From<&str> for Value {
    fn from(value: &str) -> Self {
        Self::String(value.to_owned())
    }
}

impl From<Number> for Value {
    fn from(value: Number) -> Self {
        Self::Number(value)
    }
}

impl<T> From<Vec<T>> for Value
where
    T: Into<Value>,
{
    fn from(values: Vec<T>) -> Self {
        Self::Array(values.into_iter().map(Into::into).collect())
    }
}

macro_rules! integer_value_from {
    ($($kind:ty),+ $(,)?) => {$(
        impl From<$kind> for Value {
            fn from(value: $kind) -> Self {
                Self::Number(Number(value.to_string()))
            }
        }
    )+};
}

integer_value_from!(
    i8, i16, i32, i64, i128, isize, u8, u16, u32, u64, u128, usize
);

/// A syntactically valid JSON number whose exact lexeme is retained.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct Number(String);

impl Number {
    pub fn new(value: impl Into<String>) -> Result<Self, JsonError> {
        let value = value.into();
        let end = scan_number(value.as_bytes(), 0)?;
        if end != value.len() {
            return Err(JsonError::new(end, JsonErrorKind::InvalidNumber));
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn from_f64(value: f64) -> Option<Self> {
        value.is_finite().then(|| Self(value.to_string()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Replaces this number with an unsigned integer while retaining its
    /// existing string allocation when capacity permits.
    pub fn set_usize(&mut self, value: usize) {
        use std::fmt::Write as _;

        self.0.clear();
        write!(&mut self.0, "{value}").expect("writing to a String cannot fail");
    }
}

impl fmt::Display for Number {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// The category of a JSON parsing failure.
#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum JsonErrorKind {
    UnexpectedEnd,
    UnexpectedByte(u8),
    Expected(&'static str),
    InvalidEscape(u8),
    InvalidUnicodeEscape,
    InvalidUtf8,
    InvalidNumber,
    LoneSurrogate,
    TrailingCharacters,
    DepthLimitExceeded,
}

/// A JSON parsing failure with its zero-based byte offset.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JsonError {
    offset: usize,
    kind: JsonErrorKind,
}

impl JsonError {
    const fn new(offset: usize, kind: JsonErrorKind) -> Self {
        Self { offset, kind }
    }

    #[must_use]
    pub const fn offset(&self) -> usize {
        self.offset
    }

    #[must_use]
    pub const fn kind(&self) -> &JsonErrorKind {
        &self.kind
    }
}

impl fmt::Display for JsonError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid JSON at byte {}: ", self.offset)?;
        match self.kind {
            JsonErrorKind::UnexpectedEnd => formatter.write_str("unexpected end of input"),
            JsonErrorKind::UnexpectedByte(byte) => {
                write!(formatter, "unexpected byte 0x{byte:02x}")
            }
            JsonErrorKind::Expected(expected) => write!(formatter, "expected {expected}"),
            JsonErrorKind::InvalidEscape(byte) => {
                write!(formatter, "invalid escape byte 0x{byte:02x}")
            }
            JsonErrorKind::InvalidUnicodeEscape => formatter.write_str("invalid Unicode escape"),
            JsonErrorKind::InvalidUtf8 => formatter.write_str("string is not valid UTF-8"),
            JsonErrorKind::InvalidNumber => formatter.write_str("invalid number"),
            JsonErrorKind::LoneSurrogate => {
                formatter.write_str("Unicode surrogate is not a valid pair")
            }
            JsonErrorKind::TrailingCharacters => {
                formatter.write_str("trailing characters after the value")
            }
            JsonErrorKind::DepthLimitExceeded => {
                formatter.write_str("container nesting limit exceeded")
            }
        }
    }
}

impl Error for JsonError {}

/// Parses one complete UTF-8 JSON value.
pub fn parse(input: &[u8]) -> Result<Value, JsonError> {
    Parser::new(input).parse()
}

/// Parses one complete JSON value with an explicit container nesting limit.
pub fn parse_with_max_depth(input: &[u8], max_depth: usize) -> Result<Value, JsonError> {
    Parser::with_max_depth(input, max_depth).parse()
}

/// Parses one complete JSON string.
pub fn parse_str(input: &str) -> Result<Value, JsonError> {
    parse(input.as_bytes())
}

/// Streams one complete root object's members through `receive`. `Ok(false)`
/// means the complete value still needs generic parsing because its root token
/// is not an object.
pub(crate) fn parse_root_object_with<'a, F>(input: &'a [u8], receive: F) -> Result<bool, JsonError>
where
    F: FnMut(Cow<'a, str>, Value),
{
    Parser::new(input).parse_root_object_with(receive)
}

/// A single-use JSON parser.
pub struct Parser<'a> {
    input: &'a [u8],
    position: usize,
    max_depth: usize,
}

impl<'a> Parser<'a> {
    #[must_use]
    pub const fn new(input: &'a [u8]) -> Self {
        Self::with_max_depth(input, DEFAULT_MAX_DEPTH)
    }

    #[must_use]
    pub const fn with_max_depth(input: &'a [u8], max_depth: usize) -> Self {
        Self {
            input,
            position: 0,
            max_depth,
        }
    }

    pub fn parse(mut self) -> Result<Value, JsonError> {
        self.skip_whitespace();
        let value = self.parse_value(0)?;
        self.skip_whitespace();
        if self.position != self.input.len() {
            return Err(JsonError::new(
                self.position,
                JsonErrorKind::TrailingCharacters,
            ));
        }
        Ok(value)
    }

    fn parse_root_object_with<F>(&mut self, receive: F) -> Result<bool, JsonError>
    where
        F: FnMut(Cow<'a, str>, Value),
    {
        self.skip_whitespace();
        if self.input.get(self.position) != Some(&b'{') {
            return Ok(false);
        }
        self.parse_object_with(0, receive)?;
        self.skip_whitespace();
        if self.position != self.input.len() {
            return Err(JsonError::new(
                self.position,
                JsonErrorKind::TrailingCharacters,
            ));
        }
        Ok(true)
    }

    fn parse_value(&mut self, depth: usize) -> Result<Value, JsonError> {
        let byte = self
            .input
            .get(self.position)
            .copied()
            .ok_or_else(|| JsonError::new(self.position, JsonErrorKind::UnexpectedEnd))?;

        match byte {
            b'n' => self.parse_literal(b"null", Value::Null),
            b't' => self.parse_literal(b"true", Value::Bool(true)),
            b'f' => self.parse_literal(b"false", Value::Bool(false)),
            b'"' => self.parse_string().map(Value::String),
            b'[' => self.parse_array(depth),
            b'{' => self.parse_object(depth),
            b'-' | b'0'..=b'9' => {
                let start = self.position;
                self.position = scan_number(self.input, start)?;
                let number = std::str::from_utf8(&self.input[start..self.position])
                    .expect("a JSON number contains only ASCII")
                    .to_owned();
                Ok(Value::Number(Number(number)))
            }
            other => Err(JsonError::new(
                self.position,
                JsonErrorKind::UnexpectedByte(other),
            )),
        }
    }

    fn parse_literal(&mut self, literal: &[u8], value: Value) -> Result<Value, JsonError> {
        for (index, expected) in literal.iter().copied().enumerate() {
            match self.input.get(self.position + index).copied() {
                Some(actual) if actual == expected => {}
                Some(actual) => {
                    return Err(JsonError::new(
                        self.position + index,
                        JsonErrorKind::UnexpectedByte(actual),
                    ));
                }
                None => {
                    return Err(JsonError::new(
                        self.input.len(),
                        JsonErrorKind::UnexpectedEnd,
                    ));
                }
            }
        }
        self.position += literal.len();
        Ok(value)
    }

    fn parse_array(&mut self, depth: usize) -> Result<Value, JsonError> {
        self.check_depth(depth)?;
        self.position += 1;
        self.skip_whitespace();
        let mut values = Vec::new();

        if self.consume(b']') {
            return Ok(Value::Array(values));
        }

        loop {
            values.push(self.parse_value(depth + 1)?);
            self.skip_whitespace();
            if self.consume(b']') {
                return Ok(Value::Array(values));
            }
            self.expect(b',', "`,` or `]`")?;
            self.skip_whitespace();
        }
    }

    fn parse_object(&mut self, depth: usize) -> Result<Value, JsonError> {
        let mut members = Vec::new();
        self.parse_object_with(depth, |key, value| {
            members.push((key.into_owned(), value));
        })?;
        Ok(Value::Object(members))
    }

    fn parse_object_with<F>(&mut self, depth: usize, mut receive: F) -> Result<(), JsonError>
    where
        F: FnMut(Cow<'a, str>, Value),
    {
        self.check_depth(depth)?;
        self.position += 1;
        self.skip_whitespace();

        if self.consume(b'}') {
            return Ok(());
        }

        loop {
            if self.input.get(self.position) != Some(&b'"') {
                return Err(JsonError::new(
                    self.position,
                    JsonErrorKind::Expected("an object member string"),
                ));
            }
            let key = self.parse_key()?;
            self.skip_whitespace();
            self.expect(b':', "`:` after an object member name")?;
            self.skip_whitespace();
            let value = self.parse_value(depth + 1)?;
            receive(key, value);
            self.skip_whitespace();
            if self.consume(b'}') {
                return Ok(());
            }
            self.expect(b',', "`,` or `}`")?;
            self.skip_whitespace();
        }
    }

    fn parse_key(&mut self) -> Result<Cow<'a, str>, JsonError> {
        let quote = self.position;
        self.position += 1;
        let start = self.position;

        loop {
            let byte = self
                .input
                .get(self.position)
                .copied()
                .ok_or_else(|| JsonError::new(self.position, JsonErrorKind::UnexpectedEnd))?;
            match byte {
                b'"' => {
                    let key = std::str::from_utf8(&self.input[start..self.position]).map_err(
                        |error| {
                            JsonError::new(start + error.valid_up_to(), JsonErrorKind::InvalidUtf8)
                        },
                    )?;
                    self.position += 1;
                    return Ok(Cow::Borrowed(key));
                }
                b'\\' => {
                    self.position = quote;
                    return self.parse_string().map(Cow::Owned);
                }
                0x00..=0x1f => {
                    return Err(JsonError::new(
                        self.position,
                        JsonErrorKind::UnexpectedByte(byte),
                    ));
                }
                _ => self.position += 1,
            }
        }
    }

    fn parse_string(&mut self) -> Result<String, JsonError> {
        self.position += 1;
        let mut segment_start = self.position;
        let mut output = String::new();

        loop {
            let byte = self
                .input
                .get(self.position)
                .copied()
                .ok_or_else(|| JsonError::new(self.position, JsonErrorKind::UnexpectedEnd))?;

            match byte {
                b'"' => {
                    self.append_utf8_segment(segment_start, self.position, &mut output)?;
                    self.position += 1;
                    return Ok(output);
                }
                b'\\' => {
                    self.append_utf8_segment(segment_start, self.position, &mut output)?;
                    let escape_offset = self.position;
                    self.position += 1;
                    let escaped = self.input.get(self.position).copied().ok_or_else(|| {
                        JsonError::new(self.position, JsonErrorKind::UnexpectedEnd)
                    })?;
                    self.position += 1;

                    match escaped {
                        b'"' => output.push('"'),
                        b'\\' => output.push('\\'),
                        b'/' => output.push('/'),
                        b'b' => output.push('\u{0008}'),
                        b'f' => output.push('\u{000c}'),
                        b'n' => output.push('\n'),
                        b'r' => output.push('\r'),
                        b't' => output.push('\t'),
                        b'u' => {
                            let first = self.parse_hex_quad()?;
                            let scalar = if (0xd800..=0xdbff).contains(&first) {
                                if self.input.get(self.position..self.position + 2) != Some(b"\\u")
                                {
                                    return Err(JsonError::new(
                                        escape_offset,
                                        JsonErrorKind::LoneSurrogate,
                                    ));
                                }
                                self.position += 2;
                                let second = self.parse_hex_quad()?;
                                if !(0xdc00..=0xdfff).contains(&second) {
                                    return Err(JsonError::new(
                                        escape_offset,
                                        JsonErrorKind::LoneSurrogate,
                                    ));
                                }
                                0x1_0000
                                    + (((first as u32) - 0xd800) << 10)
                                    + ((second as u32) - 0xdc00)
                            } else if (0xdc00..=0xdfff).contains(&first) {
                                return Err(JsonError::new(
                                    escape_offset,
                                    JsonErrorKind::LoneSurrogate,
                                ));
                            } else {
                                first as u32
                            };
                            output.push(char::from_u32(scalar).ok_or_else(|| {
                                JsonError::new(escape_offset, JsonErrorKind::InvalidUnicodeEscape)
                            })?);
                        }
                        other => {
                            return Err(JsonError::new(
                                escape_offset,
                                JsonErrorKind::InvalidEscape(other),
                            ));
                        }
                    }
                    segment_start = self.position;
                }
                0x00..=0x1f => {
                    return Err(JsonError::new(
                        self.position,
                        JsonErrorKind::UnexpectedByte(byte),
                    ));
                }
                _ => self.position += 1,
            }
        }
    }

    fn parse_hex_quad(&mut self) -> Result<u16, JsonError> {
        let start = self.position;
        let mut value = 0_u16;
        for _ in 0..4 {
            let byte = self
                .input
                .get(self.position)
                .copied()
                .ok_or_else(|| JsonError::new(self.position, JsonErrorKind::UnexpectedEnd))?;
            let digit = match byte {
                b'0'..=b'9' => (byte - b'0') as u16,
                b'a'..=b'f' => (byte - b'a' + 10) as u16,
                b'A'..=b'F' => (byte - b'A' + 10) as u16,
                _ => {
                    return Err(JsonError::new(
                        self.position,
                        JsonErrorKind::InvalidUnicodeEscape,
                    ));
                }
            };
            value = (value << 4) | digit;
            self.position += 1;
        }
        debug_assert_eq!(self.position, start + 4);
        Ok(value)
    }

    fn append_utf8_segment(
        &self,
        start: usize,
        end: usize,
        output: &mut String,
    ) -> Result<(), JsonError> {
        match std::str::from_utf8(&self.input[start..end]) {
            Ok(segment) => {
                output.push_str(segment);
                Ok(())
            }
            Err(error) => Err(JsonError::new(
                start + error.valid_up_to(),
                JsonErrorKind::InvalidUtf8,
            )),
        }
    }

    fn check_depth(&self, depth: usize) -> Result<(), JsonError> {
        if depth >= self.max_depth {
            return Err(JsonError::new(
                self.position,
                JsonErrorKind::DepthLimitExceeded,
            ));
        }
        Ok(())
    }

    fn skip_whitespace(&mut self) {
        while matches!(
            self.input.get(self.position),
            Some(b' ' | b'\n' | b'\r' | b'\t')
        ) {
            self.position += 1;
        }
    }

    fn consume(&mut self, expected: u8) -> bool {
        if self.input.get(self.position) == Some(&expected) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn expect(&mut self, expected: u8, description: &'static str) -> Result<(), JsonError> {
        if self.consume(expected) {
            Ok(())
        } else {
            Err(JsonError::new(
                self.position,
                JsonErrorKind::Expected(description),
            ))
        }
    }
}

/// Writes one JSON string directly into `output`.
pub fn write_string(value: &str, output: &mut Vec<u8>) {
    const HEX: &[u8; 16] = b"0123456789abcdef";

    output.push(b'"');
    let bytes = value.as_bytes();
    let mut segment_start = 0;

    for (index, byte) in bytes.iter().copied().enumerate() {
        let escaped = matches!(byte, b'"' | b'\\' | 0x00..=0x1f);
        if !escaped {
            continue;
        }

        output.extend_from_slice(&bytes[segment_start..index]);
        match byte {
            b'"' => output.extend_from_slice(b"\\\""),
            b'\\' => output.extend_from_slice(b"\\\\"),
            0x08 => output.extend_from_slice(b"\\b"),
            0x0c => output.extend_from_slice(b"\\f"),
            b'\n' => output.extend_from_slice(b"\\n"),
            b'\r' => output.extend_from_slice(b"\\r"),
            b'\t' => output.extend_from_slice(b"\\t"),
            control => {
                output.extend_from_slice(b"\\u00");
                output.push(HEX[(control >> 4) as usize]);
                output.push(HEX[(control & 0x0f) as usize]);
            }
        }
        segment_start = index + 1;
    }

    output.extend_from_slice(&bytes[segment_start..]);
    output.push(b'"');
}

fn scan_number(input: &[u8], start: usize) -> Result<usize, JsonError> {
    let mut position = start;
    if input.get(position) == Some(&b'-') {
        position += 1;
    }

    match input.get(position).copied() {
        Some(b'0') => {
            position += 1;
            if matches!(input.get(position), Some(b'0'..=b'9')) {
                return Err(JsonError::new(position, JsonErrorKind::InvalidNumber));
            }
        }
        Some(b'1'..=b'9') => {
            position += 1;
            while matches!(input.get(position), Some(b'0'..=b'9')) {
                position += 1;
            }
        }
        _ => return Err(JsonError::new(position, JsonErrorKind::InvalidNumber)),
    }

    if input.get(position) == Some(&b'.') {
        position += 1;
        let fraction_start = position;
        while matches!(input.get(position), Some(b'0'..=b'9')) {
            position += 1;
        }
        if position == fraction_start {
            return Err(JsonError::new(position, JsonErrorKind::InvalidNumber));
        }
    }

    if matches!(input.get(position), Some(b'e' | b'E')) {
        position += 1;
        if matches!(input.get(position), Some(b'+' | b'-')) {
            position += 1;
        }
        let exponent_start = position;
        while matches!(input.get(position), Some(b'0'..=b'9')) {
            position += 1;
        }
        if position == exponent_start {
            return Err(JsonError::new(position, JsonErrorKind::InvalidNumber));
        }
    }

    Ok(position)
}
