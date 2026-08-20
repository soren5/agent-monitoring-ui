#!/usr/bin/env python3
"""Read only the Codex CLI's `/status` display through a private PTY."""
import json
import os
import pty
import re
import select
import signal
import fcntl
import struct
import subprocess
import sys
import termios
import time

CODEX_BIN = os.path.expanduser("~/.local/bin/codex")
START_TIMEOUT_SECONDS = 35
STATUS_TIMEOUT_SECONDS = 35
ANSI_ESCAPE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\a]*(?:\a|\x1b\\)|[()][0-9A-Z]|[=>])")


def emit(body, status=0):
    print(json.dumps(body, sort_keys=True), flush=True)
    sys.exit(status)


def cleaned(value):
    return ANSI_ESCAPE.sub("", value).replace("\r", "\n")


def status_snapshot(transcript):
    text = cleaned(transcript)
    weekly = re.search(r"Weekly limit:\s*\[[^\]]*\]\s*(\d+)%\s+left\s*\(resets\s+([^)]*)\)", text, re.S)
    if not weekly:
        return None
    result = {
        "ok": True,
        "source": "Codex CLI /status",
        "weekly_limit_percent_left": int(weekly.group(1)),
        "weekly_limit_reset": weekly.group(2).strip(),
    }
    context = re.search(r"Context window:\s*(\d+)%\s+left\s*\(([^)]*)\)", text, re.S)
    if context:
        result["context_window_percent_left"] = int(context.group(1))
        result["context_window_detail"] = context.group(2).strip()
    return result


def main():
    if not os.path.isfile(CODEX_BIN) or not os.access(CODEX_BIN, os.X_OK):
        emit({"ok": False, "error": "Configured Codex CLI is unavailable"}, 2)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
    env = {"HOME": os.path.expanduser("~"), "PATH": os.environ.get("PATH", ""), "TERM": "xterm-256color"}
    process = subprocess.Popen([CODEX_BIN], stdin=slave, stdout=slave, stderr=slave, env=env, preexec_fn=os.setsid, close_fds=True)
    os.close(slave)
    transcript = ""
    debug = os.environ.get("NANOCLAW_STATUS_READER_DEBUG") == "1"
    started = time.monotonic()
    sent_status = False
    sent_refresh = False
    status_sent_at = 0
    try:
        while time.monotonic() - started < START_TIMEOUT_SECONDS + STATUS_TIMEOUT_SECONDS:
            readable, _, _ = select.select([master], [], [], 0.25)
            if readable:
                try:
                    chunk = os.read(master, 65536).decode("utf-8", errors="replace")
                except OSError:
                    break
                transcript = (transcript + chunk)[-500_000:]
            visible = cleaned(transcript)
            now = time.monotonic()
            # `directory:` renders before Codex has finished loading MCP
            # servers. Submitting /status at that point queues it behind
            # startup and produces only the intermediate refresh message.
            # Wait for the non-loading model line that marks an interactive,
            # ready prompt; the timeout remains fail-closed for broken starts.
            cli_ready = re.search(r"model:\s+(?!loading\b)\S", visible, re.I) is not None
            if not sent_status and (cli_ready or now - started >= START_TIMEOUT_SECONDS):
                os.write(master, b"/status\r")
                sent_status = True
                started = now
                status_sent_at = now
            # Codex first asks its backend to refresh limits, then requires a
            # second /status after the refresh completes.
            if sent_status and not sent_refresh and "refresh requested; run /status again shortly" in visible.lower() and now - status_sent_at >= 5:
                os.write(master, b"/status\r")
                sent_refresh = True
                status_sent_at = now
            snapshot = status_snapshot(transcript)
            if sent_status and snapshot:
                emit(snapshot)
            if sent_status and now - status_sent_at >= STATUS_TIMEOUT_SECONDS:
                error = {"ok": False, "error": "Codex CLI /status did not expose a weekly-limit value"}
                if debug:
                    error["debug_tail"] = cleaned(transcript)[-12000:]
                emit(error, 3)
            if process.poll() is not None:
                break
        emit({"ok": False, "error": "Codex CLI exited before producing /status"}, 4)
    finally:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        process.wait(timeout=3)
        os.close(master)


if __name__ == "__main__":
    main()
