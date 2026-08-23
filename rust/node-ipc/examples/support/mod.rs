#![allow(dead_code)]

use node_ipc::{Connection, Event, JsonValue, Message};
use std::error::Error;
use std::io::{self, Read, Write};

pub type ExampleResult<T> = Result<T, Box<dyn Error>>;

pub const APP_MESSAGE: &str = "app.message";
pub const KILL_CONNECTION: &str = "kill.connection";

pub fn text_event(event_type: &str, message: &str) -> Event {
    Event::new(event_type, message)
}

pub fn app_event(id: &str, message: &str) -> Event {
    Event::new(
        APP_MESSAGE,
        JsonValue::Object(vec![
            ("id".to_owned(), JsonValue::from(id)),
            ("message".to_owned(), JsonValue::from(message)),
        ]),
    )
}

pub fn receive_event<S>(connection: &mut Connection<S>) -> ExampleResult<Event>
where
    S: Read + Write,
{
    match connection.recv()? {
        Some(Message::Event(event)) => Ok(event),
        Some(Message::Raw(_)) => Err(invalid_data("expected a framed event").into()),
        None => Err(invalid_data("peer disconnected before sending an event").into()),
    }
}

pub fn receive_raw<S>(connection: &mut Connection<S>) -> ExampleResult<Vec<u8>>
where
    S: Read + Write,
{
    match connection.recv()? {
        Some(Message::Raw(bytes)) => Ok(bytes),
        Some(Message::Event(_)) => Err(invalid_data("expected raw bytes").into()),
        None => Err(invalid_data("peer disconnected before sending bytes").into()),
    }
}

pub fn expect_text<'a>(event: &'a Event, expected_type: &str) -> ExampleResult<&'a str> {
    expect_type(event, expected_type)?;
    event
        .data
        .as_str()
        .ok_or_else(|| invalid_data("event data is not a string").into())
}

pub fn expect_app<'a>(event: &'a Event, expected_type: &str) -> ExampleResult<(&'a str, &'a str)> {
    expect_type(event, expected_type)?;
    let id = event
        .data
        .get("id")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| invalid_data("event data has no string `id`"))?;
    let message = event
        .data
        .get("message")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| invalid_data("event data has no string `message`"))?;
    Ok((id, message))
}

pub fn expect_type(event: &Event, expected_type: &str) -> ExampleResult<()> {
    if event.event_type() != expected_type {
        return Err(invalid_data(format!(
            "expected event `{expected_type}`, received `{}`",
            event.event_type()
        ))
        .into());
    }
    Ok(())
}

pub fn parse_port(value: &str) -> ExampleResult<u16> {
    value
        .parse::<u16>()
        .map_err(|_| invalid_input("port must be an integer from 1 through 65535").into())
        .and_then(|port| {
            if port == 0 {
                Err(invalid_input("port must be an integer from 1 through 65535").into())
            } else {
                Ok(port)
            }
        })
}

pub fn invalid_input(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

pub fn invalid_data(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}
