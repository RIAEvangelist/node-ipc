use node_ipc::codec::{
    DEFAULT_DELIMITER, DEFAULT_MAX_EVENT_NAME_LENGTH, DEFAULT_MAX_MESSAGE_SIZE,
    DEFAULT_MAX_PENDING_BYTES, DEFAULT_MESSAGE_TIMEOUT, RESERVED_EVENT_TYPES, UNSAFE_EVENT_TYPES,
    is_reserved_event_type, is_unsafe_event_type,
};
use node_ipc::json::{self, JsonErrorKind};
use node_ipc::{
    Codec, CodecConfig, Connection, DecodedMessage, Error as IpcError, Event, EventError,
    EventErrorKind, JsonError, JsonValue, Message, Number, Profile, ProtocolError,
    ProtocolErrorCode, UdpEndpoint, tcp,
};
use std::collections::VecDeque;
use std::env;
use std::error::Error as StdError;
#[cfg(unix)]
use std::fs;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::panic::{AssertUnwindSafe, catch_unwind};
#[cfg(unix)]
use std::path::PathBuf;
use std::process;
#[cfg(windows)]
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use vanilla_test::{TestError, VanillaTest};

#[cfg(unix)]
use node_ipc::local::{self, LocalListener};
#[cfg(windows)]
use node_ipc::windows_pipe::{NamedPipeListener, NamedPipeStream, pipe_name};

const EXPECTED_CASES: usize = 38;
const TRANSPORT_TIMEOUT: Duration = Duration::from_secs(5);
const ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(2);
#[cfg(windows)]
const WINDOWS_CHILD_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(windows)]
const WINDOWS_CHILD_TERMINATION_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(windows)]
const WINDOWS_CHILD_POLL_INTERVAL: Duration = Duration::from_millis(10);
#[cfg(windows)]
const WINDOWS_FRAMED_CHILD: &str = "--node-ipc-internal-local-framed";
#[cfg(windows)]
const WINDOWS_RAW_CHILD: &str = "--node-ipc-internal-local-raw";
static NEXT_ENDPOINT: AtomicU64 = AtomicU64::new(1);

type TransportError = Box<dyn StdError + Send + Sync + 'static>;
type TransportResult<T = ()> = Result<T, TransportError>;

fn main() {
    #[cfg(windows)]
    if let Some(result) = run_windows_child_mode() {
        if let Err(error) = result {
            eprintln!("Windows local-transport child failure: {error}");
            process::exit(1);
        }
        return;
    }

    match run() {
        Ok(true) => {}
        Ok(false) => process::exit(1),
        Err(error) => {
            eprintln!("vanilla-test lifecycle failure: {error}");
            process::exit(1);
        }
    }
}

fn run() -> Result<bool, TestError> {
    let mut test = VanillaTest::new();
    let mut diagnostics = Vec::new();

    json_cases(&mut test, &mut diagnostics)?;
    event_error_cases(&mut test, &mut diagnostics)?;
    profile_config_cases(&mut test, &mut diagnostics)?;
    codec_cases(&mut test, &mut diagnostics)?;
    guarded_assured_cases(&mut test, &mut diagnostics)?;
    connection_cases(&mut test, &mut diagnostics)?;
    transport_cases(&mut test, &mut diagnostics)?;

    let result = test.report()?;
    print!("{}", result.report);
    for diagnostic in &diagnostics {
        eprintln!("{diagnostic}");
    }

    let exact_pass = result.ok
        && result.total == EXPECTED_CASES
        && result.failure_count == 0
        && result.passed.len() == EXPECTED_CASES
        && result.failed.is_empty();
    if !exact_pass {
        eprintln!(
            "expected {EXPECTED_CASES}/{EXPECTED_CASES}, observed {}/{} with {} failures",
            result.passed.len(),
            result.total,
            result.failure_count
        );
    }
    Ok(exact_pass)
}

fn case<F>(
    test: &mut VanillaTest,
    diagnostics: &mut Vec<String>,
    description: &'static str,
    body: F,
) -> Result<(), TestError>
where
    F: FnOnce(),
{
    test.expects(description)?;
    match catch_unwind(AssertUnwindSafe(body)) {
        Ok(()) => test.pass()?,
        Err(payload) => {
            test.fail()?;
            diagnostics.push(format!("{description}: {}", panic_text(payload)));
        }
    }
    test.done()
}

fn panic_text(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_owned()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "case panicked with a non-string payload".to_owned()
    }
}

fn protocol_failure<T>(result: Result<T, ProtocolError>) -> ProtocolError {
    match result {
        Ok(_) => panic!("expected a protocol failure"),
        Err(error) => error,
    }
}

fn ipc_failure<T>(result: node_ipc::Result<T>) -> IpcError {
    match result {
        Ok(_) => panic!("expected an IPC failure"),
        Err(error) => error,
    }
}

