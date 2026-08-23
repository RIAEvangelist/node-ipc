use node_ipc::{Codec, CodecConfig, Connection, Event, JsonValue, Message};
use std::env;
use std::error::Error;
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::mpsc::{self, Receiver};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const REQUEST_EVENT: &str = "node-ipc.bench.request";
const RESPONSE_EVENT: &str = "node-ipc.bench.response";
const SCHEMA: &str = "node-ipc-roundtrip-v1";
const MAX_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;
const JS_MAX_SAFE_INTEGER: u128 = 9_007_199_254_740_991;

const HELP: &str = "Usage: tcp_roundtrip --mode <server|client> [options]\n\
\n\
Options:\n\
  --host <address>         TCP address (default: 127.0.0.1)\n\
  --port <number>          TCP port (default: 9763)\n\
  --warmup <count>         Untimed round trips (default: 1000)\n\
  --count <count>          Measured round trips (default: 100000)\n\
  --payload-bytes <count>  ASCII payload bytes per event (default: 64)\n\
  --inflight <count>       Maximum outstanding requests (default: 1)\n\
  --json                   Emit JSON Lines instead of human-readable output\n\
  --help                   Show this help\n\
\n\
The server and client must use the same warmup, count, and payload-byte values.\n";

type HarnessResult<T> = Result<T, Box<dyn Error>>;
type ReadResult = Result<Message, String>;

#[derive(Clone, Copy)]
enum Mode {
    Server,
    Client,
}

struct Options {
    mode: Mode,
    host: String,
    port: u16,
    warmup: usize,
    count: usize,
    payload_bytes: usize,
    inflight: usize,
    json: bool,
}

struct PhaseResult {
    duration: Duration,
    latencies_ns: Vec<u128>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("node-ipc Rust round-trip peer: {error}");
        std::process::exit(1);
    }
}

fn run() -> HarnessResult<()> {
    let Some(options) = parse_arguments()? else {
        print!("{HELP}");
        return Ok(());
    };

    match options.mode {
        Mode::Server => run_server(&options),
        Mode::Client => run_client(&options),
    }
}

fn parse_arguments() -> HarnessResult<Option<Options>> {
    let mut mode = None;
    let mut host = "127.0.0.1".to_owned();
    let mut port = 9763_u16;
    let mut warmup = 1_000_usize;
    let mut count = 100_000_usize;
    let mut payload_bytes = 64_usize;
    let mut inflight = 1_usize;
    let mut json = false;
    let mut arguments = env::args().skip(1);

    while let Some(argument) = arguments.next() {
        if argument == "--help" || argument == "-h" {
            return Ok(None);
        }
        if argument == "--json" {
            json = true;
            continue;
        }

        let value = arguments
            .next()
            .ok_or_else(|| invalid_input(format!("{argument} requires a value")))?;
        match argument.as_str() {
            "--mode" => {
                mode = Some(match value.as_str() {
                    "server" => Mode::Server,
                    "client" => Mode::Client,
                    _ => return Err(invalid_input("--mode must be either server or client").into()),
                });
            }
            "--host" => host = value,
            "--port" => {
                let parsed = parse_usize(&value, "--port")?;
                if parsed == 0 || parsed > u16::MAX as usize {
                    return Err(invalid_input("--port must be from 1 through 65535").into());
                }
                port = parsed as u16;
            }
            "--warmup" => warmup = parse_usize(&value, "--warmup")?,
            "--count" => count = parse_usize(&value, "--count")?,
            "--payload-bytes" => payload_bytes = parse_usize(&value, "--payload-bytes")?,
            "--inflight" => inflight = parse_usize(&value, "--inflight")?,
            _ => return Err(invalid_input(format!("unknown option: {argument}")).into()),
        }
    }

    let mode = mode.ok_or_else(|| invalid_input("--mode must be either server or client"))?;
    if host.is_empty() {
        return Err(invalid_input("--host must not be empty").into());
    }
    if count == 0 {
        return Err(invalid_input("--count must be at least 1").into());
    }
    if payload_bytes > MAX_PAYLOAD_BYTES {
        return Err(invalid_input(format!(
            "--payload-bytes must not exceed {MAX_PAYLOAD_BYTES}"
        ))
        .into());
    }
    if inflight == 0 {
        return Err(invalid_input("--inflight must be at least 1").into());
    }
    let total = warmup
        .checked_add(count)
        .ok_or_else(|| invalid_input("--warmup plus --count is too large"))?;
    for (name, value) in [
        ("--warmup", warmup),
        ("--count", count),
        ("--inflight", inflight),
        ("--warmup plus --count", total),
    ] {
        if value as u128 > JS_MAX_SAFE_INTEGER {
            return Err(invalid_input(format!(
                "{name} must not exceed JavaScript's safe-integer limit"
            ))
            .into());
        }
    }

    Ok(Some(Options {
        mode,
        host,
        port,
        warmup,
        count,
        payload_bytes,
        inflight: inflight.min(count),
        json,
    }))
}

