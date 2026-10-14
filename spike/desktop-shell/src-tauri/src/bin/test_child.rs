//! Dedicated harmless test child binary for supervisor lifecycle and shutdown validation.
#![allow(non_snake_case)]

use std::env;
use std::io::Write;
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

static RUNNING: AtomicBool = AtomicBool::new(true);
static IGNORE_BREAK: AtomicBool = AtomicBool::new(false);

#[link(name = "kernel32")]
unsafe extern "system" {
    fn SetConsoleCtrlHandler(
        HandlerRoutine: Option<unsafe extern "system" fn(u32) -> i32>,
        Add: i32,
    ) -> i32;
}

unsafe extern "system" fn ctrl_handler(ctrl_type: u32) -> i32 {
    // 0 = CTRL_C_EVENT, 1 = CTRL_BREAK_EVENT
    if ctrl_type == 0 || ctrl_type == 1 {
        if IGNORE_BREAK.load(Ordering::SeqCst) {
            println!("[test_child] Received ctrl_type {}, but IGNORE_BREAK is active! Refusing to exit.", ctrl_type);
            let _ = std::io::stdout().flush();
            return 1; // Handled (ignored)
        } else {
            println!("[test_child] Received ctrl_type {}. Triggering clean graceful shutdown.", ctrl_type);
            let _ = std::io::stdout().flush();
            RUNNING.store(false, Ordering::SeqCst);
            return 1; // Handled
        }
    }
    0
}

fn main() {
    let args: Vec<String> = env::args().collect();
    println!("[test_child] Started with PID {} and args: {:?}", std::process::id(), args);
    let _ = std::io::stdout().flush();

    // Check for immediate failure test mode
    if args.iter().any(|a| a == "--fail") {
        eprintln!("[test_child] Intentional failure triggered via --fail");
        std::process::exit(42);
    }

    if args.iter().any(|a| a == "--ignore-break") {
        IGNORE_BREAK.store(true, Ordering::SeqCst);
        println!("[test_child] Configured to IGNORE CTRL_BREAK_EVENT for timeout testing");
    }

    // Register Win32 console handler
    unsafe {
        SetConsoleCtrlHandler(Some(ctrl_handler), 1);
    }

    // Check for --print-env test mode
    if let Some(pos) = args.iter().position(|a| a == "--print-env") {
        if let Some(key) = args.get(pos + 1) {
            let val = env::var(key).unwrap_or_else(|_| "<NOT_SET>".to_string());
            println!("[test_child] ENV {}={}", key, val);
        }
    }

    // Parse listening port if provided
    let mut listener: Option<TcpListener> = None;
    if let Some(pos) = args.iter().position(|a| a == "--listen") {
        if let Some(port_str) = args.get(pos + 1) {
            if let Ok(port) = port_str.parse::<u16>() {
                match TcpListener::bind(("127.0.0.1", port)) {
                    Ok(l) => {
                        println!("[test_child] Successfully listening on 127.0.0.1:{}", port);
                        listener = Some(l);
                    }
                    Err(e) => {
                        eprintln!("[test_child] Failed to bind port {}: {}", port, e);
                        std::process::exit(1);
                    }
                }
            }
        }
    }

    // Mock coordinator HTTP server if provided
    let mut http_listener: Option<TcpListener> = None;
    if let Some(pos) = args.iter().position(|a| a == "--mock-coordinator") {
        if let Some(port_str) = args.get(pos + 1) {
            if let Ok(port) = port_str.parse::<u16>() {
                match TcpListener::bind(("127.0.0.1", port)) {
                    Ok(l) => {
                        println!("[test_child] Successfully listening HTTP on 127.0.0.1:{}", port);
                        l.set_nonblocking(true).expect("Cannot set non-blocking");
                        http_listener = Some(l);
                    }
                    Err(e) => {
                        eprintln!("[test_child] Failed to bind mock HTTP port {}: {}", port, e);
                        std::process::exit(1);
                    }
                }
            }
        }
    }

    let _ = std::io::stdout().flush();

    // Heartbeat and request service loop
    let mut ticks = 0;
    while RUNNING.load(Ordering::SeqCst) {
        if let Some(ref l) = http_listener {
            match l.accept() {
                Ok((mut stream, _)) => {
                    use std::io::Read;
                    let mut buf = [0u8; 512];
                    let _ = stream.read(&mut buf);
                    let resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: 16\r\n\r\n{\"ready\":true}\r\n";
                    let _ = stream.write_all(resp.as_bytes());
                    let _ = stream.flush();
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    // Normal non-blocking condition
                }
                Err(_) => {}
            }
        }

        thread::sleep(Duration::from_millis(50));
        ticks += 1;
        if ticks % 20 == 0 {
            println!("[test_child] Heartbeat tick #{}", ticks / 20);
            let _ = std::io::stdout().flush();
        }
    }

    println!("[test_child] Exiting heartbeat loop. Dropping TCP listeners to release ports...");
    drop(listener);
    drop(http_listener);
    println!("[test_child] Clean shutdown complete. Exiting with code 0.");
    let _ = std::io::stdout().flush();
    std::process::exit(0);
}
