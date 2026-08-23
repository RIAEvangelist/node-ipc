#![allow(non_snake_case)]

#[path = "../support/mod.rs"]
mod support;

use node_ipc::{CodecConfig, Connection, Event, JsonValue};
use std::collections::BTreeSet;
use std::env;
use std::io::{self, Read, Write};

#[cfg(unix)]
use node_ipc::local::{LocalListener, connect};
#[cfg(windows)]
use node_ipc::windows_pipe::{NamedPipeListener, NamedPipeStream};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(unix)]
use std::time::Duration;

use support::{
    APP_MESSAGE, ExampleResult, KILL_CONNECTION, app_event, expect_app, expect_type, invalid_data,
    invalid_input, receive_event, receive_raw,
};

const HELP: &str = "Usage: cargo run --example unixWindowsSocket -- \
    <basic|basicSync|rawBuffer|binaryRawBuffer|Multi-Client-Broadcast> \
    <server|client|hello|goodbye> [endpoint]\n\
\n\
Roles:\n\
  basic, basicSync, rawBuffer, binaryRawBuffer  server | client\n\
  Multi-Client-Broadcast                       server | hello | goodbye\n";
const WORLD: &str = "world";
const BASIC_REQUEST: &str = "hello";
const BASIC_RESPONSE: &str = "hello world!";
const RAW_REQUEST: &[u8] = b"hello";
const RAW_RESPONSE: &[u8] = b"goodbye";
const BINARY_REQUEST: &[u8] = &[0x00, 0x02, 0x00, 0xff, 0xee, 0xcc];
const BINARY_RESPONSE: &[u8] = &[0x0d, 0xee];
const SYNC_REQUESTS: usize = 10;
#[cfg(unix)]
const IO_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Variant {
    Basic,
    BasicSync,
    RawBuffer,
    BinaryRawBuffer,
    MultiClientBroadcast,
}

impl Variant {
    fn parse(value: &str) -> ExampleResult<Self> {
        match value {
            "basic" => Ok(Self::Basic),
            "basicSync" => Ok(Self::BasicSync),
            "rawBuffer" => Ok(Self::RawBuffer),
            "binaryRawBuffer" => Ok(Self::BinaryRawBuffer),
            "Multi-Client-Broadcast" => Ok(Self::MultiClientBroadcast),
            _ => Err(invalid_input(format!("unknown variant `{value}`\n{HELP}")).into()),
        }
    }

    fn argument(self) -> &'static str {
        match self {
            Self::Basic => "basic",
            Self::BasicSync => "basicSync",
            Self::RawBuffer => "rawBuffer",
            Self::BinaryRawBuffer => "binaryRawBuffer",
            Self::MultiClientBroadcast => "Multi-Client-Broadcast",
        }
    }

    fn endpoint_segment(self) -> &'static str {
        match self {
            Self::Basic => "basic",
            Self::BasicSync => "basic-sync",
            Self::RawBuffer => "raw-buffer",
            Self::BinaryRawBuffer => "binary-raw-buffer",
            Self::MultiClientBroadcast => "multi-client-broadcast",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Role {
    Server,
    Client,
    Hello,
    Goodbye,
}

impl Role {
    fn parse(value: &str) -> ExampleResult<Self> {
        match value {
            "server" => Ok(Self::Server),
            "client" => Ok(Self::Client),
            "hello" => Ok(Self::Hello),
            "goodbye" => Ok(Self::Goodbye),
            _ => Err(invalid_input(format!("unknown role `{value}`\n{HELP}")).into()),
        }
    }

    fn argument(self) -> &'static str {
        match self {
            Self::Server => "server",
            Self::Client => "client",
            Self::Hello => "hello",
            Self::Goodbye => "goodbye",
        }
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("unixWindowsSocket example: {error}");
        std::process::exit(1);
    }
}

fn run() -> ExampleResult<()> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    if arguments.len() == 1 && matches!(arguments[0].as_str(), "--help" | "-h") {
        print!("{HELP}");
        return Ok(());
    }
    if !(2..=3).contains(&arguments.len()) {
        return Err(invalid_input(HELP).into());
    }

    let variant = Variant::parse(&arguments[0])?;
    let role = Role::parse(&arguments[1])?;
    validate_role(variant, role)?;
    let endpoint = arguments
        .get(2)
        .cloned()
        .unwrap_or_else(|| default_endpoint(variant));
    if endpoint.is_empty() {
        return Err(invalid_input("endpoint must not be empty").into());
    }

    println!(
        "unixWindowsSocket {} {} using {}",
        variant.argument(),
        role.argument(),
        endpoint
    );

    if role == Role::Server {
        run_server(variant, &endpoint)
    } else {
        run_client(variant, role, &endpoint)
    }
}

