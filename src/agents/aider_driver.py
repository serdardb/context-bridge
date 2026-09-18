"""Interactive Aider SDK transport for bridge-owned sessions (candidate)."""
import argparse
import copy
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import stat
import socket
import sys
import threading
import time
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone


def watch_parent():
    config = json.loads(os.environ.pop("CONTEXT_BRIDGE_AIDER_PARENT", "null"))
    if (not isinstance(config, dict) or type(config.get("port")) is not int
            or not 0 < config["port"] < 65536 or not isinstance(config.get("token"), str)
            or len(config["token"]) != 64
            or any(char not in "0123456789abcdef" for char in config["token"])):
        raise RuntimeError("Missing Aider parent connection.")
    connection = socket.create_connection(("127.0.0.1", config["port"]), timeout=5)
    connection.set_inheritable(False)
    try:
        connection.sendall((config["token"] + "\n").encode("ascii"))
        reply = b""
        while len(reply) < 6:
            part = connection.recv(6 - len(reply))
            if not part:
                raise RuntimeError("Aider parent exited before startup.")
            reply += part
        if reply != b"ready\n":
            raise RuntimeError("Invalid Aider parent handshake.")
        connection.settimeout(None)
    except BaseException:
        connection.close()
        raise

    def monitor():
        try:
            connection.recv(1)
        finally:
            # No more agent work without its entry process. Abrupt exit releases
            # the OS lock; an interrupted append remains explicitly incomplete.
            os._exit(125)

    threading.Thread(target=monitor, name="bridge-parent", daemon=True).start()


