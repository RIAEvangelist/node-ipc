#[path = "../support/mod.rs"]
mod support;

use node_ipc::{CodecConfig, Connection, Event, JsonValue};
use std::error::Error;
use std::fmt::Write as _;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

const PING_EVENT: &str = "node-ipc.demo.ping";
const PONG_EVENT: &str = "node-ipc.demo.pong";
const DELIMITER: u8 = 0x0c;

fn main() {
    if let Err(error) = run() {
        eprintln!("Rust/Node ping-pong example: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let mut arguments = std::env::args().skip(1);
    let role = arguments
        .next()
        .ok_or_else(|| support::invalid_input(usage()))?;
    let host = arguments.next().unwrap_or_else(|| "127.0.0.1".to_owned());
    let port = arguments
        .next()
        .map(|value| support::parse_port(&value))
        .transpose()?
        .unwrap_or(9763);
    if arguments.next().is_some() {
        return Err(support::invalid_input(usage()).into());
    }

    match role.as_str() {
        "server" => run_server(&host, port),
        "client" => run_client(&host, port),
        _ => Err(support::invalid_input(usage()).into()),
    }
}

fn run_server(host: &str, port: u16) -> Result<(), Box<dyn Error>> {
    let listener = node_ipc::tcp::bind((host, port))?;
    println!("Rust server listening on {}", listener.local_addr()?);
    let (stream, peer) = node_ipc::tcp::accept(&listener)?;
    prepare_stream(&stream)?;
    println!("Node client connected from {peer}");

    let mut connection = Connection::new(WireTap::new(stream), CodecConfig::fast())?;
    let ping = support::receive_event(&mut connection)?;
    expect_message(&ping, PING_EVENT, "ping")?;
    println!("DECODED:  ping");

    connection.send(&message_event(PONG_EVENT, "pong"))?;
    connection.flush()?;
    println!("SENT:     pong");
    Ok(())
}

fn run_client(host: &str, port: u16) -> Result<(), Box<dyn Error>> {
    let stream = node_ipc::tcp::connect((host, port))?;
    prepare_stream(&stream)?;
    println!("Rust client connected to {host}:{port}");

    let mut connection = Connection::new(WireTap::new(stream), CodecConfig::fast())?;
    connection.send(&message_event(PING_EVENT, "ping"))?;
    connection.flush()?;
    println!("SENT:     ping");

    let pong = support::receive_event(&mut connection)?;
    expect_message(&pong, PONG_EVENT, "pong")?;
    println!("DECODED:  pong");
    Ok(())
}

fn prepare_stream(stream: &TcpStream) -> io::Result<()> {
    let timeout = Some(Duration::from_secs(30));
    stream.set_read_timeout(timeout)?;
    stream.set_write_timeout(timeout)
}

fn message_event(event_type: &str, message: &str) -> Event {
    Event::new(
        event_type,
        JsonValue::Object(vec![("message".to_owned(), JsonValue::from(message))]),
    )
}

fn expect_message(event: &Event, event_type: &str, message: &str) -> support::ExampleResult<()> {
    support::expect_type(event, event_type)?;
    if event.data.get("message").and_then(JsonValue::as_str) != Some(message) {
        return Err(support::invalid_data(format!(
            "expected `{event_type}` data.message to equal `{message}`"
        ))
        .into());
    }
    Ok(())
}

struct WireTap<S> {
    inner: S,
    received: Vec<u8>,
    sent: Vec<u8>,
}

impl<S> WireTap<S> {
    fn new(inner: S) -> Self {
        Self {
            inner,
            received: Vec::new(),
            sent: Vec::new(),
        }
    }
}

impl<S: Read> Read for WireTap<S> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let bytes_read = self.inner.read(buffer)?;
        record_frames("RECV RAW", &mut self.received, &buffer[..bytes_read]);
        Ok(bytes_read)
    }
}

impl<S: Write> Write for WireTap<S> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let bytes_written = self.inner.write(bytes)?;
        record_frames("SEND RAW", &mut self.sent, &bytes[..bytes_written]);
        Ok(bytes_written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn record_frames(direction: &str, pending: &mut Vec<u8>, bytes: &[u8]) {
    pending.extend_from_slice(bytes);
    while let Some(end) = pending.iter().position(|byte| *byte == DELIMITER) {
        let frame: Vec<u8> = pending.drain(..=end).collect();
        println!("{direction}: {}", visible_bytes(&frame));
    }
}

fn visible_bytes(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len());
    for &byte in bytes {
        match byte {
            DELIMITER => output.push_str("\\f"),
            b'\r' => output.push_str("\\r"),
            b'\n' => output.push_str("\\n"),
            b'\t' => output.push_str("\\t"),
            0x20..=0x7e => output.push(char::from(byte)),
            _ => {
                let _ = write!(output, "\\x{byte:02x}");
            }
        }
    }
    output
}

fn usage() -> &'static str {
    "usage: cargo run --example nodeRustInterop -- <server|client> [host] [port]"
}
