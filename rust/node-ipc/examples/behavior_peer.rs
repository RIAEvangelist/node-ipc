use node_ipc::{Codec, CodecConfig, Connection, Event, JsonValue, Message, json, tcp};
use std::collections::HashSet;
use std::env;
use std::error::Error;
use std::fs;
use std::io::{self, Write};
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

const LANGUAGE: &str = "rust";
const DEFAULT_HOST: &str = "127.0.0.1";
const IO_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

type PeerResult<T> = Result<T, Box<dyn Error>>;

#[derive(Clone, Copy)]
enum Mode {
    Server,
    Client,
}

struct Options {
    mode: Mode,
    host: String,
    port: u16,
    contract: PathBuf,
}

struct BehaviorContract {
    schema: String,
    step_count: usize,
    exchanges: Vec<BehaviorExchange>,
}

struct BehaviorExchange {
    id: String,
    request: String,
    request_data: JsonValue,
    response: String,
    response_data: JsonValue,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("node-ipc Rust behavioral peer: {error}");
        std::process::exit(1);
    }
}

fn run() -> PeerResult<()> {
    let options = parse_arguments()?;
    let contract = load_contract(&options.contract)?;
    match options.mode {
        Mode::Server => run_server(&options, &contract),
        Mode::Client => run_client(&options, &contract),
    }
}

fn parse_arguments() -> PeerResult<Options> {
    let mut mode = None;
    let mut host = DEFAULT_HOST.to_owned();
    let mut port = None;
    let mut contract = None;
    let mut json_output = false;
    let mut arguments = env::args().skip(1);

    while let Some(argument) = arguments.next() {
        if argument == "--json" {
            json_output = true;
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
                    _ => return Err(invalid_input("--mode must be server or client").into()),
                });
            }
            "--host" => host = value,
            "--port" => port = Some(parse_port(&value)?),
            "--contract" => contract = Some(PathBuf::from(value)),
            _ => return Err(invalid_input(format!("unknown option: {argument}")).into()),
        }
    }

    if host.is_empty() {
        return Err(invalid_input("--host must not be empty").into());
    }
    if !json_output {
        return Err(invalid_input("--json is required for the behavioral peer").into());
    }
    Ok(Options {
        mode: mode.ok_or_else(|| invalid_input("--mode is required"))?,
        host,
        port: port.ok_or_else(|| invalid_input("--port is required"))?,
        contract: contract.ok_or_else(|| invalid_input("--contract is required"))?,
    })
}

fn parse_port(value: &str) -> PeerResult<u16> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid_input("--port must be an unsigned decimal integer").into());
    }
    let port = value
        .parse::<u16>()
        .map_err(|_| invalid_input("--port must be from 1 through 65535"))?;
    if port == 0 {
        return Err(invalid_input("--port must be from 1 through 65535").into());
    }
    Ok(port)
}

fn load_contract(file: &Path) -> PeerResult<BehaviorContract> {
    let root = json::parse_with_max_depth(&fs::read(file)?, 64)?;
    validate_portable_json(&root, "contract")?;
    let schema = required_string(&root, "schema")?;
    require(
        schema == "node-ipc-behavior-v1",
        "unexpected behavior schema",
    )?;
    require(
        required_string(&root, "profile")? == "fast",
        "profile must be fast",
    )?;
    require(
        required_string(&root, "delimiterHex")? == "0c",
        "delimiterHex must be 0c",
    )?;

    let wire_probe = required_value(&root, "wireProbe")?;
    let wire_type = required_string(wire_probe, "type")?;
    let wire_data = required_value(wire_probe, "data")?.clone();
    let expected_frame = required_string(wire_probe, "frame")?;
    let encoded_frame =
        Codec::new(CodecConfig::fast())?.encode(&Event::new(wire_type, wire_data))?;
    require(
        encoded_frame == expected_frame.as_bytes(),
        "Fast encoder changed the canonical wire probe",
    )?;

    let steps = root
        .get("steps")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| invalid_data("steps must be an array"))?;
    require(
        !steps.is_empty(),
        "the behavior contract requires at least one step",
    )?;
    let step_count = steps.len();
    let mut exchanges = Vec::with_capacity(step_count + 1);
    for step in steps {
        let data = required_value(step, "data")?.clone();
        exchanges.push(BehaviorExchange {
            id: required_string(step, "id")?,
            request: required_string(step, "request")?,
            request_data: data.clone(),
            response: required_string(step, "response")?,
            response_data: data,
        });
    }

    let finish = required_value(&root, "finish")?;
    let request_data = required_value(finish, "requestData")?.clone();
    let response_data = required_value(finish, "responseData")?.clone();
    require(
        required_usize(&request_data, "expected")? == step_count,
        "finish.requestData.expected must match the step count",
    )?;
    require(
        required_usize(&response_data, "received")? == step_count,
        "finish.responseData.received must match the step count",
    )?;
    exchanges.push(BehaviorExchange {
        id: required_string(finish, "id")?,
        request: required_string(finish, "request")?,
        request_data,
        response: required_string(finish, "response")?,
        response_data,
    });

    let mut ids = HashSet::new();
    let mut requests = HashSet::new();
    let mut responses = HashSet::new();
    for exchange in &exchanges {
        require(
            ids.insert(exchange.id.as_str()),
            format!("duplicate behavior id: {}", exchange.id),
        )?;
        require(
            requests.insert(exchange.request.as_str()),
            format!("duplicate request event: {}", exchange.request),
        )?;
        require(
            responses.insert(exchange.response.as_str()),
            format!("duplicate response event: {}", exchange.response),
        )?;
    }

    Ok(BehaviorContract {
        schema,
        step_count,
        exchanges,
    })
}