fn parse_usize(value: &str, name: &str) -> HarnessResult<usize> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid_input(format!("{name} must be a non-negative decimal integer")).into());
    }
    value
        .parse::<usize>()
        .map_err(|_| invalid_input(format!("{name} must be a non-negative integer")).into())
}

fn invalid_input(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

fn invalid_data(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn run_server(options: &Options) -> HarnessResult<()> {
    let listener = node_ipc::tcp::bind((options.host.as_str(), options.port))?;
    let port = listener.local_addr()?.port();
    report_server(options, port, "listening", 0, Duration::ZERO);
    io::stdout().flush()?;

    let (stream, _) = node_ipc::tcp::accept(&listener)?;
    let mut connection = Connection::new(stream, CodecConfig::fast())?;
    let expected_payload = "x".repeat(options.payload_bytes);
    let expected_frames = options
        .warmup
        .checked_add(options.count)
        .ok_or_else(|| invalid_input("--warmup plus --count is too large"))?;
    let mut response = Event::empty(RESPONSE_EVENT);
    let started_at = Instant::now();

    for frame_index in 0..expected_frames {
        let message = connection.recv()?.ok_or_else(|| {
            invalid_data(format!(
                "peer disconnected after {frame_index} of {expected_frames} frames"
            ))
        })?;
        let event = event_from_message(message)?;
        let expected_sequence = if frame_index < options.warmup {
            frame_index
        } else {
            frame_index - options.warmup
        };
        validate_event(
            &event,
            REQUEST_EVENT,
            Some(expected_sequence),
            &expected_payload,
        )?;
        response.data = event.data;
        connection.send(&response)?;
    }
    connection.flush()?;

    report_server(
        options,
        port,
        "complete",
        expected_frames,
        started_at.elapsed(),
    );
    io::stdout().flush()?;
    Ok(())
}

fn run_client(options: &Options) -> HarnessResult<()> {
    let stream = node_ipc::tcp::connect((options.host.as_str(), options.port))?;
    let mut connection = Connection::new(stream, CodecConfig::fast())?;
    let payload = "x".repeat(options.payload_bytes);
    let wire_bytes = wire_bytes_for_phase(connection.codec(), options.count, &payload)?;

    // Keep the latency lane direct. The reader thread is needed only when a
    // blocking writer pipelines enough data to fill both peers' socket buffers.
    if options.inflight == 1 {
        let result = run_client_phases(&mut connection, None, options, &payload)?;
        report_client(options, result, wire_bytes);
        return Ok(());
    }

    let reader_stream = connection.get_ref().try_clone()?;
    let expected_responses = options
        .warmup
        .checked_add(options.count)
        .ok_or_else(|| invalid_input("--warmup plus --count is too large"))?;
    let (responses, reader) =
        spawn_response_reader(reader_stream, expected_responses, options.inflight)?;

    let measured = run_client_phases(&mut connection, Some(&responses), options, &payload);

    // Wake the read half on every exit path, including validation failures.
    let _ = connection.get_ref().shutdown(Shutdown::Both);
    drop(responses);
    let reader_joined = reader
        .join()
        .map_err(|_| invalid_data("response reader thread panicked"));

    let result = measured?;
    reader_joined?;
    report_client(options, result, wire_bytes);
    Ok(())
}

fn run_client_phases<S>(
    connection: &mut Connection<S>,
    responses: Option<&Receiver<ReadResult>>,
    options: &Options,
    payload: &str,
) -> HarnessResult<PhaseResult>
where
    S: Read + Write,
{
    if options.warmup > 0 {
        run_phase(
            connection,
            responses,
            options.warmup,
            payload,
            options.inflight,
            false,
        )?;
    }
    run_phase(
        connection,
        responses,
        options.count,
        payload,
        options.inflight,
        true,
    )
}

fn spawn_response_reader(
    stream: TcpStream,
    expected: usize,
    capacity: usize,
) -> HarnessResult<(Receiver<ReadResult>, JoinHandle<()>)> {
    let mut connection = Connection::new(stream, CodecConfig::fast())?;
    let (sender, receiver) = mpsc::sync_channel(capacity);
    let reader = thread::spawn(move || {
        for received in 0..expected {
            let result = match connection.recv() {
                Ok(Some(message)) => Ok(message),
                Ok(None) => Err(format!(
                    "peer disconnected after {received} of {expected} responses"
                )),
                Err(error) => Err(error.to_string()),
            };
            let failed = result.is_err();
            if sender.send(result).is_err() || failed {
                return;
            }
        }
    });
    Ok((receiver, reader))
}

fn run_phase<S>(
    connection: &mut Connection<S>,
    responses: Option<&Receiver<ReadResult>>,
    count: usize,
    payload: &str,
    inflight: usize,
    record_latency: bool,
) -> HarnessResult<PhaseResult>
where
    S: Read + Write,
{
    let window = inflight.min(count);
    let mut request = benchmark_event(REQUEST_EVENT, payload);
    let mut slots = vec![None; window];
    let mut latencies_ns = if record_latency {
        Vec::with_capacity(count)
    } else {
        Vec::new()
    };
    let mut sent = 0_usize;
    let mut received = 0_usize;
    let started_at = Instant::now();

    fill_window(
        connection,
        &mut request,
        &mut slots,
        &mut sent,
        received,
        count,
    )?;

    while received < count {
        let message = if let Some(responses) = responses {
            responses
                .recv()
                .map_err(|_| invalid_data("response reader stopped before the phase completed"))?
                .map_err(invalid_data)?
        } else {
            connection.recv()?.ok_or_else(|| {
                invalid_data(format!(
                    "peer disconnected after {received} of {count} responses"
                ))
            })?
        };
        let event = event_from_message(message)?;
        let sequence = validate_event(&event, RESPONSE_EVENT, None, payload)?;
        let slot_index = sequence % window;
        let Some((slot_sequence, sent_at)) = slots[slot_index].take() else {
            return Err(invalid_data(format!(
                "unexpected or duplicate response sequence {sequence}"
            ))
            .into());
        };
        if slot_sequence != sequence {
            return Err(invalid_data(format!(
                "expected response sequence {slot_sequence} in slot {slot_index}, received {sequence}"
            ))
            .into());
        }
        if record_latency {
            latencies_ns.push(sent_at.elapsed().as_nanos());
        }
        received += 1;

        fill_window(
            connection,
            &mut request,
            &mut slots,
            &mut sent,
            received,
            count,
        )?;
    }

    let duration = started_at.elapsed();
    if record_latency && duration.is_zero() {
        return Err(invalid_data("measured phase duration was zero").into());
    }
    Ok(PhaseResult {
        duration,
        latencies_ns,
    })
}

fn fill_window<S>(
    connection: &mut Connection<S>,
    request: &mut Event,
    slots: &mut [Option<(usize, Instant)>],
    sent: &mut usize,
    received: usize,
    count: usize,
) -> HarnessResult<()>
where
    S: Read + Write,
{
    while *sent < count && *sent - received < slots.len() {
        let sequence = *sent;
        let slot_index = sequence % slots.len();
        if slots[slot_index].is_some() {
            return Err(invalid_data(format!(
                "latency slot {slot_index} was reused before its response"
            ))
            .into());
        }
        set_sequence(request, sequence)?;
        slots[slot_index] = Some((sequence, Instant::now()));
        connection.send(request)?;
        *sent += 1;
    }
    Ok(())
}

fn benchmark_event(event_type: &str, payload: &str) -> Event {
    Event::new(
        event_type,
        JsonValue::Object(vec![
            ("sequence".to_owned(), JsonValue::from(0_usize)),
            ("payload".to_owned(), JsonValue::from(payload)),
        ]),
    )
}

fn set_sequence(event: &mut Event, sequence: usize) -> HarnessResult<()> {
    let members = event
        .data
        .as_object_mut()
        .ok_or_else(|| invalid_data("benchmark event data is not an object"))?;
    let (name, value) = members
        .first_mut()
        .ok_or_else(|| invalid_data("benchmark event data has no sequence"))?;
    if name != "sequence" {
        return Err(invalid_data("benchmark event data has no sequence").into());
    }
    value
        .as_number_mut()
        .ok_or_else(|| invalid_data("benchmark event sequence is not a number"))?
        .set_usize(sequence);
    Ok(())
}

fn event_from_message(message: Message) -> HarnessResult<Event> {
    match message {
        Message::Event(event) => Ok(event),
        Message::Raw(_) => Err(invalid_data("received raw bytes in a framed benchmark").into()),
    }
}

fn validate_event(
    event: &Event,
    expected_type: &str,
    expected_sequence: Option<usize>,
    expected_payload: &str,
) -> HarnessResult<usize> {
    if event.event_type() != expected_type {
        return Err(invalid_data(format!(
            "expected event type {expected_type}, received {}",
            event.event_type()
        ))
        .into());
    }

    let sequence = event
        .data
        .get("sequence")
        .and_then(JsonValue::as_number)
        .ok_or_else(|| invalid_data("event sequence is not a number"))?
        .as_str()
        .parse::<usize>()
        .map_err(|_| invalid_data("event sequence is not a non-negative integer"))?;
    if let Some(expected) = expected_sequence {
        if sequence != expected {
            return Err(
                invalid_data(format!("expected sequence {expected}, received {sequence}")).into(),
            );
        }
    }

    let payload = event
        .data
        .get("payload")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| invalid_data("event payload is not a string"))?;
    if payload != expected_payload {
        return Err(invalid_data(format!("payload mismatch for sequence {sequence}")).into());
    }
    Ok(sequence)
}

fn wire_bytes_for_phase(codec: &Codec, count: usize, payload: &str) -> HarnessResult<u128> {
    let mut event = benchmark_event(REQUEST_EVENT, payload);
    let request_base = codec.encode(&event)?.len() as u128;
    event.event_type.clear();
    event.event_type.push_str(RESPONSE_EVENT);
    let response_base = codec.encode(&event)?.len() as u128;
    let extra_sequence_digits = extra_sequence_digits(count);
    Ok(count as u128 * (request_base + response_base) + 2 * extra_sequence_digits)
}

fn extra_sequence_digits(count: usize) -> u128 {
    let mut total = 0_u128;
    let mut range_start = 10_usize;
    let mut extra_digits = 1_u128;
    while range_start < count {
        let range_end = range_start
            .checked_mul(10)
            .map_or(count, |end| end.min(count));
        total += (range_end - range_start) as u128 * extra_digits;
        if range_end == count {
            break;
        }
        range_start = range_end;
        extra_digits += 1;
    }
    total
}

fn report_server(options: &Options, port: u16, status: &str, frames: usize, duration: Duration) {
    if options.json {
        println!(
            "{{\"schema\":\"{SCHEMA}\",\"language\":\"rust\",\"role\":\"server\",\"status\":\"{status}\",\"host\":{},\"port\":{port},\"frames\":{frames},\"duration_ns\":{}}}",
            JsonValue::from(options.host.as_str()).to_json_string(),
            duration.as_nanos()
        );
        return;
    }

    if status == "listening" {
        println!("Rust server listening on {}:{port}", options.host);
    } else {
        println!(
            "Rust server completed {frames} validated frames in {}",
            format_duration(duration.as_nanos())
        );
    }
}

fn report_client(options: &Options, mut result: PhaseResult, wire_bytes: u128) {
    result.latencies_ns.sort_unstable();
    let duration_ns = result.duration.as_nanos();
    let seconds = result.duration.as_secs_f64();
    let round_trips_per_second = options.count as f64 / seconds;
    let wire_bytes_per_second = wire_bytes as f64 / seconds;
    let latency_sum: u128 = result.latencies_ns.iter().sum();
    let latency_mean = latency_sum as f64 / result.latencies_ns.len() as f64;
    let p50 = percentile(&result.latencies_ns, 50, 100);
    let p95 = percentile(&result.latencies_ns, 95, 100);
    let p99 = percentile(&result.latencies_ns, 99, 100);
    let maximum = result.latencies_ns.last().copied().unwrap_or(0);

    if options.json {
        println!(
            concat!(
                "{{\"schema\":\"{}\",\"language\":\"rust\",\"role\":\"client\",",
                "\"host\":{},\"port\":{},\"warmup\":{},\"count\":{},",
                "\"payload_bytes\":{},\"inflight\":{},\"duration_ns\":{},",
                "\"round_trips_per_second\":{:.3},\"wire_bytes_per_second\":{:.3},",
                "\"latency_ns\":{{\"mean\":{:.3},\"p50\":{},\"p95\":{},\"p99\":{},\"max\":{}}}}}"
            ),
            SCHEMA,
            JsonValue::from(options.host.as_str()).to_json_string(),
            options.port,
            options.warmup,
            options.count,
            options.payload_bytes,
            options.inflight,
            duration_ns,
            round_trips_per_second,
            wire_bytes_per_second,
            latency_mean,
            p50,
            p95,
            p99,
            maximum
        );
        return;
    }

    println!("Rust TCP round-trip result");
    println!("  count:       {}", options.count);
    println!("  payload:     {} bytes", options.payload_bytes);
    println!("  inflight:    {}", options.inflight);
    println!("  throughput:  {round_trips_per_second:.3} round trips/s");
    println!(
        "  wire rate:   {:.3} MiB/s",
        wire_bytes_per_second / 1024.0 / 1024.0
    );
    println!("  latency p50: {}", format_duration(p50));
    println!("  latency p95: {}", format_duration(p95));
    println!("  latency p99: {}", format_duration(p99));
    println!("  latency max: {}", format_duration(maximum));
}

fn percentile(sorted: &[u128], numerator: usize, denominator: usize) -> u128 {
    let rank = sorted.len().saturating_mul(numerator).div_ceil(denominator);
    sorted[rank.saturating_sub(1)]
}

fn format_duration(nanoseconds: u128) -> String {
    if nanoseconds < 1_000 {
        return format!("{nanoseconds} ns");
    }
    if nanoseconds < 1_000_000 {
        return format!("{:.3} us", nanoseconds as f64 / 1_000.0);
    }
    if nanoseconds < 1_000_000_000 {
        return format!("{:.3} ms", nanoseconds as f64 / 1_000_000.0);
    }
    format!("{:.3} s", nanoseconds as f64 / 1_000_000_000.0)
}
