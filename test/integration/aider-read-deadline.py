"""Real TLS/BIO acceptance for the pinned Aider read integration."""
import importlib.util
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import httpcore
from httpcore._backends.sync import SyncStream, TLSinTLSStream

spec = importlib.util.spec_from_file_location(
    "bridge_aider_driver", Path(__file__).resolve().parents[2] / "src/agents/aider_driver.py")
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
interrupt = "--interrupt" in sys.argv

with tempfile.TemporaryDirectory(prefix="bridge-read-tls-") as directory:
    root = Path(directory)
    config = root / "openssl.cnf"
    config.write_text("[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n"
                      "[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost\n"
                      "basicConstraints=critical,CA:TRUE\n")
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                    "-days", "1", "-config", str(config), "-keyout", str(root / "key.pem"),
                    "-out", str(root / "cert.pem")], check=True, timeout=30,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(root / "cert.pem", root / "key.pem")
    client_context = ssl.create_default_context(cafile=str(root / "cert.pem"))
    original_read, original_tls = SyncStream.read, TLSinTLSStream.read

    for nested in ([True] if interrupt else [False, True]):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(10)
        stop = threading.Event()
        errors = []
        payload = b"TLS_BYTES_SURVIVE_POLLING_8471" * 1024

        def serve():
            try:
                conn, _ = listener.accept()
                conn.settimeout(10)
                with server_context.wrap_socket(conn, server_side=True) as outer:
                    if nested:
                        incoming, outgoing = ssl.MemoryBIO(), ssl.MemoryBIO()
                        inner = server_context.wrap_bio(incoming, outgoing, server_side=True)

                        def transfer(operation):
                            while True:
                                needs_read = False
                                try:
                                    result = operation()
                                except ssl.SSLWantReadError:
                                    needs_read = True
                                pending = outgoing.read()
                                if pending:
                                    outer.sendall(pending)
                                if not needs_read:
                                    return result
                                chunk = outer.recv(16384)
                                if not chunk:
                                    raise RuntimeError("unexpected TLS peer EOF")
                                incoming.write(chunk)

                        transfer(inner.do_handshake)
                        assert transfer(lambda: inner.read(1)) == b"x"
                    else:
                        assert outer.recv(1) == b"x"
                    if not interrupt:
                        time.sleep(0.45)
                        if nested:
                            assert transfer(lambda: inner.write(payload)) == len(payload)
                        else:
                            outer.sendall(payload)
                    stop.wait(10)
            except BaseException as error:
                errors.append(error)

        worker = threading.Thread(target=serve, daemon=True)
        worker.start()
        stream = SyncStream(socket.create_connection(listener.getsockname(), timeout=5))
        try:
            stream = stream.start_tls(client_context, "localhost", timeout=5)
            if nested:
                stream = stream.start_tls(client_context, "localhost", timeout=5)
            sock = stream.get_extra_info("socket")
            original_recv = sock.recv
            stream.write(b"x", timeout=5)
            with driver.interruptible_http_reads():
                if interrupt:
                    print("INTERRUPTED_STREAM_8741", flush=True)
                    try:
                        stream.read(1, timeout=600)
                        raise AssertionError("stalled stream returned without interruption")
                    except KeyboardInterrupt:
                        print("^C again to exit", flush=True)
                else:
                    received = b""
                    while len(received) < len(payload):
                        part = stream.read(65536, timeout=2)
                        assert part, "TLS payload ended early"
                        received += part
                    assert received == payload
                    assert sock.gettimeout() == 2
                    started = time.monotonic()
                    try:
                        stream.read(1, timeout=0.35)
                        raise AssertionError("caller deadline ignored")
                    except httpcore.ReadTimeout:
                        assert 0.30 <= time.monotonic() - started < 2
                    assert sock.gettimeout() == 0.35
            assert sock.recv == original_recv
            assert SyncStream.read is original_read and TLSinTLSStream.read is original_tls
        finally:
            stop.set()
            stream.close()
            listener.close()
            worker.join(timeout=12)
        assert not worker.is_alive() and not errors, errors

if interrupt:
    assert input().strip() == "PTY_FOLLOW_UP_4529"
    print("PTY_NATIVE_COMPLETED_5368", flush=True)
    assert input().strip() == "/exit"
else:
    print("Verified TLS and TLS-in-TLS bytes, read deadlines and restoration")