fn json_cases(test: &mut VanillaTest, diagnostics: &mut Vec<String>) -> Result<(), TestError> {
    case(
        test,
        diagnostics,
        "JSON preserves object order, duplicates, number lexemes, and Unicode escapes",
        || {
            let value =
                json::parse(br#"{"a":1e+02,"a":-0,"s":"A\uD83D\uDE03\n","items":[true,null]}"#)
                    .expect("valid JSON should parse");
            assert_eq!(
                value.to_json_string(),
                r#"{"a":1e+02,"a":-0,"s":"A😃\n","items":[true,null]}"#
            );
            assert_eq!(
                value
                    .get("a")
                    .and_then(JsonValue::as_number)
                    .map(Number::as_str),
                Some("-0")
            );
        },
    )?;

    case(
        test,
        diagnostics,
        "JSON values expose typed accessors and lossless integer conversions",
        || {
            let value = JsonValue::Object(vec![
                ("flag".to_owned(), true.into()),
                ("count".to_owned(), 7_u8.into()),
                ("text".to_owned(), "ok".into()),
                ("list".to_owned(), vec![1_i16, 2_i16].into()),
            ]);
            assert_eq!(value.as_object().map(<[_]>::len), Some(4));
            assert_eq!(value.get("flag").and_then(JsonValue::as_bool), Some(true));
            assert_eq!(
                value
                    .get("count")
                    .and_then(JsonValue::as_number)
                    .map(Number::as_str),
                Some("7")
            );
            assert_eq!(value.get("text").and_then(JsonValue::as_str), Some("ok"));
            assert_eq!(
                value.get("list").and_then(JsonValue::as_array),
                Some([JsonValue::from(1_i16), JsonValue::from(2_i16)].as_slice())
            );
            assert_eq!(value.get("flag").and_then(JsonValue::as_str), None);
        },
    )?;

    case(
        test,
        diagnostics,
        "JSON numbers validate, retain, mutate, and reject non-finite floats",
        || {
            let number = Number::new("-0.50e+2").expect("valid number should construct");
            assert_eq!(number.as_str(), "-0.50e+2");
            assert_eq!(number.to_string(), "-0.50e+2");

            let mut value = JsonValue::from(number);
            value
                .as_number_mut()
                .expect("number accessor should match")
                .set_usize(42);
            assert_eq!(value.to_json_string(), "42");
            assert_eq!(
                Number::from_f64(1.25).as_ref().map(Number::as_str),
                Some("1.25")
            );
            assert!(Number::from_f64(f64::NAN).is_none());
            assert!(Number::from_f64(f64::INFINITY).is_none());
            assert!(Number::from_f64(f64::NEG_INFINITY).is_none());

            let error = Number::new("01").expect_err("leading zero must fail");
            assert_eq!(error.kind(), &JsonErrorKind::InvalidNumber);
            assert_eq!(error.offset(), 1);
        },
    )?;

    case(
        test,
        diagnostics,
        "JSON errors retain exact kinds and byte offsets",
        || {
            let error = json::parse(b"").expect_err("empty input must fail");
            assert_eq!(error.kind(), &JsonErrorKind::UnexpectedEnd);
            assert_eq!(error.offset(), 0);

            let error = json::parse(br#""\q""#).expect_err("invalid escape must fail");
            assert_eq!(error.kind(), &JsonErrorKind::InvalidEscape(b'q'));
            assert_eq!(error.offset(), 1);

            let error = json::parse(&[b'"', 0xff, b'"']).expect_err("invalid UTF-8 must fail");
            assert_eq!(error.kind(), &JsonErrorKind::InvalidUtf8);
            assert_eq!(error.offset(), 1);

            let error = json::parse(br#""\uD800""#).expect_err("lone surrogate must fail");
            assert_eq!(error.kind(), &JsonErrorKind::LoneSurrogate);
            assert_eq!(error.offset(), 1);

            let error = json::parse(b"true false").expect_err("trailing token must fail");
            assert_eq!(error.kind(), &JsonErrorKind::TrailingCharacters);
            assert_eq!(error.offset(), 5);
        },
    )?;

    case(
        test,
        diagnostics,
        "JSON depth limits reject only containers at the configured boundary",
        || {
            assert_eq!(
                json::parse_with_max_depth(b"[]", 1).expect("root container should fit"),
                JsonValue::Array(Vec::new())
            );
            let error = json::parse_with_max_depth(b"[[]]", 1)
                .expect_err("nested container should exceed the limit");
            assert_eq!(error.kind(), &JsonErrorKind::DepthLimitExceeded);
            assert_eq!(error.offset(), 1);
            assert_eq!(
                json::parse_with_max_depth(b"0", 0).expect("scalar should not consume depth"),
                JsonValue::from(0_i32)
            );
        },
    )
}

fn event_error_cases(
    test: &mut VanillaTest,
    diagnostics: &mut Vec<String>,
) -> Result<(), TestError> {
    case(
        test,
        diagnostics,
        "events serialize the canonical type-data envelope and empty payload",
        || {
            let event = Event::new(
                "app.message",
                JsonValue::Object(vec![
                    ("id".to_owned(), 1_i32.into()),
                    ("message".to_owned(), "hello".into()),
                ]),
            );
            assert_eq!(
                event.to_json_string(),
                r#"{"type":"app.message","data":{"id":1,"message":"hello"}}"#
            );
            assert_eq!(
                Event::empty("ready").to_json_string(),
                r#"{"type":"ready","data":{}}"#
            );
            let (event_type, data) = event.into_parts();
            assert_eq!(event_type, "app.message");
            assert_eq!(data.to_json_string(), r#"{"id":1,"message":"hello"}"#);
        },
    )?;

    case(
        test,
        diagnostics,
        "event decoding ignores extras and keeps the last duplicate type and data",
        || {
            let event = Event::from_json_str(
                r#"{"type":"first","ignored":1,"data":null,"type":"last","data":{"ok":true}}"#,
            )
            .expect("valid event should decode");
            assert_eq!(event.event_type(), "last");
            assert_eq!(event.data.to_json_string(), r#"{"ok":true}"#);
        },
    )?;

    case(
        test,
        diagnostics,
        "event errors distinguish malformed JSON and envelope shape failures",
        || {
            let error = Event::from_json_str("{").expect_err("malformed JSON must fail");
            assert_eq!(error.kind(), &EventErrorKind::InvalidJson);
            let json_error = error.json_error().expect("JSON detail should be retained");
            assert_eq!(
                json_error.kind(),
                &JsonErrorKind::Expected("an object member string")
            );
            assert_eq!(json_error.offset(), 1);

            assert_eq!(
                Event::from_json_str("[]")
                    .expect_err("array envelope must fail")
                    .kind(),
                &EventErrorKind::RootNotObject
            );
            assert_eq!(
                Event::from_json_str(r#"{"data":0}"#)
                    .expect_err("missing type must fail")
                    .kind(),
                &EventErrorKind::MissingType
            );
            assert_eq!(
                Event::from_json_str(r#"{"type":0,"data":0}"#)
                    .expect_err("numeric type must fail")
                    .kind(),
                &EventErrorKind::TypeNotString
            );
            assert_eq!(
                Event::from_json_str(r#"{"type":"x"}"#)
                    .expect_err("missing data must fail")
                    .kind(),
                &EventErrorKind::MissingData
            );
        },
    )?;

    case(
        test,
        diagnostics,
        "event errors map to stable protocol codes and preserve their source",
        || {
            for (input, code) in [
                ("{", ProtocolErrorCode::InvalidJson),
                ("[]", ProtocolErrorCode::InvalidMessage),
                (r#"{"data":0}"#, ProtocolErrorCode::InvalidEvent),
                (r#"{"type":"x"}"#, ProtocolErrorCode::InvalidMessage),
            ] {
                let event_error =
                    Event::from_json_str(input).expect_err("invalid envelope must fail");
                let protocol_error = ProtocolError::from(event_error);
                assert_eq!(protocol_error.code(), code);
                assert_eq!(protocol_error.code_str(), code.as_str());
            }

            let event_error = Event::from_json_str("{").expect_err("malformed JSON must fail");
            let protocol_error = ProtocolError::from(event_error);
            let event_source = StdError::source(&protocol_error)
                .and_then(|source| source.downcast_ref::<EventError>())
                .expect("protocol source should be EventError");
            assert!(
                StdError::source(event_source)
                    .and_then(|source| source.downcast_ref::<JsonError>())
                    .is_some()
            );
        },
    )?;

    case(
        test,
        diagnostics,
        "top-level errors distinguish I/O and protocol failures",
        || {
            let io_error = IpcError::from(io::Error::new(io::ErrorKind::NotFound, "missing"));
            assert_eq!(io_error.to_string(), "I/O error: missing");
            assert!(io_error.protocol_error().is_none());
            assert!(io_error.peer().is_none());
            assert_eq!(
                StdError::source(&io_error).map(ToString::to_string),
                Some("missing".to_owned())
            );

            let protocol_error =
                IpcError::from(ProtocolError::new(ProtocolErrorCode::WrongProfile, "bad"));
            assert_eq!(protocol_error.to_string(), "ERR_IPC_WRONG_PROFILE: bad");
            assert_eq!(
                protocol_error.protocol_error().map(ProtocolError::code),
                Some(ProtocolErrorCode::WrongProfile)
            );
            assert!(protocol_error.peer().is_none());
            assert!(StdError::source(&protocol_error).is_some());
        },
    )
}

fn profile_config_cases(
    test: &mut VanillaTest,
    diagnostics: &mut Vec<String>,
) -> Result<(), TestError> {
    case(
        test,
        diagnostics,
        "profile names parse and expose framed and guarded capabilities",
        || {
            for (name, profile, framed, guarded) in [
                ("raw", Profile::Raw, false, false),
                ("fast", Profile::Fast, true, false),
                ("guarded", Profile::Guarded, true, true),
                ("assured", Profile::Assured, true, true),
            ] {
                assert_eq!(
                    name.parse::<Profile>().expect("profile should parse"),
                    profile
                );
                assert_eq!(profile.as_str(), name);
                assert_eq!(profile.to_string(), name);
                assert_eq!(profile.is_framed(), framed);
                assert_eq!(profile.is_guarded(), guarded);
            }
            let error = "FAST"
                .parse::<Profile>()
                .expect_err("profile parsing is case-sensitive");
            assert_eq!(error.code(), ProtocolErrorCode::InvalidConfiguration);
        },
    )?;

    case(
        test,
        diagnostics,
        "codec constructors expose the exact v14 defaults",
        || {
            let default = CodecConfig::default();
            assert_eq!(default.profile, Profile::Fast);
            assert_eq!(default.delimiter, DEFAULT_DELIMITER);
            assert_eq!(default.max_message_size, DEFAULT_MAX_MESSAGE_SIZE);
            assert_eq!(default.max_pending_bytes, DEFAULT_MAX_PENDING_BYTES);
            assert_eq!(default.max_event_name_length, DEFAULT_MAX_EVENT_NAME_LENGTH);
            assert_eq!(default.message_timeout, Some(DEFAULT_MESSAGE_TIMEOUT));
            assert!(!default.allow_reserved_events);
            assert!(default.allowed_events.is_empty());
            assert_eq!(CodecConfig::raw().profile, Profile::Raw);
            assert_eq!(CodecConfig::fast().profile, Profile::Fast);
            assert_eq!(CodecConfig::guarded().profile, Profile::Guarded);

            let assured = CodecConfig::assured(["ping", "pong"]);
            assert_eq!(assured.profile, Profile::Assured);
            assert_eq!(assured.allowed_events.len(), 2);
            assert!(assured.allowed_events.contains("ping"));
            assert!(assured.allowed_events.contains("pong"));
        },
    )?;

    case(
        test,
        diagnostics,
        "codec construction rejects each invalid guarded or assured configuration",
        || {
            let mut empty_delimiter = CodecConfig::fast();
            empty_delimiter.delimiter.clear();

            let mut zero_message = CodecConfig::guarded();
            zero_message.max_message_size = 0;

            let mut zero_pending = CodecConfig::guarded();
            zero_pending.max_pending_bytes = 0;

            let mut zero_event_name = CodecConfig::guarded();
            zero_event_name.max_event_name_length = 0;

            for config in [
                empty_delimiter,
                zero_message,
                zero_pending,
                zero_event_name,
                CodecConfig::assured(std::iter::empty::<&str>()),
            ] {
                let error = protocol_failure(Codec::new(config));
                assert_eq!(error.code(), ProtocolErrorCode::InvalidConfiguration);
            }
        },
    )?;

    case(
        test,
        diagnostics,
        "codec construction normalizes zero timeout and assured reserved-event policy",
        || {
            let mut guarded = CodecConfig::guarded().with_delimiter(b"<END>".to_vec());
            guarded.message_timeout = Some(Duration::ZERO);
            let guarded = Codec::new(guarded).expect("guarded config should construct");
            assert_eq!(guarded.config().message_timeout, None);
            assert_eq!(guarded.config().delimiter, b"<END>");

            let mut assured = CodecConfig::assured(["ping"]);
            assured.allow_reserved_events = true;
            let assured = Codec::new(assured).expect("assured config should construct");
            assert!(!assured.config().allow_reserved_events);
        },
    )?;

    case(
        test,
        diagnostics,
        "reserved and unsafe event-name helpers match their public sets",
        || {
            assert_eq!(
                RESERVED_EVENT_TYPES,
                &[
                    "start",
                    "connect",
                    "disconnect",
                    "destroy",
                    "close",
                    "socket.disconnected",
                    "error",
                    "data",
                ]
            );
            assert_eq!(
                UNSAFE_EVENT_TYPES,
                &[
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
                ]
            );
            assert!(
                RESERVED_EVENT_TYPES
                    .iter()
                    .all(|name| is_reserved_event_type(name))
            );
            assert!(
                UNSAFE_EVENT_TYPES
                    .iter()
                    .all(|name| is_unsafe_event_type(name))
            );
            assert!(!is_reserved_event_type("app.message"));
            assert!(!is_unsafe_event_type("app.message"));

            let fast = Codec::default();
            assert!(fast.validate_event_type("connect").is_ok());
            assert!(fast.validate_event_type("constructor").is_ok());
        },
    )
}

fn codec_cases(test: &mut VanillaTest, diagnostics: &mut Vec<String>) -> Result<(), TestError> {
    case(
        test,
        diagnostics,
        "fast encoding clears reusable output and appends the configured delimiter",
        || {
            let codec = Codec::new(CodecConfig::fast().with_delimiter(b"<END>".to_vec()))
                .expect("codec should construct");
            let mut output = b"stale".to_vec();
            codec
                .encode_into(&Event::new("ping", "hello"), &mut output)
                .expect("event should encode");
            assert_eq!(output, br#"{"type":"ping","data":"hello"}<END>"#);
        },
    )?;

    case(
        test,
        diagnostics,
        "fast decoding completes a frame when a multi-byte delimiter crosses chunks",
        || {
            let mut codec = Codec::new(CodecConfig::fast().with_delimiter(b"<END>".to_vec()))
                .expect("codec should construct");
            let first = br#"{"type":"ping","data":1}<EN"#;
            assert!(
                codec
                    .push(first)
                    .expect("partial push should succeed")
                    .is_empty()
            );
            assert!(codec.has_partial_frame());
            assert_eq!(codec.partial_len(), first.len());

            assert_eq!(
                codec
                    .push(b"D>")
                    .expect("delimiter completion should decode"),
                vec![Message::Event(Event::new("ping", 1_i32))]
            );
            assert!(!codec.has_partial_frame());
            assert_eq!(codec.partial_len(), 0);
        },
    )?;

    case(
        test,
        diagnostics,
        "fast decoding preserves multiple-message order and a trailing partial frame",
        || {
            let mut codec = Codec::default();
            let chunk = concat!(
                "{\"type\":\"one\",\"data\":1}\u{000c}",
                "{\"type\":\"two\",\"data\":2}\u{000c}",
                "{\"type\":\"three\""
            );
            assert_eq!(
                codec
                    .push(chunk.as_bytes())
                    .expect("complete frames should decode"),
                vec![
                    Message::Event(Event::new("one", 1_i32)),
                    Message::Event(Event::new("two", 2_i32)),
                ]
            );
            assert_eq!(codec.partial_len(), br#"{"type":"three""#.len());
            assert_eq!(
                codec
                    .push(b",\"data\":3}\x0c")
                    .expect("trailing frame should complete"),
                vec![Message::Event(Event::new("three", 3_i32))]
            );
            assert!(!codec.has_partial_frame());
        },
    )?;

    case(
        test,
        diagnostics,
        "push_with delivers valid frames before a later frame error",
        || {
            let bytes = b"{\"type\":\"ok\",\"data\":1}\x0c{\x0c";
            let mut codec = Codec::default();
            let mut delivered = Vec::new();
            let error = match codec.push_with(bytes, |message| {
                delivered.push(message.into_owned());
            }) {
                Ok(_) => panic!("later malformed frame must fail"),
                Err(error) => error,
            };
            assert_eq!(error.code(), ProtocolErrorCode::InvalidJson);
            assert_eq!(delivered, vec![Message::Event(Event::new("ok", 1_i32))]);

            let mut convenience = Codec::default();
            let error = protocol_failure(convenience.push(bytes));
            assert_eq!(error.code(), ProtocolErrorCode::InvalidJson);
        },
    )?;

    case(
        test,
        diagnostics,
        "raw mode borrows callback bytes and owns convenience results without framing",
        || {
            let input = [0x00, 0xff, 0x0c];
            let mut codec = Codec::new(CodecConfig::raw()).expect("raw codec should construct");
            let mut borrowed_pointer = None;
            let count = codec
                .push_with(&input, |message| match message {
                    DecodedMessage::Raw(bytes) => {
                        assert_eq!(bytes, input);
                        borrowed_pointer = Some(bytes.as_ptr());
                    }
                    DecodedMessage::Event(_) => panic!("raw profile emitted an event"),
                })
                .expect("raw callback should succeed");
            assert_eq!(count, 1);
            assert_eq!(borrowed_pointer, Some(input.as_ptr()));
            assert!(
                codec
                    .push(b"")
                    .expect("empty raw push should succeed")
                    .is_empty()
            );
            assert_eq!(
                codec
                    .push(&input)
                    .expect("raw convenience push should succeed"),
                vec![Message::Raw(input.to_vec())]
            );

            let mut output = b"stale".to_vec();
            codec
                .encode_raw_into(&input, &mut output)
                .expect("raw encode should succeed");
            assert_eq!(output, input);
            assert!(codec.finish().is_ok());
        },
    )
}

fn guarded_assured_cases(
    test: &mut VanillaTest,
    diagnostics: &mut Vec<String>,
) -> Result<(), TestError> {
    case(
        test,
        diagnostics,
        "raw and framed encoders reject the opposite profile and clear output",
        || {
            let raw = Codec::new(CodecConfig::raw()).expect("raw codec should construct");
            let mut output = b"stale".to_vec();
            let error = protocol_failure(raw.encode_into(&Event::new("ping", 1_i32), &mut output));
            assert_eq!(error.code(), ProtocolErrorCode::WrongProfile);
            assert!(output.is_empty());

            let fast = Codec::default();
            output.extend_from_slice(b"stale");
            let error = protocol_failure(fast.encode_raw_into(b"raw", &mut output));
            assert_eq!(error.code(), ProtocolErrorCode::WrongProfile);
            assert!(output.is_empty());
        },
    )?;

    case(
        test,
        diagnostics,
        "guarded event validation enforces empty, UTF-16 length, unsafe, and reserved names",
        || {
            let guarded = Codec::new(CodecConfig::guarded()).expect("codec should construct");
            assert_eq!(
                protocol_failure(guarded.validate_event_type("")).code(),
                ProtocolErrorCode::InvalidEvent
            );
            assert_eq!(
                protocol_failure(guarded.validate_event_type("constructor")).code(),
                ProtocolErrorCode::InvalidEvent
            );
            assert_eq!(
                protocol_failure(guarded.validate_event_type("connect")).code(),
                ProtocolErrorCode::ReservedEvent
            );
            assert!(guarded.validate_event_type("app.message").is_ok());

            let mut short = CodecConfig::guarded();
            short.max_event_name_length = 2;
            let short = Codec::new(short).expect("short-name codec should construct");
            assert!(short.validate_event_type("💡").is_ok());
            assert_eq!(
                protocol_failure(short.validate_event_type("💡a")).code(),
                ProtocolErrorCode::EventTooLarge
            );

            let mut reserved = CodecConfig::guarded();
            reserved.allow_reserved_events = true;
            let reserved = Codec::new(reserved).expect("reserved codec should construct");
            assert!(reserved.validate_event_type("connect").is_ok());
        },
    )?;

    case(
        test,
        diagnostics,
        "guarded frame limits apply symmetrically to encode and decode",
        || {
            let event = Event::new("x", 0_i32);
            assert_eq!(event.to_json_vec().len(), 21);

            let mut boundary = CodecConfig::guarded();
            boundary.max_message_size = 21;
            let boundary = Codec::new(boundary).expect("boundary codec should construct");
            assert_eq!(
                boundary
                    .encode(&event)
                    .expect("boundary frame should fit")
                    .len(),
                22
            );

            let mut limited_config = CodecConfig::guarded();
            limited_config.max_message_size = 20;
            let limited =
                Codec::new(limited_config.clone()).expect("limited codec should construct");
            let mut output = b"stale".to_vec();
            let error = protocol_failure(limited.encode_into(&event, &mut output));
            assert_eq!(error.code(), ProtocolErrorCode::FrameTooLarge);
            assert!(output.is_empty());

            let mut decoder = Codec::new(limited_config).expect("limited decoder should construct");
            let error = protocol_failure(decoder.push(b"{\"type\":\"x\",\"data\":0}\x0c"));
            assert_eq!(error.code(), ProtocolErrorCode::FrameTooLarge);
            assert!(!decoder.has_partial_frame());
        },
    )?;

    case(
        test,
        diagnostics,
        "partial-frame state preserves its start, times out, finishes, and clears",
        || {
            let mut fast = Codec::default();
            assert!(
                fast.push(b"{")
                    .expect("partial push should succeed")
                    .is_empty()
            );
            assert_eq!(
                protocol_failure(fast.finish()).code(),
                ProtocolErrorCode::IncompleteFrame
            );
            fast.clear_partial();
            assert!(!fast.has_partial_frame());
            assert!(fast.finish().is_ok());

            let mut stable_config = CodecConfig::guarded();
            stable_config.message_timeout = Some(Duration::from_secs(1));
            let mut stable = Codec::new(stable_config).expect("stable codec should construct");
            assert!(
                stable
                    .push(b"{")
                    .expect("first fragment should succeed")
                    .is_empty()
            );
            let started = stable
                .partial_started_at()
                .expect("guarded partial should record a start");
            assert!(
                stable
                    .push(b"\"")
                    .expect("second fragment should succeed")
                    .is_empty()
            );
            assert_eq!(stable.partial_started_at(), Some(started));

            let mut timeout_config = CodecConfig::guarded();
            timeout_config.message_timeout = Some(Duration::from_millis(1));
            let mut timeout = Codec::new(timeout_config).expect("timeout codec should construct");
            assert!(
                timeout
                    .push(b"{")
                    .expect("partial push should succeed")
                    .is_empty()
            );
            let safety_deadline = Instant::now() + Duration::from_secs(1);
            let error = loop {
                match timeout.check_partial_timeout() {
                    Ok(()) if Instant::now() < safety_deadline => std::thread::yield_now(),
                    Ok(()) => panic!("partial timeout did not fire within one second"),
                    Err(error) => break error,
                }
            };
            assert_eq!(error.code(), ProtocolErrorCode::MessageTimeout);
        },
    )?;

    case(
        test,
        diagnostics,
        "assured mode accepts only allow-listed non-reserved events",
        || {
            let mut config = CodecConfig::assured(["ping", "connect"]);
            config.allow_reserved_events = true;
            let codec = Codec::new(config).expect("assured codec should construct");
            assert_eq!(codec.profile(), Profile::Assured);
            assert!(codec.encode(&Event::new("ping", 1_i32)).is_ok());
            assert_eq!(
                protocol_failure(codec.encode(&Event::new("pong", 1_i32))).code(),
                ProtocolErrorCode::EventNotAllowed
            );
            assert_eq!(
                protocol_failure(codec.encode(&Event::new("connect", 1_i32))).code(),
                ProtocolErrorCode::ReservedEvent
            );
        },
    )
}

fn connection_cases(
    test: &mut VanillaTest,
    diagnostics: &mut Vec<String>,
) -> Result<(), TestError> {
    case(
        test,
        diagnostics,
        "connections send and flush one exact canonical frame",
        || {
            let stream = ScriptedStream::default();
            let mut connection =
                Connection::new(stream, CodecConfig::fast()).expect("connection should construct");
            assert_eq!(connection.codec().profile(), Profile::Fast);
            connection
                .send(&Event::new("app.message", "hello"))
                .expect("send should succeed");
            connection.flush().expect("flush should succeed");
            assert_eq!(
                connection.get_ref().written,
                b"{\"type\":\"app.message\",\"data\":\"hello\"}\x0c"
            );
            assert_eq!(connection.get_ref().flush_count, 1);
            let stream = connection.into_inner();
            assert_eq!(stream.flush_count, 1);
        },
    )?;

    case(
        test,
        diagnostics,
        "connections reassemble reads, queue extra messages, and mark clean EOF",
        || {
            let stream = ScriptedStream::with_reads([
                br#"{"type":"one","data":1"#.as_slice(),
                b"}\x0c{\"type\":\"two\",\"data\":2}\x0c".as_slice(),
            ]);
            let mut connection =
                Connection::new(stream, CodecConfig::fast()).expect("connection should construct");
            assert_eq!(
                connection.recv().expect("first receive should succeed"),
                Some(Message::Event(Event::new("one", 1_i32)))
            );
            assert_eq!(connection.pending_messages(), 1);
            assert!(!connection.is_eof());
            assert_eq!(
                connection.recv().expect("queued receive should succeed"),
                Some(Message::Event(Event::new("two", 2_i32)))
            );
            assert_eq!(connection.pending_messages(), 0);
            assert_eq!(connection.recv().expect("EOF receive should succeed"), None);
            assert!(connection.is_eof());
            assert!(!connection.is_failed());
        },
    )?;

    case(
        test,
        diagnostics,
        "raw connections send and receive exact bytes",
        || {
            let input = [0x00, 0xff, 0x0c];
            let stream = ScriptedStream::with_reads([input.as_slice()]);
            let mut connection =
                Connection::new(stream, CodecConfig::raw()).expect("connection should construct");
            connection
                .send_raw(&[0xaa, 0x00])
                .expect("raw send should succeed");
            assert_eq!(connection.get_ref().written, [0xaa, 0x00]);
            assert_eq!(
                connection.recv().expect("raw receive should succeed"),
                Some(Message::Raw(input.to_vec()))
            );
            assert_eq!(connection.recv().expect("EOF receive should succeed"), None);
            assert!(connection.is_eof());
        },
    )?;

    case(
        test,
        diagnostics,
        "connections defer a later protocol error until prior messages are drained",
        || {
            let stream =
                ScriptedStream::with_reads([b"{\"type\":\"ok\",\"data\":1}\x0c{\x0c".as_slice()]);
            let mut connection =
                Connection::new(stream, CodecConfig::fast()).expect("connection should construct");
            assert_eq!(
                connection
                    .recv()
                    .expect("valid leading frame should return"),
                Some(Message::Event(Event::new("ok", 1_i32)))
            );
            assert!(connection.is_failed());

            let error = ipc_failure(connection.send(&Event::new("late", 1_i32)));
            match error {
                IpcError::Io(error) => assert_eq!(error.kind(), io::ErrorKind::BrokenPipe),
                _ => panic!("failed connection write should be an I/O error"),
            }
            let error = ipc_failure(connection.recv());
            assert_eq!(
                error.protocol_error().map(ProtocolError::code),
                Some(ProtocolErrorCode::InvalidJson)
            );
            assert_eq!(
                connection.recv().expect("failed connection should drain"),
                None
            );
        },
    )?;

    case(
        test,
        diagnostics,
        "connection failures preserve incomplete-frame, backpressure, and I/O identity",
        || {
            let stream = ScriptedStream::with_reads([br#"{"type":"x""#.as_slice()]);
            let mut incomplete =
                Connection::new(stream, CodecConfig::fast()).expect("connection should construct");
            let error = ipc_failure(incomplete.recv());
            assert_eq!(
                error.protocol_error().map(ProtocolError::code),
                Some(ProtocolErrorCode::IncompleteFrame)
            );
            assert!(incomplete.is_eof());
            assert!(incomplete.is_failed());

            let mut backpressure_config = CodecConfig::guarded();
            backpressure_config.max_pending_bytes = 1;
            let mut backpressure = Connection::new(ScriptedStream::default(), backpressure_config)
                .expect("backpressure connection should construct");
            let error = ipc_failure(backpressure.send(&Event::new("x", 0_i32)));
            assert_eq!(
                error.protocol_error().map(ProtocolError::code),
                Some(ProtocolErrorCode::Backpressure)
            );
            assert!(backpressure.get_ref().written.is_empty());
            assert!(backpressure.is_failed());

            let stream = ScriptedStream::with_writes([
                WriteStep::Limit(5),
                WriteStep::Error(io::ErrorKind::BrokenPipe),
            ]);
            let mut broken =
                Connection::new(stream, CodecConfig::fast()).expect("connection should construct");
            let error = ipc_failure(broken.send(&Event::new("ping", 1_i32)));
            match error {
                IpcError::Io(error) => assert_eq!(error.kind(), io::ErrorKind::BrokenPipe),
                _ => panic!("partial write failure should remain an I/O error"),
            }
            assert_eq!(broken.get_ref().written, b"{\"typ");
            assert!(broken.is_failed());
            let error = ipc_failure(broken.send(&Event::new("again", 1_i32)));
            match error {
                IpcError::Io(error) => assert_eq!(error.kind(), io::ErrorKind::BrokenPipe),
                _ => panic!("retry after failure should be an I/O error"),
            }
            assert_eq!(broken.get_ref().written, b"{\"typ");
        },
    )
}

fn transport_cases(test: &mut VanillaTest, diagnostics: &mut Vec<String>) -> Result<(), TestError> {
    case(
        test,
        diagnostics,
        "TCP framed streams preserve ordered event ping-pong",
        || transport_case(tcp_framed_case()),
    )?;

    case(
        test,
        diagnostics,
        "TCP raw streams preserve binary bytes and frame delimiters",
        || transport_case(tcp_raw_case()),
    )?;

    case(
        test,
        diagnostics,
        "UDP framed endpoints preserve events and peer identity",
        || transport_case(udp_framed_case()),
    )?;

    case(
        test,
        diagnostics,
        "UDP raw endpoints preserve binary datagram boundaries",
        || transport_case(udp_raw_case()),
    )?;

    case(
        test,
        diagnostics,
        "UDP fragmented frame state remains isolated by peer",
        || transport_case(udp_fragment_isolation_case()),
    )?;

    case(
        test,
        diagnostics,
        "local framed streams preserve event ping-pong",
        || transport_case(local_framed_case()),
    )?;

    case(
        test,
        diagnostics,
        "local raw streams preserve binary bytes and frame delimiters",
        || transport_case(local_raw_case()),
    )?;

    case(
        test,
        diagnostics,
        "local endpoint naming and ownership clean up safely",
        || transport_case(local_endpoint_lifecycle_case()),
    )
}

fn transport_case(result: TransportResult) {
    if let Err(error) = result {
        panic!("{error}");
    }
}

fn transport_failure(message: impl Into<String>) -> TransportError {
    io::Error::other(message.into()).into()
}

fn require_transport(condition: bool, message: impl Into<String>) -> TransportResult {
    if condition {
        Ok(())
    } else {
        Err(transport_failure(message))
    }
}

fn expect_message(actual: Option<Message>, expected: Message, context: &str) -> TransportResult {
    if actual == Some(expected.clone()) {
        Ok(())
    } else {
        Err(transport_failure(format!(
            "{context}: expected {expected:?}, received {actual:?}"
        )))
    }
}

fn ordered_event(event_type: &str, sequence: u32, message: &str) -> Event {
    Event::new(
        event_type,
        JsonValue::Object(vec![
            ("sequence".to_owned(), sequence.into()),
            ("message".to_owned(), message.into()),
        ]),
    )
}

fn tcp_framed_case() -> TransportResult {
    let listener = tcp::bind((Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    let address = listener.local_addr()?;

    let server = thread::spawn(move || -> TransportResult {
        let (stream, peer) = accept_tcp_until(&listener)?;
        require_transport(peer.ip().is_loopback(), "TCP peer must use loopback")?;
        require_transport(stream.nodelay()?, "accepted TCP stream must disable Nagle")?;
        let mut connection = Connection::new(stream, CodecConfig::fast())?;

        for sequence in 0..3 {
            let request = ordered_event("native.tcp.ping", sequence, "ping");
            expect_message(
                connection.recv()?,
                Message::Event(request),
                "TCP server request",
            )?;
            connection.send(&ordered_event("native.tcp.pong", sequence, "pong"))?;
            connection.flush()?;
        }
        Ok(())
    });

    let client_result = (|| -> TransportResult {
        let stream = tcp::connect(address)?;
        configure_tcp_stream(&stream)?;
        require_transport(stream.nodelay()?, "connected TCP stream must disable Nagle")?;
        let mut connection = Connection::new(stream, CodecConfig::fast())?;

        for sequence in 0..3 {
            connection.send(&ordered_event("native.tcp.ping", sequence, "ping"))?;
            connection.flush()?;
            let response = ordered_event("native.tcp.pong", sequence, "pong");
            expect_message(
                connection.recv()?,
                Message::Event(response),
                "TCP client response",
            )?;
        }
        Ok(())
    })();

    finish_transport_pair(client_result, server)
}

fn tcp_raw_case() -> TransportResult {
    const REQUEST: &[u8] = b"\x00\x0c\xffnode-ipc";
    const RESPONSE: &[u8] = b"\xaa\x0c\x00rust";

    let listener = tcp::bind((Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    let address = listener.local_addr()?;

    let server = thread::spawn(move || -> TransportResult {
        let (stream, _) = accept_tcp_until(&listener)?;
        let mut connection = Connection::new(stream, CodecConfig::raw())?;
        let request = receive_exact_raw(&mut connection, REQUEST.len())?;
        require_transport(
            request == REQUEST,
            "TCP server received different raw bytes",
        )?;
        connection.send_raw(RESPONSE)?;
        connection.flush()?;
        Ok(())
    });

    let client_result = (|| -> TransportResult {
        let stream = tcp::connect(address)?;
        configure_tcp_stream(&stream)?;
        let mut connection = Connection::new(stream, CodecConfig::raw())?;
        connection.send_raw(REQUEST)?;
        connection.flush()?;
        let response = receive_exact_raw(&mut connection, RESPONSE.len())?;
        require_transport(
            response == RESPONSE,
            "TCP client received different raw bytes",
        )
    })();

    finish_transport_pair(client_result, server)
}

fn accept_tcp_until(listener: &TcpListener) -> TransportResult<(TcpStream, SocketAddr)> {
    let deadline = Instant::now() + TRANSPORT_TIMEOUT;
    loop {
        match tcp::accept(listener) {
            Ok((stream, peer)) => {
                stream.set_nonblocking(false)?;
                configure_tcp_stream(&stream)?;
                return Ok((stream, peer));
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(transport_failure("timed out accepting a TCP client"));
                }
                thread::sleep(ACCEPT_POLL_INTERVAL);
            }
            Err(error) => return Err(error.into()),
        }
    }
}

fn configure_tcp_stream(stream: &TcpStream) -> io::Result<()> {
    stream.set_read_timeout(Some(TRANSPORT_TIMEOUT))?;
    stream.set_write_timeout(Some(TRANSPORT_TIMEOUT))
}

fn udp_framed_case() -> TransportResult {
    let mut server = UdpEndpoint::bind((Ipv4Addr::LOCALHOST, 0), CodecConfig::fast())?;
    let mut client = UdpEndpoint::bind((Ipv4Addr::LOCALHOST, 0), CodecConfig::fast())?;
    configure_udp_endpoint(&server)?;
    configure_udp_endpoint(&client)?;
    let server_address = server.socket().local_addr()?;
    let client_address = client.socket().local_addr()?;

    let request = ordered_event("native.udp.ping", 7, "ping");
    let expected_request_bytes = client.codec().encode(&request)?.len();
    assert_eq!(
        client.send_to(&request, server_address)?,
        expected_request_bytes
    );
    let (message, peer) = server.recv_from()?;
    require_transport(peer == client_address, "UDP server reported the wrong peer")?;
    expect_message(Some(message), Message::Event(request), "UDP server request")?;

    let response = ordered_event("native.udp.pong", 7, "pong");
    let expected_response_bytes = server.codec().encode(&response)?.len();
    assert_eq!(
        server.send_to(&response, client_address)?,
        expected_response_bytes
    );
    let (message, peer) = client.recv_from()?;
    require_transport(peer == server_address, "UDP client reported the wrong peer")?;
    expect_message(
        Some(message),
        Message::Event(response),
        "UDP client response",
    )
}

fn udp_raw_case() -> TransportResult {
    const REQUEST: &[u8] = b"\x00\x0c\xffudp-request";
    const RESPONSE: &[u8] = b"\xaa\x0c\x00udp-response";

    let mut server = UdpEndpoint::bind((Ipv4Addr::LOCALHOST, 0), CodecConfig::raw())?;
    let mut client = UdpEndpoint::bind((Ipv4Addr::LOCALHOST, 0), CodecConfig::raw())?;
    configure_udp_endpoint(&server)?;
    configure_udp_endpoint(&client)?;
    let server_address = server.socket().local_addr()?;
    let client_address = client.socket().local_addr()?;

    assert_eq!(client.send_raw_to(REQUEST, server_address)?, REQUEST.len());
    let (message, peer) = server.recv_from()?;
    require_transport(
        peer == client_address,
        "raw UDP server reported the wrong peer",
    )?;
    expect_message(
        Some(message),
        Message::Raw(REQUEST.to_vec()),
        "raw UDP server datagram",
    )?;

    assert_eq!(
        server.send_raw_to(RESPONSE, client_address)?,
        RESPONSE.len()
    );
    let (message, peer) = client.recv_from()?;
    require_transport(
        peer == server_address,
        "raw UDP client reported the wrong peer",
    )?;
    expect_message(
        Some(message),
        Message::Raw(RESPONSE.to_vec()),
        "raw UDP client datagram",
    )
}

fn udp_fragment_isolation_case() -> TransportResult {
    let mut config = CodecConfig::guarded();
    config.message_timeout = Some(TRANSPORT_TIMEOUT);
    let mut server = UdpEndpoint::bind((Ipv4Addr::LOCALHOST, 0), config.clone())?;
    configure_udp_endpoint(&server)?;
    let server_address = server.socket().local_addr()?;

    let peer_a = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))?;
    let peer_b = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))?;
    peer_a.set_write_timeout(Some(TRANSPORT_TIMEOUT))?;
    peer_b.set_write_timeout(Some(TRANSPORT_TIMEOUT))?;
    let peer_a_address = peer_a.local_addr()?;
    let peer_b_address = peer_b.local_addr()?;

    let event_a = ordered_event("native.udp.peer-a", 1, "fragmented");
    let event_b = ordered_event("native.udp.peer-b", 2, "complete");
    let codec = Codec::new(config)?;
    let frame_a = codec.encode(&event_a)?;
    let frame_b = codec.encode(&event_b)?;
    let split = frame_a.len() / 2;
    require_transport(
        split > 0,
        "fragmented UDP frame must have a nonempty prefix",
    )?;

    assert_eq!(peer_a.send_to(&frame_a[..split], server_address)?, split);
    retain_udp_fragment(&mut server)?;
    require_transport(
        server.peer_count() == 1,
        "UDP endpoint must retain one partial peer",
    )?;
    require_transport(
        server.fragmented_bytes() == split,
        "UDP endpoint retained an unexpected fragment byte count",
    )?;

    assert_eq!(peer_b.send_to(&frame_b, server_address)?, frame_b.len());
    let (message, peer) = server.recv_from()?;
    require_transport(
        peer == peer_b_address,
        "complete UDP frame came from the wrong peer",
    )?;
    expect_message(
        Some(message),
        Message::Event(event_b),
        "complete UDP peer frame",
    )?;
    require_transport(
        server.peer_count() == 1 && server.fragmented_bytes() == split,
        "complete peer must not disturb another peer's fragment",
    )?;

    assert_eq!(
        peer_a.send_to(&frame_a[split..], server_address)?,
        frame_a.len() - split
    );
    let (message, peer) = server.recv_from()?;
    require_transport(
        peer == peer_a_address,
        "completed UDP fragment came from the wrong peer",
    )?;
    expect_message(
        Some(message),
        Message::Event(event_a),
        "completed UDP peer frame",
    )?;
    require_transport(
        server.peer_count() == 0 && server.fragmented_bytes() == 0,
        "completed UDP fragments must release retained peer state",
    )
}

fn configure_udp_endpoint(endpoint: &UdpEndpoint) -> io::Result<()> {
    endpoint
        .socket()
        .set_read_timeout(Some(TRANSPORT_TIMEOUT))?;
    endpoint.socket().set_write_timeout(Some(TRANSPORT_TIMEOUT))
}

fn retain_udp_fragment(endpoint: &mut UdpEndpoint) -> TransportResult {
    endpoint.socket().set_nonblocking(true)?;
    let deadline = Instant::now() + TRANSPORT_TIMEOUT;
    loop {
        match endpoint.recv_from() {
            Err(IpcError::Io(error)) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(error.into()),
            Ok((message, peer)) => {
                return Err(transport_failure(format!(
                    "partial UDP frame unexpectedly produced {message:?} from {peer}"
                )));
            }
        }
        if endpoint.peer_count() == 1 {
            break;
        }
        if Instant::now() >= deadline {
            return Err(transport_failure(
                "timed out waiting for the UDP fragment to enter peer state",
            ));
        }
        thread::sleep(ACCEPT_POLL_INTERVAL);
    }
    endpoint.socket().set_nonblocking(false)?;
    configure_udp_endpoint(endpoint)?;
    Ok(())
}

fn local_framed_server<S>(stream: S) -> TransportResult
where
    S: Read + Write,
{
    let mut connection = Connection::new(stream, CodecConfig::fast())?;
    let request = ordered_event("native.local.ping", 11, "ping");
    expect_message(
        connection.recv()?,
        Message::Event(request),
        "local server request",
    )?;
    connection.send(&ordered_event("native.local.pong", 11, "pong"))?;
    connection.flush()?;
    Ok(())
}

fn local_framed_client<S>(stream: S) -> TransportResult
where
    S: Read + Write,
{
    let mut connection = Connection::new(stream, CodecConfig::fast())?;
    connection.send(&ordered_event("native.local.ping", 11, "ping"))?;
    connection.flush()?;
    let response = ordered_event("native.local.pong", 11, "pong");
    expect_message(
        connection.recv()?,
        Message::Event(response),
        "local client response",
    )
}

fn local_raw_server<S>(stream: S) -> TransportResult
where
    S: Read + Write,
{
    const REQUEST: &[u8] = b"\x00\x0c\xfflocal-request";
    const RESPONSE: &[u8] = b"\xaa\x0c\x00local-response";
    let mut connection = Connection::new(stream, CodecConfig::raw())?;
    let request = receive_exact_raw(&mut connection, REQUEST.len())?;
    require_transport(
        request == REQUEST,
        "local server received different raw bytes",
    )?;
    connection.send_raw(RESPONSE)?;
    connection.flush()?;
    Ok(())
}

fn local_raw_client<S>(stream: S) -> TransportResult
where
    S: Read + Write,
{
    const REQUEST: &[u8] = b"\x00\x0c\xfflocal-request";
    const RESPONSE: &[u8] = b"\xaa\x0c\x00local-response";
    let mut connection = Connection::new(stream, CodecConfig::raw())?;
    connection.send_raw(REQUEST)?;
    connection.flush()?;
    let response = receive_exact_raw(&mut connection, RESPONSE.len())?;
    require_transport(
        response == RESPONSE,
        "local client received different raw bytes",
    )
}

fn receive_exact_raw<S>(connection: &mut Connection<S>, expected: usize) -> TransportResult<Vec<u8>>
where
    S: Read + Write,
{
    let mut received = Vec::with_capacity(expected);
    while received.len() < expected {
        match connection.recv()? {
            Some(Message::Raw(bytes)) => {
                if received.len() + bytes.len() > expected {
                    return Err(transport_failure(format!(
                        "raw stream returned more than the expected {expected} bytes"
                    )));
                }
                received.extend_from_slice(&bytes);
            }
            Some(Message::Event(event)) => {
                return Err(transport_failure(format!(
                    "raw stream unexpectedly returned event {event:?}"
                )));
            }
            None => {
                return Err(transport_failure(format!(
                    "raw stream ended after {} of {expected} bytes",
                    received.len()
                )));
            }
        }
    }
    Ok(received)
}

fn finish_transport_pair(
    client: TransportResult,
    server: JoinHandle<TransportResult>,
) -> TransportResult {
    let server = match server.join() {
        Ok(result) => result,
        Err(payload) => Err(transport_failure(format!(
            "transport server panicked: {}",
            panic_text(payload)
        ))),
    };

    match (client, server) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(client), Ok(())) => Err(client),
        (Ok(()), Err(server)) => Err(server),
        (Err(client), Err(server)) => Err(transport_failure(format!(
            "client failed: {client}; server failed: {server}"
        ))),
    }
}

#[cfg(unix)]
fn local_framed_case() -> TransportResult {
    let endpoint = UnixTestEndpoint::new()?;
    let listener = LocalListener::bind(&endpoint.socket)?;
    listener.set_nonblocking(true)?;
    let server = thread::spawn(move || -> TransportResult {
        let stream = accept_local_until(&listener)?;
        local_framed_server(stream)
    });

    let client_result = (|| -> TransportResult {
        let stream = local::connect(&endpoint.socket)?;
        configure_unix_stream(&stream)?;
        local_framed_client(stream)
    })();
    let result = finish_transport_pair(client_result, server);
    require_transport(
        !endpoint.socket.exists(),
        "Unix listener must remove its owned endpoint after shutdown",
    )?;
    result
}

#[cfg(unix)]
fn local_raw_case() -> TransportResult {
    let endpoint = UnixTestEndpoint::new()?;
    let listener = LocalListener::bind(&endpoint.socket)?;
    listener.set_nonblocking(true)?;
    let server = thread::spawn(move || -> TransportResult {
        let stream = accept_local_until(&listener)?;
        local_raw_server(stream)
    });

    let client_result = (|| -> TransportResult {
        let stream = local::connect(&endpoint.socket)?;
        configure_unix_stream(&stream)?;
        local_raw_client(stream)
    })();
    let result = finish_transport_pair(client_result, server);
    require_transport(
        !endpoint.socket.exists(),
        "Unix listener must remove its owned endpoint after shutdown",
    )?;
    result
}

#[cfg(unix)]
fn local_endpoint_lifecycle_case() -> TransportResult {
    let endpoint = UnixTestEndpoint::new()?;
    require_transport(
        !local::remove_stale_socket(&endpoint.socket)?,
        "missing Unix endpoint must not report stale cleanup",
    )?;

    let listener = LocalListener::bind(&endpoint.socket)?;
    require_transport(
        listener.endpoint() == endpoint.socket,
        "Unix listener must retain the exact absolute endpoint",
    )?;
    require_transport(endpoint.socket.exists(), "bound Unix endpoint must exist")?;
    drop(listener);
    require_transport(
        !endpoint.socket.exists(),
        "dropping Unix listener must remove its endpoint",
    )?;

    let listener = LocalListener::bind(&endpoint.socket)?;
    drop(listener);
    require_transport(
        !endpoint.socket.exists(),
        "a rebound Unix endpoint must also be removed",
    )
}

#[cfg(unix)]
fn accept_local_until(listener: &LocalListener) -> TransportResult<std::os::unix::net::UnixStream> {
    let deadline = Instant::now() + TRANSPORT_TIMEOUT;
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false)?;
                configure_unix_stream(&stream)?;
                return Ok(stream);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(transport_failure(
                        "timed out accepting a Unix socket client",
                    ));
                }
                thread::sleep(ACCEPT_POLL_INTERVAL);
            }
            Err(error) => return Err(error.into()),
        }
    }
}

#[cfg(unix)]
fn configure_unix_stream(stream: &std::os::unix::net::UnixStream) -> io::Result<()> {
    stream.set_read_timeout(Some(TRANSPORT_TIMEOUT))?;
    stream.set_write_timeout(Some(TRANSPORT_TIMEOUT))
}

#[cfg(unix)]
struct UnixTestEndpoint {
    directory: PathBuf,
    socket: PathBuf,
}

#[cfg(unix)]
impl UnixTestEndpoint {
    fn new() -> io::Result<Self> {
        for _ in 0..128 {
            let id = NEXT_ENDPOINT.fetch_add(1, Ordering::Relaxed);
            let directory =
                env::temp_dir().join(format!("node-ipc-vanilla-{}-{id}", process::id()));
            match fs::create_dir(&directory) {
                Ok(()) => {
                    let socket = directory.join("transport.sock");
                    return Ok(Self { directory, socket });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not reserve a unique Unix test directory",
        ))
    }
}

#[cfg(unix)]
impl Drop for UnixTestEndpoint {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_file(&self.socket) {
            if error.kind() != io::ErrorKind::NotFound {
                eprintln!(
                    "could not remove Unix test socket {}: {error}",
                    self.socket.display()
                );
            }
        }
        if let Err(error) = fs::remove_dir(&self.directory) {
            if error.kind() != io::ErrorKind::NotFound {
                eprintln!(
                    "could not remove Unix test directory {}: {error}",
                    self.directory.display()
                );
            }
        }
    }
}

#[cfg(windows)]
fn local_framed_case() -> TransportResult {
    run_windows_local_child(WINDOWS_FRAMED_CHILD)
}

#[cfg(windows)]
fn local_raw_case() -> TransportResult {
    run_windows_local_child(WINDOWS_RAW_CHILD)
}

#[cfg(windows)]
fn local_endpoint_lifecycle_case() -> TransportResult {
    let logical = unique_windows_pipe();
    let expected = format!(
        r"\\.\pipe\{}",
        logical.trim_start_matches('/').replace('/', "-")
    );
    require_transport(
        pipe_name(&logical)? == expected,
        "Windows logical endpoint mapped to an unexpected pipe name",
    )?;
    require_transport(
        pipe_name(&expected)? == expected,
        "canonical Windows pipe name must remain unchanged",
    )?;

    let listener = NamedPipeListener::bind(&logical)?;
    require_transport(
        listener.name() == expected,
        "Windows listener must report its canonical pipe name",
    )?;
    drop(listener);
    verify_windows_pipe_released(&logical)
}

#[cfg(windows)]
fn run_windows_child_mode() -> Option<TransportResult> {
    let mut arguments = env::args().skip(1);
    let mode = arguments.next()?;
    if mode != WINDOWS_FRAMED_CHILD && mode != WINDOWS_RAW_CHILD {
        return None;
    }
    let Some(endpoint) = arguments.next() else {
        return Some(Err(transport_failure(
            "Windows local child did not receive an endpoint",
        )));
    };
    if arguments.next().is_some() {
        return Some(Err(transport_failure(
            "Windows local child received unexpected arguments",
        )));
    }

    Some(match mode.as_str() {
        WINDOWS_FRAMED_CHILD => windows_local_framed_inner(&endpoint),
        WINDOWS_RAW_CHILD => windows_local_raw_inner(&endpoint),
        _ => unreachable!("the child mode was validated above"),
    })
}

#[cfg(windows)]
fn run_windows_local_child(mode: &str) -> TransportResult {
    let endpoint = unique_windows_pipe();
    let mut child = Command::new(env::current_exe()?)
        .arg(mode)
        .arg(&endpoint)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()?;
    let deadline = Instant::now() + WINDOWS_CHILD_TIMEOUT;

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(WINDOWS_CHILD_POLL_INTERVAL);
            }
            Ok(None) => {
                terminate_windows_child(&mut child)?;
                verify_windows_pipe_released(&endpoint)?;
                return Err(transport_failure(format!(
                    "Windows local child timed out after {} seconds",
                    WINDOWS_CHILD_TIMEOUT.as_secs()
                )));
            }
            Err(error) => {
                if let Err(termination_error) = terminate_windows_child(&mut child) {
                    return Err(transport_failure(format!(
                        "could not query Windows local child: {error}; {termination_error}"
                    )));
                }
                verify_windows_pipe_released(&endpoint)?;
                return Err(error.into());
            }
        }
    };

    verify_windows_pipe_released(&endpoint)?;
    require_transport(
        status.success(),
        format!("Windows local child exited with {status}"),
    )
}

#[cfg(windows)]
fn terminate_windows_child(child: &mut Child) -> TransportResult {
    let kill_error = child.kill().err();
    let deadline = Instant::now() + WINDOWS_CHILD_TERMINATION_TIMEOUT;

    loop {
        let poll_error = match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => None,
            Err(error) => Some(error),
        };

        if Instant::now() >= deadline {
            let mut detail = format!(
                "Windows local child did not exit within {} seconds after termination",
                WINDOWS_CHILD_TERMINATION_TIMEOUT.as_secs()
            );
            if let Some(error) = kill_error {
                detail.push_str(&format!("; kill failed: {error}"));
            }
            if let Some(error) = poll_error {
                detail.push_str(&format!("; status polling failed: {error}"));
            }
            return Err(transport_failure(detail));
        }
        thread::sleep(WINDOWS_CHILD_POLL_INTERVAL);
    }
}

#[cfg(windows)]
fn windows_local_framed_inner(endpoint: &str) -> TransportResult {
    let mut listener = NamedPipeListener::bind(endpoint)?;
    let server =
        thread::spawn(move || -> TransportResult { local_framed_server(listener.accept()?) });
    let client_result =
        (|| -> TransportResult { local_framed_client(NamedPipeStream::connect(endpoint)?) })();
    finish_transport_pair(client_result, server)
}

#[cfg(windows)]
fn windows_local_raw_inner(endpoint: &str) -> TransportResult {
    let mut listener = NamedPipeListener::bind(endpoint)?;
    let server = thread::spawn(move || -> TransportResult { local_raw_server(listener.accept()?) });
    let client_result =
        (|| -> TransportResult { local_raw_client(NamedPipeStream::connect(endpoint)?) })();
    finish_transport_pair(client_result, server)
}

#[cfg(windows)]
fn unique_windows_pipe() -> String {
    let id = NEXT_ENDPOINT.fetch_add(1, Ordering::Relaxed);
    format!("/node-ipc-vanilla-{}-{id}/transport", process::id())
}

#[cfg(windows)]
fn verify_windows_pipe_released(endpoint: &str) -> TransportResult {
    let listener = NamedPipeListener::bind(endpoint).map_err(|error| {
        transport_failure(format!(
            "Windows child did not release pipe `{}`: {error}",
            pipe_name(endpoint).unwrap_or_else(|_| endpoint.to_owned())
        ))
    })?;
    drop(listener);
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn local_framed_case() -> TransportResult {
    Err(transport_failure(
        "local transports require a native Unix or Windows target",
    ))
}

#[cfg(not(any(unix, windows)))]
fn local_raw_case() -> TransportResult {
    Err(transport_failure(
        "local transports require a native Unix or Windows target",
    ))
}

#[cfg(not(any(unix, windows)))]
fn local_endpoint_lifecycle_case() -> TransportResult {
    Err(transport_failure(
        "local transports require a native Unix or Windows target",
    ))
}

#[derive(Default)]
struct ScriptedStream {
    reads: VecDeque<Vec<u8>>,
    writes: VecDeque<WriteStep>,
    written: Vec<u8>,
    flush_count: usize,
}

impl ScriptedStream {
    fn with_reads<'a>(reads: impl IntoIterator<Item = &'a [u8]>) -> Self {
        Self {
            reads: reads.into_iter().map(<[u8]>::to_vec).collect(),
            ..Self::default()
        }
    }

    fn with_writes(writes: impl IntoIterator<Item = WriteStep>) -> Self {
        Self {
            writes: writes.into_iter().collect(),
            ..Self::default()
        }
    }
}

impl Read for ScriptedStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let Some(bytes) = self.reads.pop_front() else {
            return Ok(0);
        };
        let count = bytes.len().min(buffer.len());
        buffer[..count].copy_from_slice(&bytes[..count]);
        if count < bytes.len() {
            self.reads.push_front(bytes[count..].to_vec());
        }
        Ok(count)
    }
}

enum WriteStep {
    Limit(usize),
    Error(io::ErrorKind),
}

impl Write for ScriptedStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        match self.writes.pop_front() {
            Some(WriteStep::Limit(limit)) => {
                let count = limit.min(buffer.len());
                self.written.extend_from_slice(&buffer[..count]);
                Ok(count)
            }
            Some(WriteStep::Error(kind)) => Err(io::Error::new(kind, "scripted write failure")),
            None => {
                self.written.extend_from_slice(buffer);
                Ok(buffer.len())
            }
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        self.flush_count += 1;
        Ok(())
    }
}