fn validate_role(variant: Variant, role: Role) -> ExampleResult<()> {
    let valid = match variant {
        Variant::MultiClientBroadcast => {
            matches!(role, Role::Server | Role::Hello | Role::Goodbye)
        }
        _ => matches!(role, Role::Server | Role::Client),
    };
    if valid {
        return Ok(());
    }
    Err(invalid_input(format!(
        "role `{}` is not valid for `{}`\n{HELP}",
        role.argument(),
        variant.argument()
    ))
    .into())
}

#[cfg(unix)]
fn run_server(variant: Variant, endpoint: &str) -> ExampleResult<()> {
    let listener = LocalListener::bind(endpoint)?;
    println!(
        "local server listening on {}",
        listener.endpoint().display()
    );

    if variant == Variant::MultiClientBroadcast {
        return serve_broadcast(|| {
            let (stream, _) = listener.accept()?;
            configure_unix_stream(&stream)?;
            Ok(stream)
        });
    }

    let (stream, _) = listener.accept()?;
    configure_unix_stream(&stream)?;
    run_server_protocol(variant, stream)
}

#[cfg(windows)]
fn run_server(variant: Variant, endpoint: &str) -> ExampleResult<()> {
    let mut listener = NamedPipeListener::bind(endpoint)?;
    println!("named-pipe server listening on {}", listener.name());

    if variant == Variant::MultiClientBroadcast {
        return serve_broadcast(|| listener.accept());
    }

    run_server_protocol(variant, listener.accept()?)
}

#[cfg(not(any(unix, windows)))]
fn run_server(_variant: Variant, _endpoint: &str) -> ExampleResult<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "unixWindowsSocket requires Unix local sockets or Windows named pipes",
    )
    .into())
}

#[cfg(unix)]
fn run_client(variant: Variant, role: Role, endpoint: &str) -> ExampleResult<()> {
    let stream = connect(endpoint)?;
    configure_unix_stream(&stream)?;
    run_client_protocol(variant, role, stream)
}

#[cfg(windows)]
fn run_client(variant: Variant, role: Role, endpoint: &str) -> ExampleResult<()> {
    run_client_protocol(variant, role, NamedPipeStream::connect(endpoint)?)
}

#[cfg(not(any(unix, windows)))]
fn run_client(_variant: Variant, _role: Role, _endpoint: &str) -> ExampleResult<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "unixWindowsSocket requires Unix local sockets or Windows named pipes",
    )
    .into())
}

#[cfg(unix)]
fn configure_unix_stream(stream: &UnixStream) -> io::Result<()> {
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    Ok(())
}

fn run_server_protocol<S>(variant: Variant, stream: S) -> ExampleResult<()>
where
    S: Read + Write,
{
    match variant {
        Variant::Basic => serve_basic(stream),
        Variant::BasicSync => serve_basic_sync(stream),
        Variant::RawBuffer => {
            serve_raw(stream, RAW_REQUEST, RAW_REQUEST, RAW_RESPONSE, "rawBuffer")
        }
        Variant::BinaryRawBuffer => serve_raw(
            stream,
            &[0xaa],
            BINARY_REQUEST,
            BINARY_RESPONSE,
            "binaryRawBuffer",
        ),
        Variant::MultiClientBroadcast => {
            Err(invalid_input("broadcast server requires two accepted streams").into())
        }
    }
}

fn run_client_protocol<S>(variant: Variant, role: Role, stream: S) -> ExampleResult<()>
where
    S: Read + Write,
{
    match variant {
        Variant::Basic => run_basic_client(stream),
        Variant::BasicSync => run_basic_sync_client(stream),
        Variant::RawBuffer => {
            run_raw_client(stream, RAW_REQUEST, RAW_REQUEST, RAW_RESPONSE, "rawBuffer")
        }
        Variant::BinaryRawBuffer => run_raw_client(
            stream,
            &[0xaa],
            BINARY_REQUEST,
            BINARY_RESPONSE,
            "binaryRawBuffer",
        ),
        Variant::MultiClientBroadcast => run_broadcast_client(stream, role),
    }
}

