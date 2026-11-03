"""Minimal GGML RPC server for tunnel tests.

Speaks just enough of the wire protocol to answer the probe:
  HELLO (14)        -> 28 byte response
  DEVICE_COUNT (15) -> u32 device count
Any other command is echoed back byte for byte so payload integrity can be
checked without a real model.
"""

import socket
import struct
import sys
import threading

HELLO = 14
DEVICE_COUNT = 15


def read_exact(conn, n):
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("peer closed")
        buf += chunk
    return buf


def handle(conn):
    try:
        while True:
            cmd = read_exact(conn, 1)[0]
            size = struct.unpack("<Q", read_exact(conn, 8))[0]
            body = read_exact(conn, size) if size else b""
            if cmd == HELLO:
                conn.sendall(struct.pack("<Q", 28) + bytes(28))
            elif cmd == DEVICE_COUNT:
                conn.sendall(struct.pack("<Q", 4) + struct.pack("<I", 1))
            else:
                # echo payload so the caller can verify no bytes were lost
                conn.sendall(struct.pack("<Q", size) + body)
    except (ConnectionError, OSError):
        pass
    finally:
        conn.close()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 50052
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", port))
    srv.listen(8)
    print(f"mock rpc listening on 127.0.0.1:{port}", flush=True)
    while True:
        conn, _ = srv.accept()
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        threading.Thread(target=handle, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
