#[path = "../support/mod.rs"]
mod support;

use node_ipc::{CodecConfig, Connection, Event, JsonValue, tcp};
use std::collections::HashSet;
use std::env;
use std::io;
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::thread;
use std::time::{Duration, Instant};
use support::{
    APP_MESSAGE, ExampleResult, KILL_CONNECTION, app_event, expect_app, expect_text, expect_type,
    invalid_data, invalid_input, parse_port, receive_event, receive_raw, text_event,
};

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 8000;
const OPERATION_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_ATTEMPT_TIMEOUT: Duration = Duration::from_millis(500);
const RETRY_DELAY: Duration = Duration::from_millis(50);
const BASIC_EVENT: &str = "message";

const USAGE: &str = "Usage: cargo run --example TCPSocket -- \
<basic|basicSync|rawBuffer|Multi-Client-Broadcast> \
<server|client|hello|goodbye> [host] [port]";

#[derive(Clone, Copy)]
enum Demo {
    Basic,
    BasicSync,
    RawBuffer,
    Broadcast,
}

#[derive(Clone, Copy)]
enum Role {
    Server,
    Client,
    Hello,
    Goodbye,
}

struct Options {
    demo: Demo,
    role: Role,
    host: String,
    port: u16,
}

struct BroadcastPeer {
    id: String,
    connection: Connection<TcpStream>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Rust TCP example: {error}");
        std::process::exit(1);
    }
}

fn run() -> ExampleResult<()> {
    let options = parse_arguments()?;
    match (options.demo, options.role) {
        (Demo::Basic, Role::Server) => run_basic_server(&options.host, options.port),
        (Demo::Basic, Role::Client) => run_basic_client(&options.host, options.port),
        (Demo::BasicSync, Role::Server) => run_basic_sync_server(&options.host, options.port),
        (Demo::BasicSync, Role::Client) => run_basic_sync_client(&options.host, options.port),
        (Demo::RawBuffer, Role::Server) => run_raw_server(&options.host, options.port),
        (Demo::RawBuffer, Role::Client) => run_raw_client(&options.host, options.port),
        (Demo::Broadcast, Role::Server) => run_broadcast_server(&options.host, options.port),
        (Demo::Broadcast, Role::Hello) => {
            run_broadcast_client("hello", &options.host, options.port)
        }
        (Demo::Broadcast, Role::Goodbye) => {
            run_broadcast_client("goodbye", &options.host, options.port)
        }
        (Demo::Broadcast, Role::Client) => Err(invalid_input(
            "Multi-Client-Broadcast uses the `hello` and `goodbye` client roles",
        )
        .into()),
        (_, Role::Hello | Role::Goodbye) => Err(invalid_input(
            "the `hello` and `goodbye` roles require Multi-Client-Broadcast",
        )
        .into()),
    }
}

fn parse_arguments() -> ExampleResult<Options> {
    let mut arguments = env::args().skip(1);
    let demo = match arguments.next().as_deref() {
        Some("basic") => Demo::Basic,
        Some("basicSync") => Demo::BasicSync,
        Some("rawBuffer") => Demo::RawBuffer,
        Some("Multi-Client-Broadcast") => Demo::Broadcast,
        Some("--help" | "-h") => {
            println!("{USAGE}");
            std::process::exit(0);
        }
        Some(value) => {
            return Err(invalid_input(format!("unknown TCP example `{value}`; {USAGE}")).into());
        }
        None => return Err(invalid_input(USAGE).into()),
    };
    let role = match arguments.next().as_deref() {
        Some("server") => Role::Server,
        Some("client") => Role::Client,
        Some("hello") => Role::Hello,
        Some("goodbye") => Role::Goodbye,
        Some(value) => return Err(invalid_input(format!("unknown role `{value}`; {USAGE}")).into()),
        None => return Err(invalid_input(USAGE).into()),
    };
    let host = arguments.next().unwrap_or_else(|| DEFAULT_HOST.to_owned());
    if host.is_empty() {
        return Err(invalid_input("host must not be empty").into());
    }
    let port = arguments
        .next()
        .map(|value| parse_port(&value))
        .transpose()?
        .unwrap_or(DEFAULT_PORT);
    if arguments.next().is_some() {
        return Err(invalid_input(USAGE).into());
    }
    Ok(Options {
        demo,
        role,
        host,
        port,
    })
}

fn run_basic_server(host: &str, port: u16) -> ExampleResult<()> {
    let listener = bind(host, port)?;
    let mut connection = accept_connection(&listener, CodecConfig::fast())?;
    let request = receive_event(&mut connection)?;
    let message = expect_text(&request, BASIC_EVENT)?;
    if message != "hello" {
        return Err(invalid_data(format!("expected `hello`, received `{message}`")).into());
    }
    println!("received {BASIC_EVENT}: {message}");

    let reply = format!("{message} world!");
    connection.send(&text_event(BASIC_EVENT, &reply))?;
    connection.flush()?;
    println!("sent {BASIC_EVENT}: {reply}");
    Ok(())
}

