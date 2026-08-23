#[cfg(unix)]
#[path = "../support/mod.rs"]
mod support;

#[cfg(unix)]
mod unix_example {
    use super::support;
    use node_ipc::{CodecConfig, Connection, Event, JsonValue};
    use std::error::Error;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    const REQUEST_EVENT: &str = "currentDate";
    const RESPONSE_EVENT: &str = "currentDate.ack";

    pub fn run() -> Result<(), Box<dyn Error>> {
        let mut arguments = std::env::args().skip(1);
        let role = arguments
            .next()
            .ok_or_else(|| support::invalid_input(usage()))?;
        let endpoint = arguments
            .next()
            .map_or_else(default_endpoint, PathBuf::from);
        let count = arguments
            .next()
            .map(|value| value.parse::<usize>())
            .transpose()?
            .unwrap_or(4);
        if count == 0 || arguments.next().is_some() {
            return Err(support::invalid_input(usage()).into());
        }

        match role.as_str() {
            "server" => run_server(&endpoint, count),
            "client" => run_client(&endpoint, count),
            _ => Err(support::invalid_input(usage()).into()),
        }
    }

    fn run_server(endpoint: &Path, count: usize) -> Result<(), Box<dyn Error>> {
        let listener = node_ipc::local::LocalListener::bind(endpoint)?;
        println!(
            "Rust Unix worker server listening on {}",
            endpoint.display()
        );

        let worker_count = thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1)
            .min(count)
            .min(4);
        let next_connection = Arc::new(AtomicUsize::new(0));
        let mut workers = Vec::with_capacity(worker_count);

        for worker_id in 0..worker_count {
            let worker_listener = listener.as_listener().try_clone()?;
            let next_connection = Arc::clone(&next_connection);
            workers.push(thread::spawn(move || {
                worker_loop(worker_listener, worker_id, count, next_connection)
            }));
        }

        for worker in workers {
            worker
                .join()
                .map_err(|_| support::invalid_data("Unix worker thread panicked"))?
                .map_err(support::invalid_data)?;
        }
        println!("Handled {count} connections across {worker_count} workers");
        Ok(())
    }

    fn worker_loop(
        listener: UnixListener,
        worker_id: usize,
        count: usize,
        next_connection: Arc<AtomicUsize>,
    ) -> Result<(), String> {
        loop {
            let connection_id = next_connection.fetch_add(1, Ordering::Relaxed);
            if connection_id >= count {
                return Ok(());
            }
            let (stream, _) = listener.accept().map_err(|error| error.to_string())?;
            prepare_stream(&stream).map_err(|error| error.to_string())?;
            let mut connection =
                Connection::new(stream, CodecConfig::fast()).map_err(|error| error.to_string())?;
            let request =
                support::receive_event(&mut connection).map_err(|error| error.to_string())?;
            support::expect_type(&request, REQUEST_EVENT).map_err(|error| error.to_string())?;
            let message = request
                .data
                .get("message")
                .and_then(JsonValue::as_str)
                .ok_or_else(|| "currentDate event has no string message".to_owned())?;
            println!("worker {worker_id} received connection {connection_id}: {message}");
            connection
                .send(&Event::new(
                    RESPONSE_EVENT,
                    JsonValue::Object(vec![("worker".to_owned(), JsonValue::from(worker_id))]),
                ))
                .map_err(|error| error.to_string())?;
            connection.flush().map_err(|error| error.to_string())?;
        }
    }

    fn run_client(endpoint: &Path, count: usize) -> Result<(), Box<dyn Error>> {
        for connection_id in 0..count {
            let stream = node_ipc::local::connect(endpoint)?;
            prepare_stream(&stream)?;
            let mut connection = Connection::new(stream, CodecConfig::fast())?;
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)?
                .as_millis()
                .to_string();
            connection.send(&Event::new(
                REQUEST_EVENT,
                JsonValue::Object(vec![("message".to_owned(), JsonValue::from(timestamp))]),
            ))?;
            connection.flush()?;

            let response = support::receive_event(&mut connection)?;
            support::expect_type(&response, RESPONSE_EVENT)?;
            let worker = response
                .data
                .get("worker")
                .and_then(JsonValue::as_number)
                .ok_or_else(|| support::invalid_data("ack has no numeric worker"))?;
            println!("connection {connection_id} handled by worker {worker}");
        }
        Ok(())
    }

    fn prepare_stream(stream: &UnixStream) -> std::io::Result<()> {
        let timeout = Some(Duration::from_secs(30));
        stream.set_read_timeout(timeout)?;
        stream.set_write_timeout(timeout)
    }

    fn default_endpoint() -> PathBuf {
        std::env::temp_dir().join("node-ipc-rust-cluster.sock")
    }

    fn usage() -> &'static str {
        "usage: cargo run --example clusterUnixSocket -- <server|client> [endpoint] [count]"
    }
}

#[cfg(unix)]
fn main() {
    if let Err(error) = unix_example::run() {
        eprintln!("Rust clusterUnixSocket example: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(unix))]
fn main() {
    eprintln!("clusterUnixSocket is a Unix-only example; use unixWindowsSocket on Windows");
    std::process::exit(1);
}