def read_regular(file):
    before = os.lstat(file)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise RuntimeError("Unsafe Aider session file.")
    fd = os.open(file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                 | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
    try:
        opened = os.fstat(fd)
        if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)):
            raise RuntimeError("Aider session file changed while opening.")
        with os.fdopen(fd, "rb", closefd=False) as source:
            content = source.read()
        after = os.fstat(fd)
        if (not stat.S_ISREG(after.st_mode) or after.st_nlink != 1
                or (after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                != (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
                or len(content) != opened.st_size):
            raise RuntimeError("Aider session file changed while reading.")
        content.decode("utf-8")
        return content
    finally:
        os.close(fd)


class Evidence:
    def __init__(self, directory, session_id, project_id):
        self.file = directory / "events.jsonl"
        self.history = directory / "chat.md"
        self.previous = read_regular(self.file)
        if not self.previous.endswith(b"\n"):
            raise RuntimeError("Incomplete Aider evidence; repair must be explicit.")
        rows = [json.loads(line) for line in self.previous.splitlines()]
        if rows[0] != {"type": "session", "version": 1, "sessionId": session_id, "projectId": project_id}:
            raise RuntimeError("Aider evidence identity mismatch.")
        history = read_regular(self.history)
        previous_size = 0
        for sequence, row in enumerate(rows[1:], 1):
            mark = row.get("history", {})
            size = mark.get("bytes")
            if (row.get("type") != "turn" or row.get("sequence") != sequence
                    or type(row.get("completed")) is not bool or type(row.get("failed")) is not bool
                    or type(row.get("responses")) is not int or row["responses"] < 0
                    or row["completed"] != (row["responses"] > 0 and not row["failed"])
                    or not isinstance(row.get("messages"), list)
                    or any(not isinstance(message, dict) or message.get("role") not in ("user", "assistant")
                           or not isinstance(message.get("text"), str) for message in row["messages"])
                    or row["responses"] > sum(message["role"] == "assistant" and bool(message["text"])
                                              for message in row["messages"])
                    or mark.get("version") != 1 or type(size) is not int
                    or size < previous_size or size > len(history)
                    or hashlib.sha256(history[:size]).hexdigest() != mark.get("sha256")):
                raise RuntimeError("Aider evidence no longer matches native history.")
            previous_size = size
        self.sequence = len(rows) - 1
        self.history_prefix = history

    def append(self, responses, failed, messages):
        before = os.lstat(self.file)
        if read_regular(self.file) != self.previous:
            raise RuntimeError("Aider evidence changed outside the session writer.")
        history = read_regular(self.history)
        if not history.startswith(self.history_prefix):
            raise RuntimeError("Aider native history was rewritten during the session.")
        record = {"type": "turn", "sequence": self.sequence + 1,
                  "at": datetime.now(timezone.utc).isoformat(), "responses": responses,
                  "failed": failed, "completed": responses > 0 and not failed,
                  "messages": messages,
                  "history": {"version": 1, "bytes": len(history),
                              "sha256": hashlib.sha256(history).hexdigest()}}
        data = (json.dumps(record) + "\n").encode("utf-8")
        # Evidence prefixes and history hashes describe bytes, not CRT text lines.
        fd = os.open(self.file, os.O_WRONLY | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0)
                     | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
        try:
            opened = os.fstat(fd)
            if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                    or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
                    or opened.st_size != len(self.previous)):
                raise RuntimeError("Aider evidence changed before append.")
            offset = 0
            while offset < len(data):
                written = os.write(fd, data[offset:])
                if written <= 0:
                    raise RuntimeError("Could not persist Aider completion evidence.")
                offset += written
            os.fsync(fd)
        finally:
            os.close(fd)
        self.previous += data
        self.sequence += 1
        self.history_prefix = history


@contextmanager
def interruptible_http_reads():
    """Yield to Python signals without reducing HTTPcore's read deadline."""
    import httpcore
    from httpcore._backends.sync import SyncStream, TLSinTLSStream

    if importlib.metadata.version("httpcore") != "1.0.9":
        raise RuntimeError("Windows Aider interrupt support requires httpcore 1.0.9.")
    original = SyncStream.read
    original_tls = TLSinTLSStream.read
    owner = threading.get_ident()

    def poll(operation, sock, timeout, timeout_error):
        deadline = None if timeout is None else time.monotonic() + timeout
        try:
            while True:
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    raise timeout_error("The read operation timed out")
                try:
                    return operation(0.2 if remaining is None else min(0.2, remaining))
                except timeout_error:
                    if deadline is not None and time.monotonic() >= deadline:
                        raise
        finally:
            if sock.fileno() >= 0:
                sock.settimeout(timeout)

    def read(stream, max_bytes, timeout=None):
        if threading.get_ident() != owner or (timeout is not None and timeout <= 0):
            return original(stream, max_bytes, timeout)
        return poll(lambda wait: original(stream, max_bytes, wait),
                    stream.get_extra_info("socket"), timeout, httpcore.ReadTimeout)

    def read_tls(stream, max_bytes, timeout=None):
        if threading.get_ident() != owner or (timeout is not None and timeout <= 0):
            return original_tls(stream, max_bytes, timeout)
        sock = stream.get_extra_info("socket")
        receive = sock.recv
        had_override = "recv" in sock.__dict__
        previous = sock.__dict__.get("recv")

        def recv(*args, **kwargs):
            if threading.get_ident() != owner:
                return receive(*args, **kwargs)

            def operation(wait):
                sock.settimeout(wait)
                return receive(*args, **kwargs)

            return poll(operation, sock, sock.gettimeout(), socket.timeout)

        # Retry only the owned socket's recv, never the TLS BIO drain/sendall.
        sock.recv = recv
        try:
            return original_tls(stream, max_bytes, timeout)
        finally:
            if had_override:
                sock.recv = previous
            else:
                del sock.recv

    # Keep HTTPX/LiteLLM's existing clients, proxy selection and TLS contexts.
    SyncStream.read = read
    TLSinTLSStream.read = read_tls
    try:
        yield
    finally:
        SyncStream.read = original
        TLSinTLSStream.read = original_tls


def observe(coder, evidence):
    send, run_one = coder.send, coder.run_one
    state = None

    def observed_send(*args, **kwargs):
        nonlocal state
        if state is not None and not state["messages"]:
            state["messages"].append({"role": "user", "text": input_text})
        try:
            with interruptible_http_reads() if os.name == "nt" else nullcontext():
                yield from send(*args, **kwargs)
        except BaseException:
            if state is not None:
                state["failed"] = True
            raise
        else:
            if state is not None and coder.partial_response_content:
                state["responses"] += 1
        finally:
            if state is not None and coder.partial_response_content:
                state["messages"].append({"role": "assistant", "text": coder.partial_response_content})

    def observed_turn(*args, **kwargs):
        nonlocal state, input_text
        input_text = args[0] if args else kwargs["user_message"]
        state = {"responses": 0, "failed": False, "messages": []}
        try:
            return run_one(*args, **kwargs)
        except BaseException:
            state["failed"] = True
            raise
        finally:
            evidence.append(**state)
            state = None

    input_text = ""
    coder.send, coder.run_one = observed_send, observed_turn


def install_protocol(coder):
    # Native prompt objects are shared by coder classes. Do not change other
    # coders, and escape braces because Aider formats this template later.
    skill = Path(__file__).resolve().parents[2] / "codex" / "SKILL.md"
    protocol = (
        "\n\nContext Bridge handoff protocol (conditional):\n"
        "Apply ONLY when the user requests a context-bridge handoff. "
        "Receiving context is not a request to hand off. Otherwise continue the work. "
        "Use Aider's native shell-command proposal and confirmation flow; never "
        "bypass user confirmation or change approval settings. In a mode that "
        "cannot execute shell proposals, explain that limitation rather than "
        "claiming a handoff succeeded. This protocol does not change coding mode.\n\n"
        + skill.read_text(encoding="utf-8")
    )
    coder.gpt_prompts = copy.copy(coder.gpt_prompts)
    coder.gpt_prompts.main_system += protocol.replace("{", "{{").replace("}", "}}")


def create_interactive_coder(native):
    from aider import main as sdk
    get_parser, input_output = sdk.get_parser, sdk.InputOutput
    requested = {}

    def parser_for(*args, **kwargs):
        parser = get_parser(*args, **kwargs)
        parse = parser.parse_args

        def capture(*args, **kwargs):
            result = parse(*args, **kwargs)
            requested["yes"] = result.yes_always
            requested["parsed"] = result
            return result

        parser.parse_args = capture
        return parser

    def interactive_io(pretty, yes, *args, **kwargs):
        # SDK 0.86.2 silently changes unspecified approvals to yes in
        # return_coder mode. Preserve the native parser's final CLI/config/env
        # choice instead, including None (interactive confirmation).
        if "yes" not in requested:
            raise RuntimeError("Aider approval settings were not observed.")
        requested["parsed"].yes_always = requested["yes"]
        return input_output(pretty, requested["yes"], *args, **kwargs)

    sdk.get_parser, sdk.InputOutput = parser_for, interactive_io
    try:
        return sdk.main(native, return_coder=True)
    finally:
        sdk.get_parser, sdk.InputOutput = get_parser, input_output


def run(args):
    watch_parent()
    directory = Path(args.session_dir)
    if not directory.is_absolute() or directory.is_symlink() or not directory.is_dir():
        raise RuntimeError("Invalid Aider session directory.")
    spec = importlib.util.spec_from_file_location("bridge_aider_lock", Path(__file__).with_name("aider_lock.py"))
    locks = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(locks)
    with locks.session_lock(str(directory / "session.lock")):
        reservation = json.loads(read_regular(Path(args.reservation)))
        if (reservation.get("version") != 1 or reservation.get("operation") != "aider"
                or reservation.get("project") != args.project_id
                or reservation.get("sessionId") != args.session_id):
            raise RuntimeError("Aider project operation reservation is no longer valid.")
        meta = json.loads(read_regular(directory / "session.json"))
        if (meta.get("version") != 1 or meta.get("id") != args.session_id
                or meta.get("projectId") != args.project_id or directory.name != args.session_id
                or meta.get("sdkVersion") != "0.86.2"
                or importlib.metadata.version("aider-chat") != "0.86.2"
                or sys.flags.isolated != 1
                or not ((3, 10) <= sys.version_info[:2] < (3, 13))):
            raise RuntimeError("Aider session or runtime version mismatch.")
        evidence = Evidence(directory, args.session_id, args.project_id)
        read_regular(directory / "input.txt")
        native = json.loads(args.native_args)
        if not isinstance(native, list) or not all(isinstance(value, str) and "\0" not in value for value in native):
            raise RuntimeError("Invalid Aider arguments.")
        # Controlled paths and write policy follow user options/config so native
        # argument precedence cannot redirect a bridge-owned session elsewhere.
        controlled = ["--chat-history-file", str(evidence.history), "--input-history-file", str(directory / "input.txt"),
                   "--restore-chat-history", "--no-git", "--no-auto-commits", "--no-dirty-commits",
                   "--no-gitignore", "--no-analytics", "--no-check-update", "--no-show-release-notes"]
        delimiter = native.index("--") if "--" in native else len(native)
        native = native[:delimiter] + controlled + native[delimiter:]
        from aider.coders import Coder
        from aider.commands import SwitchCoder
        coder = create_interactive_coder(native)
        if not isinstance(coder, Coder):
            raise RuntimeError("Aider did not open an interactive session.")
        observe(coder, evidence)
        install_protocol(coder)
        if args.prompt is not None:
            coder.run(with_message=args.prompt, preproc=False)
        if args.once:
            return
        while True:
            try:
                coder.run()
                return
            except SwitchCoder as switch:
                if getattr(switch, "placeholder", None) is not None:
                    coder.io.placeholder = switch.placeholder
                options = dict(io=coder.io, from_coder=coder)
                options.update(switch.kwargs)
                options.pop("show_announcements", None)
                coder = Coder.create(**options)
                observe(coder, evidence)
                install_protocol(coder)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--session-dir", required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--reservation", required=True)
    parser.add_argument("--native-args", default="[]")
    parser.add_argument("--prompt")
    parser.add_argument("--once", action="store_true")
    run(parser.parse_args())