fn serve_basic<S>(stream: S) -> ExampleResult<()>
where
    S: Read + Write,
{
    let mut connection = Connection::new(stream, CodecConfig::fast())?;
    let request = receive_event(&mut connection)?;
    let (id, message) = expect_app(&request, APP_MESSAGE)?;
    if id != "hello" || message != BASIC_REQUEST {
        return Err(invalid_data(format!(
            "expected `hello` / `{BASIC_REQUEST}`, received `{id}` / `{message}`"
        ))
        .into());
    }
    connection.send(&app_event(WORLD, BASIC_RESPONSE))?;
    connection.flush()?;
    println!("basic server validated `{BASIC_REQUEST}` and replied `{BASIC_RESPONSE}`");
    Ok(())
}

fn run_basic_client<S>(stream: S) -> ExampleResult<()>
where
    S: Read + Write,
{
    let mut connection = Connection::new(stream, CodecConfig::fast())?;
    connection.send(&app_event("hello", BASIC_REQUEST))?;
    connection.flush()?;
    let response = receive_event(&mut connection)?;
    let (id, message) = expect_app(&response, APP_MESSAGE)?;
    if id != WORLD || message != BASIC_RESPONSE {
        return Err(invalid_data(format!(
            "expected `{WORLD}` / `{BASIC_RESPONSE}`, received `{id}` / `{message}`"
        ))
        .into());
    }
    println!("basic client received `{BASIC_RESPONSE}`");
    Ok(())
}

fn serve_basic_sync<S>(stream: S) -> ExampleResult<()>
where
    S: Read + Write,
{
    let mut connection = Connection::new(stream, CodecConfig::fast())?;
    for sequence in 0..SYNC_REQUESTS {
        let expected = format!("hello{sequence}");
        let request = receive_event(&mut connection)?;
        let (id, message) = expect_app(&request, APP_MESSAGE)?;
        if id != "hello" || message != expected {
            return Err(invalid_data(format!(
                "request {sequence} must be `hello` / `{expected}`, received `{id}` / `{message}`"
            ))
            .into());
        }
        connection.send(&app_event(WORLD, &format!("{expected} world!")))?;
        connection.flush()?;
    }
    println!("basicSync server completed {SYNC_REQUESTS} ordered request/replies");
    Ok(())
}

fn run_basic_sync_client<S>(stream: S) -> ExampleResult<()>
where
    S: Read + Write,
{
    let mut connection = Connection::new(stream, CodecConfig::fast())?;
    for sequence in 0..SYNC_REQUESTS {
        let request = format!("hello{sequence}");
        let expected = format!("{request} world!");
        connection.send(&app_event("hello", &request))?;
        connection.flush()?;
        let response = receive_event(&mut connection)?;
        let (id, message) = expect_app(&response, APP_MESSAGE)?;
        if id != WORLD || message != expected {
            return Err(invalid_data(format!(
                "response {sequence} must be `{WORLD}` / `{expected}`, received `{id}` / `{message}`"
            ))
            .into());
        }
    }
    println!("basicSync client completed {SYNC_REQUESTS} strict ordered request/replies");
    Ok(())
}

fn serve_raw<S>(
    stream: S,
    greeting: &[u8],
    request: &[u8],
    response: &[u8],
    label: &str,
) -> ExampleResult<()>
where
    S: Read + Write,
{
    let mut connection = Connection::new(stream, CodecConfig::raw())?;
    // Do not flush this greeting before reading on Windows: named-pipe flush
    // waits for peer consumption, and the peer sends its request before read.
    connection.send_raw(greeting)?;
    receive_exact_raw(&mut connection, request)?;
    connection.send_raw(response)?;
    connection.flush()?;
    println!(
        "{label} server greeted with {} bytes, validated {} bytes, and replied with {} bytes",
        greeting.len(),
        request.len(),
        response.len()
    );
    Ok(())
}

fn run_raw_client<S>(
    stream: S,
    greeting: &[u8],
    request: &[u8],
    response: &[u8],
    label: &str,
) -> ExampleResult<()>
where
    S: Read + Write,
{
    let mut connection = Connection::new(stream, CodecConfig::raw())?;
    // The server also sends immediately. Avoid a mutual blocking pipe flush;
    // successful WriteFile already placed this request in the pipe buffer.
    connection.send_raw(request)?;
    let mut expected = Vec::with_capacity(greeting.len() + response.len());
    expected.extend_from_slice(greeting);
    expected.extend_from_slice(response);
    receive_exact_raw(&mut connection, &expected)?;
    println!(
        "{label} client sent {} bytes and validated {} greeting/response bytes",
        request.len(),
        expected.len()
    );
    Ok(())
}

