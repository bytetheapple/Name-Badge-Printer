"""Quick printer status probe.

Usage:  ./venv/bin/python status_check.py [PRINTER_IP]

Sends a status request over the raw print port (9100) and dumps the reply.
Useful to confirm the printer is answering status queries (which needs P-touch
Template mode OFF and Raster command mode) and to see the media it has detected.

Stop the bridge first so it doesn't compete for the connection:
    sudo systemctl stop name-badge-bridge   # (or Ctrl-C a foreground run)
"""
import socket
import sys

import printer

STATUS_REQUEST = b"\x1b\x69\x53"  # ESC i S


def main():
    ip = sys.argv[1] if len(sys.argv) > 1 else "192.168.1.69"
    port = 9100
    print(f"Probing {ip}:{port}\n")

    print("--- raw status read (invalidate + initialize + request) ---")
    try:
        s = socket.create_connection((ip, port), timeout=5)
        s.sendall(b"\x00" * 100)  # invalidate
        s.sendall(b"\x1b\x40")  # initialize
        s.sendall(STATUS_REQUEST)  # request status
        s.settimeout(5)
        buf = b""
        while len(buf) < 32:
            chunk = s.recv(32 - len(buf))
            if not chunk:
                break
            buf += chunk
        s.close()
        print(f"received {len(buf)} bytes: {buf.hex(' ')}")
        if len(buf) >= 12:
            print(
                f"  error1=0x{buf[8]:02x}  error2=0x{buf[9]:02x}  "
                f"media_width={buf[10]} mm  media_type=0x{buf[11]:02x}"
            )
        elif not buf:
            print("  (empty — printer still isn't answering status requests)")
    except OSError as e:
        print(f"  connection error: {e}")

    print("\n--- printer.query_status() (what the bridge uses) ---")
    print(printer.query_status(ip, port))


if __name__ == "__main__":
    main()