fn run_server(options: &Options, contract: &BehaviorContract) -> PeerResult<()> {
    let listener = tcp::bind((options.host.as_str(), options.port))?;
    report(options, contract, "server", "listening");
    io::stdout().flush()?;

    let (stream, _) = tcp::accept(&listener)?;
    prepare_stream(&stream)?;
    let mut connection = Connection::new(stream, CodecConfig::fast())?;
    for expected in &contract.exchanges {
        let message = connection
            .recv()?
            .ok_or_else(|| invalid_data(format!("peer disconnected before {}", expected.id)))?;
        let event = event_from_message(message)?;
        require(
            event.event_type() == expected.request,
            format!(
                "expected request {} at {}, received {}",
                expected.request,
                expected.id,
                event.event_type()
            ),
        )?;
        require_json_equal(&expected.request_data, &event.data, &expected.id, "request")?;
        connection.send(&Event::new(
            expected.response.as_str(),
            expected.response_data.clone(),
        ))?;
    }
    connection.flush()?;
    require(
        connection.recv()?.is_none(),
        "client sent a trailing frame after the finish request",
    )?;
    report(options, contract, "server", "complete");
    io::stdout().flush()?;
    Ok(())
}

fn run_client(options: &Options, contract: &BehaviorContract) -> PeerResult<()> {
    let stream = tcp::connect((options.host.as_str(), options.port))?;
    prepare_stream(&stream)?;
    let mut connection = Connection::new(stream, CodecConfig::fast())?;

    let (steps, finish) = contract.exchanges.split_at(contract.step_count);
    let finish = finish
        .first()
        .ok_or_else(|| invalid_data("the behavior contract is missing its finish exchange"))?;

    for exchange in steps {
        connection.send(&Event::new(
            exchange.request.as_str(),
            exchange.request_data.clone(),
        ))?;
    }
    connection.flush()?;

    for expected in steps {
        receive_response(&mut connection, expected)?;
    }

    connection.send(&Event::new(
        finish.request.as_str(),
        finish.request_data.clone(),
    ))?;
    connection.flush()?;
    receive_response(&mut connection, finish)?;
    connection.get_ref().shutdown(Shutdown::Write)?;
    require(
        connection.recv()?.is_none(),
        "server sent a trailing frame after the finish response",
    )?;

    report(options, contract, "client", "complete");
    io::stdout().flush()?;
    Ok(())
}

fn receive_response(
    connection: &mut Connection<TcpStream>,
    expected: &BehaviorExchange,
) -> PeerResult<()> {
    let message = connection.recv()?.ok_or_else(|| {
        invalid_data(format!(
            "peer disconnected before the response for {}",
            expected.id
        ))
    })?;
    let event = event_from_message(message)?;
    require(
        event.event_type() == expected.response,
        format!(
            "expected response {} at {}, received {}",
            expected.response,
            expected.id,
            event.event_type()
        ),
    )?;
    require_json_equal(
        &expected.response_data,
        &event.data,
        &expected.id,
        "response",
    )
}

fn prepare_stream(stream: &TcpStream) -> io::Result<()> {
    stream.set_nodelay(true)?;
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))
}

