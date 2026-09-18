import signal
import socket
import sys
import threading
import time

mode = sys.argv[1]
pair = socket.socketpair() if mode in ("socket", "wakeup", "console") else None
wakeup_pair = None
monitor = None
previous_wakeup = None
console_handler = None
console_finished = threading.Event()
if mode == "console":
    import _thread
    import ctypes
    from ctypes import wintypes

    handler_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.DWORD)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    set_handler = kernel.SetConsoleCtrlHandler
    set_handler.argtypes = (handler_type, wintypes.BOOL)
    set_handler.restype = wintypes.BOOL

    @handler_type
    def console_handler(event):
        if event != 0:  # Leave CTRL_BREAK, close and logoff to existing handlers.
            return False
        try:
            _thread.interrupt_main()
            pair[0].shutdown(socket.SHUT_RDWR)
        finally:
            console_finished.set()
        return True

    if not set_handler(console_handler, True):
        raise ctypes.WinError(ctypes.get_last_error())
elif mode == "wakeup":
    wakeup_pair = socket.socketpair()
    wakeup_pair[1].setblocking(False)
    previous_wakeup = signal.set_wakeup_fd(wakeup_pair[1].fileno())

    def interrupt_read():
        while True:
            signals = wakeup_pair[0].recv(128)
            if not signals or b"\x00" in signals:
                return
            if signal.SIGINT in signals:
                # Only this probe's blocked stream, never another connection.
                pair[0].shutdown(socket.SHUT_RDWR)
                return

    monitor = threading.Thread(target=interrupt_read, daemon=True)
    monitor.start()
elif pair:
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
    if console_handler:
        assert set_handler(console_handler, False), "could not remove console handler"
        assert console_finished.wait(2), "console callback did not finish"
    if wakeup_pair:
        signal.set_wakeup_fd(previous_wakeup)
        wakeup_pair[1].send(b"\x00")
        monitor.join(timeout=2)
        assert not monitor.is_alive(), "signal monitor did not stop"
        for stream in wakeup_pair:
            stream.close()
    if pair:
        for stream in pair:
            stream.close()

assert input().strip() == "PTY_FOLLOW_UP_4529"
print("PTY_NATIVE_COMPLETED_5368", flush=True)
assert input().strip() == "/exit"
