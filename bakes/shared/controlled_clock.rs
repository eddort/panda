//! Devnet-only protocol clock. Real I/O deadlines deliberately remain on tokio::time.
//! Enabled only by ZAP_CLOCK_START_MS and ZAP_CLOCK_PORT. Never use on a public network.
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;
use tokio::time::Instant;

struct Clock {
    time: watch::Sender<u64>,
    start: u64,
    origin: Instant,
    marks: Mutex<BTreeMap<String, u64>>,
}
static CLOCK: OnceLock<Option<Clock>> = OnceLock::new();

fn clock() -> Option<&'static Clock> {
    CLOCK.get_or_init(|| {
        let start = std::env::var("ZAP_CLOCK_START_MS").ok()?.parse::<u64>()
            .expect("ZAP_CLOCK_START_MS must be an unsigned integer");
        let port = std::env::var("ZAP_CLOCK_PORT").expect("ZAP_CLOCK_PORT is required")
            .parse::<u16>().expect("invalid clock port");
        // Bind before spawning, so an unavailable control port fails startup immediately.
        let listener = TcpListener::bind(("0.0.0.0", port)).expect("bind devnet clock");
        std::thread::Builder::new().name("zap-clock".into()).spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
                let mut line = String::new();
                if BufReader::new(&stream).read_line(&mut line).is_err() { continue; }
                let Some(clock) = clock() else { return };
                let mut status = "200 OK";
                let parts: Vec<_> = line.split_whitespace().collect();
                match parts.as_slice() {
                    ["GET", "/", _] => (),
                    ["POST", path, _] if path.starts_with("/advance/") => {
                        match path.trim_start_matches("/advance/").parse::<u64>() {
                            Ok(next) if next >= *clock.time.borrow() && next - clock.start < 31_536_000_000_000 => {
                                clock.time.send_replace(next);
                            }
                            _ => status = "409 Conflict",
                        }
                    }
                    _ => status = "400 Bad Request",
                }
                let now = *clock.time.borrow();
                let marks = clock.marks.lock().expect("clock marks");
                let marks = marks.iter().map(|(k, v)| format!("\"{}\":{}", k, v))
                    .collect::<Vec<_>>().join(",");
                let body = format!("{{\"nowMs\":{},\"marks\":{{{}}}}}", now, marks);
                let _ = write!(stream, "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", status, body.len(), body);
            }
        }).expect("spawn devnet clock");
        Some(Clock { time: watch::channel(start).0, start, origin: Instant::now(), marks: Mutex::new(BTreeMap::new()) })
    }).as_ref()
}

pub fn now() -> Option<Duration> {
    match clock() {
        Some(clock) => Some(Duration::from_millis(*clock.time.borrow())),
        None => SystemTime::now().duration_since(UNIX_EPOCH).ok(),
    }
}

pub fn instant_now() -> Instant {
    match clock() {
        Some(clock) => clock.origin + Duration::from_millis(*clock.time.borrow() - clock.start),
        None => Instant::now(),
    }
}

pub async fn sleep(duration: Duration) {
    // A zero-duration retry must yield until time changes, rather than spin while paused.
    let duration = if clock().is_some() { duration.max(Duration::from_millis(1)) } else { duration };
    sleep_until(instant_now() + duration).await;
}

pub async fn sleep_until(deadline: Instant) {
    if let Some(clock) = clock() {
        let mut receiver = clock.time.subscribe();
        loop {
            // Subscribe before checking: advances between the check and await cannot be lost.
            let current = *receiver.borrow_and_update();
            if clock.origin + Duration::from_millis(current - clock.start) >= deadline { break; }
            if receiver.changed().await.is_err() { break; }
        }
    } else {
        tokio::time::sleep_until(deadline).await;
    }
}

/// A completion watermark; control code waits for successful protocol work, not elapsed wall time.
pub fn mark(name: &str, slot: u64) {
    if let Some(clock) = clock() {
        clock.marks.lock().expect("clock marks").insert(name.into(), slot);
    }
}