fn event_from_message(message: Message) -> PeerResult<Event> {
    match message {
        Message::Event(event) => Ok(event),
        Message::Raw(_) => Err(invalid_data("received raw bytes in a Fast behavior test").into()),
    }
}

fn required_value<'a>(value: &'a JsonValue, key: &str) -> PeerResult<&'a JsonValue> {
    value
        .get(key)
        .ok_or_else(|| invalid_data(format!("missing contract field: {key}")).into())
}

fn required_string(value: &JsonValue, key: &str) -> PeerResult<String> {
    let text = required_value(value, key)?
        .as_str()
        .ok_or_else(|| invalid_data(format!("{key} must be a string")))?;
    require(!text.is_empty(), format!("{key} must not be empty"))?;
    Ok(text.to_owned())
}

fn required_usize(value: &JsonValue, key: &str) -> PeerResult<usize> {
    required_value(value, key)?
        .as_number()
        .ok_or_else(|| invalid_data(format!("{key} must be a number")))?
        .as_str()
        .parse::<usize>()
        .map_err(|_| invalid_data(format!("{key} must be a non-negative integer")).into())
}

fn require_json_equal(
    expected: &JsonValue,
    actual: &JsonValue,
    id: &str,
    direction: &str,
) -> PeerResult<()> {
    require(
        json_equivalent(expected, actual),
        format!(
            "{direction} payload mismatch at {id}: expected {}, received {}",
            expected.to_json_string(),
            actual.to_json_string()
        ),
    )
}

fn json_equivalent(left: &JsonValue, right: &JsonValue) -> bool {
    match (left, right) {
        (JsonValue::Null, JsonValue::Null) => true,
        (JsonValue::Bool(left), JsonValue::Bool(right)) => left == right,
        (JsonValue::Number(left), JsonValue::Number(right)) => left == right,
        (JsonValue::String(left), JsonValue::String(right)) => left == right,
        (JsonValue::Array(left), JsonValue::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| json_equivalent(left, right))
        }
        (JsonValue::Object(left), JsonValue::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, left_value)| {
                    right
                        .iter()
                        .find_map(|(candidate, value)| (candidate == key).then_some(value))
                        .is_some_and(|right_value| json_equivalent(left_value, right_value))
                })
        }
        _ => false,
    }
}

fn validate_portable_json(value: &JsonValue, location: &str) -> PeerResult<()> {
    match value {
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::String(_) => Ok(()),
        JsonValue::Number(number) => {
            let parsed = number.as_str().parse::<i64>().map_err(|_| {
                invalid_data(format!(
                    "{location} must contain only canonical safe integers"
                ))
            })?;
            require(
                (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&parsed)
                    && parsed.to_string() == number.as_str(),
                format!("{location} must contain only canonical safe integers"),
            )
        }
        JsonValue::Array(values) => {
            for (index, entry) in values.iter().enumerate() {
                validate_portable_json(entry, &format!("{location}[{index}]"))?;
            }
            Ok(())
        }
        JsonValue::Object(members) => {
            let mut names = HashSet::new();
            for (name, entry) in members {
                require(
                    names.insert(name.as_str()),
                    format!("{location} contains duplicate object member {name}"),
                )?;
                validate_portable_json(entry, &format!("{location}.{name}"))?;
            }
            Ok(())
        }
    }
}

fn report(options: &Options, contract: &BehaviorContract, role: &str, status: &str) {
    let scenario_ids = JsonValue::Array(
        contract
            .exchanges
            .iter()
            .map(|exchange| JsonValue::from(exchange.id.as_str()))
            .collect(),
    );
    let record = JsonValue::Object(vec![
        (
            "schema".to_owned(),
            JsonValue::from(contract.schema.as_str()),
        ),
        ("language".to_owned(), JsonValue::from(LANGUAGE)),
        ("role".to_owned(), JsonValue::from(role)),
        ("status".to_owned(), JsonValue::from(status)),
        ("host".to_owned(), JsonValue::from(options.host.as_str())),
        ("port".to_owned(), JsonValue::from(options.port)),
        ("steps".to_owned(), JsonValue::from(contract.step_count)),
        (
            "frames".to_owned(),
            JsonValue::from(contract.exchanges.len()),
        ),
        ("scenario_ids".to_owned(), scenario_ids),
    ]);
    println!("{}", record.to_json_string());
}

fn require(condition: bool, message: impl Into<String>) -> PeerResult<()> {
    if condition {
        Ok(())
    } else {
        Err(invalid_data(message).into())
    }
}

fn invalid_input(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

fn invalid_data(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}