fn receive_exact_raw<S>(connection: &mut Connection<S>, expected: &[u8]) -> ExampleResult<()>
where
    S: Read + Write,
{
    let mut actual = Vec::with_capacity(expected.len());
    while actual.len() < expected.len() {
        let chunk = receive_raw(connection)?;
        if chunk.is_empty() || actual.len() + chunk.len() > expected.len() {
            return Err(invalid_data("raw peer returned an unexpected byte count").into());
        }
        actual.extend_from_slice(&chunk);
    }
    if actual != expected {
        return Err(invalid_data(format!(
            "raw bytes differ: expected {expected:?}, received {actual:?}"
        ))
        .into());
    }
    Ok(())
}

fn serve_broadcast<S, F>(mut accept: F) -> ExampleResult<()>
where
    S: Read + Write,
    F: FnMut() -> io::Result<S>,
{
    let mut clients = Vec::with_capacity(2);
    let mut ids = BTreeSet::new();

    for _ in 0..2 {
        let mut connection = Connection::new(accept()?, CodecConfig::fast())?;
        let request = receive_event(&mut connection)?;
        let (id, message) = expect_app(&request, APP_MESSAGE)?;
        let id = id.to_owned();
        let message = message.to_owned();
        if !matches!(id.as_str(), "hello" | "goodbye") || message != id {
            return Err(invalid_data(
                "broadcast clients must identify as `hello` or `goodbye` with the same message",
            )
            .into());
        }
        if !ids.insert(id.clone()) {
            return Err(invalid_data(format!("duplicate broadcast client `{id}`")).into());
        }

        let response = format!("{message} world!");
        connection.send(&app_event(WORLD, &response))?;
        connection.flush()?;
        println!("broadcast server replied directly to `{id}`");
        clients.push(connection);
    }

    if ids.len() != 2 || !ids.contains("hello") || !ids.contains("goodbye") {
        return Err(invalid_data("broadcast requires one hello and one goodbye client").into());
    }

    let kill = kill_event();
    for connection in &mut clients {
        connection.send(&kill)?;
        connection.flush()?;
    }
    println!("broadcast server sent `kill.connection` to both validated clients");
    Ok(())
}

fn run_broadcast_client<S>(stream: S, role: Role) -> ExampleResult<()>
where
    S: Read + Write,
{
    let id = role.argument();
    if !matches!(role, Role::Hello | Role::Goodbye) {
        return Err(invalid_input("broadcast client role must be `hello` or `goodbye`").into());
    }

    let mut connection = Connection::new(stream, CodecConfig::fast())?;
    connection.send(&app_event(id, id))?;
    connection.flush()?;

    let direct = receive_event(&mut connection)?;
    let (sender, message) = expect_app(&direct, APP_MESSAGE)?;
    let expected = format!("{id} world!");
    if sender != WORLD || message != expected {
        return Err(invalid_data(format!(
            "expected direct reply from `world` containing `{expected}`"
        ))
        .into());
    }

    let kill = receive_event(&mut connection)?;
    expect_kill(&kill)?;
    println!("broadcast `{id}` client validated its direct reply and `kill.connection`");
    Ok(())
}

fn kill_event() -> Event {
    Event::new(
        KILL_CONNECTION,
        JsonValue::Object(vec![("id".to_owned(), JsonValue::from(WORLD))]),
    )
}

fn expect_kill(event: &Event) -> ExampleResult<()> {
    expect_type(event, KILL_CONNECTION)?;
    let sender = event
        .data
        .get("id")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| invalid_data("kill.connection has no string `id`"))?;
    if sender != WORLD {
        return Err(invalid_data(format!(
            "kill.connection must come from `world`, received `{sender}`"
        ))
        .into());
    }
    Ok(())
}

fn default_endpoint(variant: Variant) -> String {
    default_endpoint_for(&user_segment(), variant.endpoint_segment())
}

fn user_segment() -> String {
    let value = env::var("USERNAME")
        .or_else(|_| env::var("USER"))
        .unwrap_or_else(|_| "user".to_owned());
    let mut segment: String = value
        .chars()
        .take(32)
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect();
    if segment.is_empty() {
        segment.push_str("user");
    }
    segment
}

#[cfg(unix)]
fn default_endpoint_for(user: &str, variant: &str) -> String {
    env::temp_dir()
        .join(format!(
            "node-ipc-rust-{user}-unixWindowsSocket-{variant}.sock"
        ))
        .to_string_lossy()
        .into_owned()
}

#[cfg(windows)]
fn default_endpoint_for(user: &str, variant: &str) -> String {
    format!("/node-ipc-rust-{user}/unixWindowsSocket-{variant}")
}

#[cfg(not(any(unix, windows)))]
fn default_endpoint_for(_user: &str, variant: &str) -> String {
    format!("node-ipc-rust-unixWindowsSocket-{variant}")
}
