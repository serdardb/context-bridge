import socket
import sys
import threading
import time

mode = sys.argv[1]
pair = socket.socketpair() if mode == "socket" else None
if pair:
    def wake():
        time.sleep(5)
        pair[1].sendall(b"wake")
    threading.Thread(target=wake, daemon=True).start()

started = time.monotonic()
print("INTERRUPTED_STREAM_8741", flush=True)
try:
    if pair:
        pair[0].recv(1)
        print("SOCKET_RETURNED_WITHOUT_INTERRUPT", flush=True)
        sys.exit(2)
    while True:
        time.sleep(0.1)
except KeyboardInterrupt:
    print(f"INTERRUPT_AFTER_MS={int((time.monotonic() - started) * 1000)}", flush=True)
    print("^C again to exit", flush=True)
finally:
    if pair:
        for stream in pair:
            stream.close()

assert input().strip() == "PTY_FOLLOW_UP_4529"
print("PTY_NATIVE_COMPLETED_5368", flush=True)
assert input().strip() == "/exit"
