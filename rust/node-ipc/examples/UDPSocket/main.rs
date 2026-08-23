#[path = "../support/mod.rs"]
mod support;

use node_ipc::{CodecConfig, Event, JsonValue, Message, UdpEndpoint};
use std::env;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::Duration;
use support::{ExampleResult, expect_app, invalid_data, invalid_input, parse_port};

const MESSAGE: &str = "message";
const DEFAULT_HOST: Ipv4Addr = Ipv4Addr::LOCALHOST;
const DEFAULT_SERVER_PORT: u16 = 8000;
const DEFAULT_HELLO_PORT: u16 = 8001;
const DEFAULT_GOODBYE_PORT: u16 = 8002;
const IO_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BROADCAST_DATAGRAMS: usize = 16;
const BROADCAST_MESSAGE: &str = "Everybody Loves The World! Got messages from hello and goodbye!";

const USAGE: &str = "Usage:
  cargo run --example UDPSocket -- <basic|rawBuffer|Multi-Client-Broadcast> \
<server|client|hello|goodbye> [host] [server-port] [local-port]

Roles:
  basic / rawBuffer             server | client
  Multi-Client-Broadcast        server | hello | goodbye

Defaults:
  host                          127.0.0.1 (IPv4 loopback only)
  server-port                   8000
  client / hello local-port     8001
  goodbye local-port            8002
";

#[derive(Clone, Copy)]
enum Demo {
    Basic,
    RawBuffer,
    MultiClientBroadcast,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Role {
    Server,
    Client,
    Hello,
    Goodbye,
}

struct Options {
    demo: Demo,
    role: Role,
    host: Ipv4Addr,
    server_port: u16,
    local_port: u16,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("UDP example: {error}\n\n{USAGE}");
        std::process::exit(1);
    }
}

fn run() -> ExampleResult<()> {
    let Some(options) = parse_options()? else {
        print!("{USAGE}");
        return Ok(());
    };

    match (options.demo, options.role) {
        (Demo::Basic, Role::Server) => run_basic_server(&options),
        (Demo::Basic, Role::Client) => run_basic_client(&options),
        (Demo::RawBuffer, Role::Server) => run_raw_server(&options),
        (Demo::RawBuffer, Role::Client) => run_raw_client(&options),
        (Demo::MultiClientBroadcast, Role::Server) => run_broadcast_server(&options),
        (Demo::MultiClientBroadcast, Role::Hello | Role::Goodbye) => run_broadcast_client(&options),
        _ => Err(invalid_input("the selected role does not belong to that UDP example").into()),
    }
}

fn parse_options() -> ExampleResult<Option<Options>> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    if arguments
        .first()
        .is_some_and(|argument| argument.as_str() == "--help" || argument.as_str() == "-h")
    {
        return Ok(None);
    }
    if !(2..=5).contains(&arguments.len()) {
        return Err(invalid_input("expected two through five arguments").into());
    }

    let demo = match arguments[0].as_str() {
        "basic" => Demo::Basic,
        "rawBuffer" => Demo::RawBuffer,
        "Multi-Client-Broadcast" => Demo::MultiClientBroadcast,
        _ => {
            return Err(invalid_input(
                "example must be `basic`, `rawBuffer`, or `Multi-Client-Broadcast`",
            )
            .into());
        }
    };
    let role = match arguments[1].as_str() {
        "server" => Role::Server,
        "client" => Role::Client,
        "hello" => Role::Hello,
        "goodbye" => Role::Goodbye,
        _ => {
            return Err(
                invalid_input("role must be `server`, `client`, `hello`, or `goodbye`").into(),
            );
        }
    };
    validate_role(demo, role)?;

    let host = arguments
        .get(2)
        .map_or(Ok(DEFAULT_HOST), |value| parse_loopback(value))?;
    let server_port = arguments
        .get(3)
        .map_or(Ok(DEFAULT_SERVER_PORT), |value| parse_port(value))?;
    let default_local_port = match role {
        Role::Goodbye => DEFAULT_GOODBYE_PORT,
        _ => DEFAULT_HELLO_PORT,
    };
    let local_port = arguments
        .get(4)
        .map_or(Ok(default_local_port), |value| parse_port(value))?;

    if role != Role::Server && local_port == server_port {
        return Err(invalid_input("client local-port must differ from server-port").into());
    }

    Ok(Some(Options {
        demo,
        role,
        host,
        server_port,
        local_port,
    }))
}

fn validate_role(demo: Demo, role: Role) -> ExampleResult<()> {
    let valid = match demo {
        Demo::Basic | Demo::RawBuffer => matches!(role, Role::Server | Role::Client),
        Demo::MultiClientBroadcast => matches!(role, Role::Server | Role::Hello | Role::Goodbye),
    };
    if !valid {
        return Err(invalid_input("the selected role does not belong to that UDP example").into());
    }
    Ok(())
}