fn run_basic_client(host: &str, port: u16) -> ExampleResult<()> {
    let mut connection = connect(host, port, CodecConfig::fast())?;
    connection.send(&text_event(BASIC_EVENT, "hello"))?;
    connection.flush()?;
    println!("sent {BASIC_EVENT}: hello");

    let reply = receive_event(&mut connection)?;
    let message = expect_text(&reply, BASIC_EVENT)?;
    if message != "hello world!" {
        return Err(invalid_data(format!("expected `hello world!`, received `{message}`")).into());
    }
    println!("received {BASIC_EVENT}: {message}");
    Ok(())
}

fn run_basic_sync_server(host: &str, port: u16) -> ExampleResult<()> {
    let listener = bind(host, port)?;
    let mut connection = accept_connection(&listener, CodecConfig::fast())?;

    for sequence in 0..10 {
        let request = receive_event(&mut connection)?;
        let message = expect_text(&request, BASIC_EVENT)?;
        let expected = format!("hello{sequence}");
        if message != expected {
            return Err(invalid_data(format!(
                "expected ordered request `{expected}`, received `{message}`"
            ))
            .into());
        }
        println!("received ordered request {sequence}: {message}");

        let reply = format!("{message} world!");
        connection.send(&text_event(BASIC_EVENT, &reply))?;
        connection.flush()?;
        println!("sent ordered reply {sequence}: {reply}");
    }
    Ok(())
}

fn run_basic_sync_client(host: &str, port: u16) -> ExampleResult<()> {
    let mut connection = connect(host, port, CodecConfig::fast())?;

    for sequence in 0..10 {
        let request = format!("hello{sequence}");
        connection.send(&text_event(BASIC_EVENT, &request))?;
        connection.flush()?;
        println!("sent ordered request {sequence}: {request}");

        let reply = receive_event(&mut connection)?;
        let message = expect_text(&reply, BASIC_EVENT)?;
        let expected = format!("{request} world!");
        if message != expected {
            return Err(invalid_data(format!(
                "expected ordered reply `{expected}`, received `{message}`"
            ))
            .into());
        }
        println!("received ordered reply {sequence}: {message}");
    }
    Ok(())
}

fn run_raw_server(host: &str, port: u16) -> ExampleResult<()> {
    let listener = bind(host, port)?;
    let mut connection = accept_connection(&listener, CodecConfig::raw())?;

    send_raw(&mut connection, b"hello")?;
    receive_exact_raw(&mut connection, b"hello")?;
    send_raw(&mut connection, b"goodbye")?;
    Ok(())
}

fn run_raw_client(host: &str, port: u16) -> ExampleResult<()> {
    let mut connection = connect(host, port, CodecConfig::raw())?;

    send_raw(&mut connection, b"hello")?;
    let received = receive_exact_raw(&mut connection, b"hellogoodbye")?;
    println!("server greeting: {}", visible_bytes(&received[..5]));
    println!("server response: {}", visible_bytes(&received[5..]));
    Ok(())
}

fn run_broadcast_server(host: &str, port: u16) -> ExampleResult<()> {
    let listener = bind(host, port)?;
    let mut peers = Vec::with_capacity(2);
    let mut ids = HashSet::with_capacity(2);

    for _ in 0..2 {
        let mut connection = accept_connection(&listener, CodecConfig::fast())?;
        let request = receive_event(&mut connection)?;
        let (id, message) = expect_app(&request, APP_MESSAGE)?;
        let id = id.to_owned();
        let message = message.to_owned();
        if !matches!(id.as_str(), "hello" | "goodbye") {
            return Err(invalid_data(format!("unexpected broadcast client id `{id}`")).into());
        }
        if message != id {
            return Err(
                invalid_data(format!("client `{id}` sent unexpected message `{message}`")).into(),
            );
        }
        if !ids.insert(id.clone()) {
            return Err(invalid_data(format!("client `{id}` connected more than once")).into());
        }
        println!("received {APP_MESSAGE} from {id}: {message}");

        let reply = format!("{message} world!");
        connection.send(&app_event("world", &reply))?;
        connection.flush()?;
        println!("sent direct reply to {id}: {reply}");
        peers.push(BroadcastPeer { id, connection });
    }

    if !ids.contains("hello") || !ids.contains("goodbye") {
        return Err(invalid_data("broadcast requires one hello and one goodbye client").into());
    }

    let kill = Event::new(
        KILL_CONNECTION,
        JsonValue::Object(vec![("id".to_owned(), JsonValue::from("world"))]),
    );
    for peer in &mut peers {
        peer.connection.send(&kill)?;
        peer.connection.flush()?;
        println!("broadcast {KILL_CONNECTION} to {}", peer.id);
    }
    Ok(())
}

