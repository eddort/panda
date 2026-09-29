use slot_clock::{controlled, SlotClock, SystemTimeSlotClock};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;
use types::Slot;

fn request(port: u16, path: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    write!(stream, "POST {} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n", path).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

#[tokio::test]
async fn protocol_time_waits_for_commands_and_rejects_backwards_moves() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    std::env::set_var("ZAP_CLOCK_START_MS", "2000000000000");
    std::env::set_var("ZAP_CLOCK_PORT", port.to_string());
    let clock = SystemTimeSlotClock::new(Slot::new(0), Duration::from_secs(2_000_000_000), Duration::from_secs(12));
    assert_eq!(clock.now(), Some(Slot::new(0)));
    let wait = controlled::sleep(Duration::from_secs(12));
    tokio::pin!(wait);
    assert!(tokio::time::timeout(Duration::from_millis(20), &mut wait).await.is_err());
    assert_eq!(clock.now(), Some(Slot::new(0)));
    let response = tokio::task::spawn_blocking(move || request(port, "/advance/2000000012000")).await.unwrap();
    assert!(response.contains("200 OK"));
    tokio::time::timeout(Duration::from_millis(100), &mut wait).await.unwrap();
    assert_eq!(clock.now(), Some(Slot::new(1)));
    let response = tokio::task::spawn_blocking(move || request(port, "/advance/2000000000000")).await.unwrap();
    assert!(response.contains("409 Conflict"));
    assert_eq!(clock.now(), Some(Slot::new(1)));
    // A late subscriber sees the current time; a zero-delay retry waits rather than spinning.
    assert!(tokio::time::timeout(Duration::from_millis(20), controlled::sleep(Duration::ZERO)).await.is_err());
}