fn parse_loopback(value: &str) -> ExampleResult<Ipv4Addr> {
    let address = if value.eq_ignore_ascii_case("localhost") {
        Ipv4Addr::LOCALHOST
    } else {
        value
            .parse::<Ipv4Addr>()
            .map_err(|_| invalid_input("host must be an IPv4 loopback address"))?
    };
    if !address.is_loopback() {
        return Err(invalid_input("host must be an IPv4 loopback address").into());
    }
    Ok(address)
}

fn run_basic_server(options: &Options) -> ExampleResult<()> {
    let server = server_address(options);
    let mut endpoint = bind_endpoint(server, CodecConfig::fast())?;
    println!("basic server listening on {server}");

    let (event, peer) = receive_event(&mut endpoint)?;
    expect_message(&event, "hello", "Hello")?;
    endpoint.send_to(&message_event("world", "Hello world!"), peer)?;
    println!("received framed hello from {peer}; sent framed reply");
    Ok(())
}

fn run_basic_client(options: &Options) -> ExampleResult<()> {
    let local = local_address(options);
    let server = server_address(options);
    let mut endpoint = bind_endpoint(local, CodecConfig::fast())?;

    endpoint.send_to(&message_event("hello", "Hello"), server)?;
    let (event, peer) = receive_event(&mut endpoint)?;
    expect_peer(peer, server)?;
    expect_message(&event, "world", "Hello world!")?;
    println!("sent framed hello from {local}; validated reply from {server}");
    Ok(())
}

fn run_raw_server(options: &Options) -> ExampleResult<()> {
    let server = server_address(options);
    let mut endpoint = bind_endpoint(server, CodecConfig::raw())?;
    println!("rawBuffer server listening on {server}");

    let (bytes, peer) = receive_raw(&mut endpoint)?;
    expect_bytes(&bytes, b"hello")?;
    endpoint.send_raw_to(b"goodbye", peer)?;
    println!("received raw `hello` from {peer}; sent raw `goodbye`");
    Ok(())
}

fn run_raw_client(options: &Options) -> ExampleResult<()> {
    let local = local_address(options);
    let server = server_address(options);
    let mut endpoint = bind_endpoint(local, CodecConfig::raw())?;

    endpoint.send_raw_to(b"hello", server)?;
    let (bytes, peer) = receive_raw(&mut endpoint)?;
    expect_peer(peer, server)?;
    expect_bytes(&bytes, b"goodbye")?;
    println!("sent raw `hello` from {local}; validated raw reply from {server}");
    Ok(())
}

fn run_broadcast_server(options: &Options) -> ExampleResult<()> {
    let server = server_address(options);
    let mut endpoint = bind_endpoint(server, CodecConfig::fast())?;
    let mut hello_peer = None;
    let mut goodbye_peer = None;
    println!("broadcast server listening on {server}");

    for _ in 0..MAX_BROADCAST_DATAGRAMS {
        let (event, peer) = receive_event(&mut endpoint)?;
        let (id, message) = expect_app(&event, MESSAGE)?;
        let expected_message = match id {
            "hello" => "Hello",
            "goodbye" => "Goodbye",
            _ => {
                return Err(
                    invalid_data("broadcast client id must be `hello` or `goodbye`").into(),
                );
            }
        };
        if message != expected_message {
            return Err(invalid_data(format!(
                "expected `{expected_message}` from `{id}`, received `{message}`"
            ))
            .into());
        }
        remember_peer(id, peer, &mut hello_peer, &mut goodbye_peer)?;

        let reply = format!("{message} world!");
        endpoint.send_to(&message_event("world", &reply), peer)?;
        println!("learned {id} at {peer}; sent direct reply");

        if hello_peer.is_some() && goodbye_peer.is_some() {
            break;
        }
    }

    let hello_peer = hello_peer.ok_or_else(|| invalid_data("did not receive the hello client"))?;
    let goodbye_peer =
        goodbye_peer.ok_or_else(|| invalid_data("did not receive the goodbye client"))?;
    let broadcast = message_event("world", BROADCAST_MESSAGE);
    endpoint.send_to(&broadcast, hello_peer)?;
    endpoint.send_to(&broadcast, goodbye_peer)?;
    println!("broadcast explicitly fanned out to {hello_peer} and {goodbye_peer}");
    Ok(())
}