fn run_broadcast_client(id: &str, host: &str, port: u16) -> ExampleResult<()> {
    let mut connection = connect(host, port, CodecConfig::fast())?;
    connection.send(&app_event(id, id))?;
    connection.flush()?;
    println!("sent {APP_MESSAGE} from {id}: {id}");

    let reply = receive_event(&mut connection)?;
    let (reply_id, message) = expect_app(&reply, APP_MESSAGE)?;
    let expected = format!("{id} world!");
    if reply_id != "world" || message != expected {
        return Err(invalid_data(format!(
            "expected direct reply from world with `{expected}`"
        ))
        .into());
    }
    println!("received direct reply from {reply_id}: {message}");

    let kill = receive_event(&mut connection)?;
    expect_type(&kill, KILL_CONNECTION)?;
    if kill.data.get("id").and_then(JsonValue::as_str) != Some("world") {
        return Err(invalid_data("kill.connection did not identify world").into());
    }
    println!("received {KILL_CONNECTION} from world; closing");
    Ok(())
}

fn bind(host: &str, port: u16) -> ExampleResult<TcpListener> {
    let listener = tcp::bind((host, port))?;
    listener.set_nonblocking(true)?;
    println!("listening on {}", listener.local_addr()?);
    Ok(listener)
}

fn accept_connection(
    listener: &TcpListener,
    config: CodecConfig,
) -> ExampleResult<Connection<TcpStream>> {
    let deadline = Instant::now() + OPERATION_TIMEOUT;
    loop {
        match tcp::accept(listener) {
            Ok((stream, peer)) => {
                stream.set_nonblocking(false)?;
                configure_stream(&stream)?;
                println!("accepted {peer}");
                return Ok(Connection::new(stream, config)?);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "timed out waiting for a TCP client",
                    )
                    .into());
                }
                thread::sleep(RETRY_DELAY);
            }
            Err(error) => return Err(error.into()),
        }
    }
}

fn connect(host: &str, port: u16, config: CodecConfig) -> ExampleResult<Connection<TcpStream>> {
    let addresses: Vec<SocketAddr> = (host, port).to_socket_addrs()?.collect();
    if addresses.is_empty() {
        return Err(invalid_input(format!("host `{host}` resolved to no addresses")).into());
    }

    let deadline = Instant::now() + OPERATION_TIMEOUT;
    let mut last_error = None;
    loop {
        for address in &addresses {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match TcpStream::connect_timeout(address, remaining.min(CONNECT_ATTEMPT_TIMEOUT)) {
                Ok(stream) => {
                    tcp::prepare(&stream)?;
                    configure_stream(&stream)?;
                    println!("connected to {address}");
                    return Ok(Connection::new(stream, config)?);
                }
                Err(error) => last_error = Some(error),
            }
        }

        if Instant::now() >= deadline {
            let detail = last_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "connection failed".to_owned());
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("timed out connecting to {host}:{port}: {detail}"),
            )
            .into());
        }
        thread::sleep(RETRY_DELAY);
    }
}

fn configure_stream(stream: &TcpStream) -> io::Result<()> {
    stream.set_read_timeout(Some(OPERATION_TIMEOUT))?;
    stream.set_write_timeout(Some(OPERATION_TIMEOUT))
}

fn send_raw(connection: &mut Connection<TcpStream>, bytes: &[u8]) -> ExampleResult<()> {
    println!("SEND RAW: {}", visible_bytes(bytes));
    connection.send_raw(bytes)?;
    connection.flush()?;
    Ok(())
}

fn receive_exact_raw(
    connection: &mut Connection<TcpStream>,
    expected: &[u8],
) -> ExampleResult<Vec<u8>> {
    let mut received = Vec::with_capacity(expected.len());
    while received.len() < expected.len() {
        let chunk = receive_raw(connection)?;
        println!("RECV RAW: {}", visible_bytes(&chunk));
        received.extend_from_slice(&chunk);
        if received.len() > expected.len() {
            return Err(invalid_data(format!(
                "raw peer sent {} bytes; expected {}",
                received.len(),
                expected.len()
            ))
            .into());
        }
    }
    if received != expected {
        return Err(invalid_data(format!(
            "expected raw bytes `{}`, received `{}`",
            visible_bytes(expected),
            visible_bytes(&received)
        ))
        .into());
    }
    Ok(received)
}

fn visible_bytes(bytes: &[u8]) -> String {
    let mut output = String::new();
    for &byte in bytes {
        match byte {
            b'\r' => output.push_str("\\r"),
            b'\n' => output.push_str("\\n"),
            b'\t' => output.push_str("\\t"),
            0x20..=0x7e => output.push(char::from(byte)),
            _ => output.push_str(&format!("\\x{byte:02x}")),
        }
    }
    output
}