fn run_broadcast_client(options: &Options) -> ExampleResult<()> {
    let (id, request, expected_reply) = match options.role {
        Role::Hello => ("hello", "Hello", "Hello world!"),
        Role::Goodbye => ("goodbye", "Goodbye", "Goodbye world!"),
        _ => return Err(invalid_input("broadcast client must be `hello` or `goodbye`").into()),
    };
    let local = local_address(options);
    let server = server_address(options);
    let mut endpoint = bind_endpoint(local, CodecConfig::fast())?;
    endpoint.send_to(&message_event(id, request), server)?;

    let mut direct_reply = false;
    let mut broadcast = false;
    for _ in 0..MAX_BROADCAST_DATAGRAMS {
        let (event, peer) = receive_event(&mut endpoint)?;
        expect_peer(peer, server)?;
        let (reply_id, message) = expect_app(&event, MESSAGE)?;
        if reply_id != "world" {
            return Err(
                invalid_data(format!("expected reply id `world`, received `{reply_id}`")).into(),
            );
        }
        match message {
            value if value == expected_reply => direct_reply = true,
            BROADCAST_MESSAGE => broadcast = true,
            _ => {
                return Err(invalid_data(format!("unexpected broadcast reply `{message}`")).into());
            }
        }
        if direct_reply && broadcast {
            println!("{id} at {local} validated its direct reply and the fan-out broadcast");
            return Ok(());
        }
    }

    Err(invalid_data("did not receive both the direct reply and broadcast").into())
}

fn bind_endpoint(address: SocketAddr, config: CodecConfig) -> ExampleResult<UdpEndpoint> {
    let endpoint = UdpEndpoint::bind(address, config)?;
    endpoint.socket().set_read_timeout(Some(IO_TIMEOUT))?;
    endpoint.socket().set_write_timeout(Some(IO_TIMEOUT))?;
    Ok(endpoint)
}

fn receive_event(endpoint: &mut UdpEndpoint) -> ExampleResult<(Event, SocketAddr)> {
    let (message, peer) = endpoint.recv_from()?;
    match message {
        Message::Event(event) => Ok((event, peer)),
        Message::Raw(_) => Err(invalid_data("expected a framed UDP event").into()),
    }
}

fn receive_raw(endpoint: &mut UdpEndpoint) -> ExampleResult<(Vec<u8>, SocketAddr)> {
    let (message, peer) = endpoint.recv_from()?;
    match message {
        Message::Raw(bytes) => Ok((bytes, peer)),
        Message::Event(_) => Err(invalid_data("expected a raw UDP datagram").into()),
    }
}

fn message_event(id: &str, message: &str) -> Event {
    Event::new(
        MESSAGE,
        JsonValue::Object(vec![
            ("id".to_owned(), JsonValue::from(id)),
            ("message".to_owned(), JsonValue::from(message)),
        ]),
    )
}

fn expect_message(event: &Event, expected_id: &str, expected_message: &str) -> ExampleResult<()> {
    let (id, message) = expect_app(event, MESSAGE)?;
    if id != expected_id || message != expected_message {
        return Err(invalid_data(format!(
            "expected `{expected_id}` / `{expected_message}`, received `{id}` / `{message}`"
        ))
        .into());
    }
    Ok(())
}

fn expect_peer(actual: SocketAddr, expected: SocketAddr) -> ExampleResult<()> {
    if actual != expected {
        return Err(invalid_data(format!(
            "expected a datagram from {expected}, received one from {actual}"
        ))
        .into());
    }
    Ok(())
}

fn expect_bytes(actual: &[u8], expected: &[u8]) -> ExampleResult<()> {
    if actual != expected {
        return Err(invalid_data(format!(
            "expected raw bytes {expected:?}, received {actual:?}"
        ))
        .into());
    }
    Ok(())
}

fn remember_peer(
    id: &str,
    peer: SocketAddr,
    hello_peer: &mut Option<SocketAddr>,
    goodbye_peer: &mut Option<SocketAddr>,
) -> ExampleResult<()> {
    let (slot, other) = match id {
        "hello" => (hello_peer, goodbye_peer),
        "goodbye" => (goodbye_peer, hello_peer),
        _ => return Err(invalid_data("broadcast client id must be `hello` or `goodbye`").into()),
    };
    if other.as_ref() == Some(&peer) {
        return Err(invalid_data("hello and goodbye must use distinct UDP endpoints").into());
    }
    if slot.is_some_and(|known| known != peer) {
        return Err(invalid_data(format!(
            "client `{id}` changed UDP endpoints during the demo"
        ))
        .into());
    }
    *slot = Some(peer);
    Ok(())
}

fn server_address(options: &Options) -> SocketAddr {
    SocketAddr::V4(SocketAddrV4::new(options.host, options.server_port))
}

fn local_address(options: &Options) -> SocketAddr {
    SocketAddr::V4(SocketAddrV4::new(options.host, options.local_port))
}
