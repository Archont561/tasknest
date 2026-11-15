"""Streaming and cancellable subprocess execution helpers."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from threading import Event, Lock, Thread
from typing import IO, TYPE_CHECKING, Any

from tasknest.errors import ToolError, ValidationError

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

_POLL_INTERVAL_SEC = 0.02
_KILL_GRACE_SEC = 1.5
_CANCEL_EXIT_CODE = 130
_WRITE_LOCK = Lock()


@dataclass(frozen=True)
class ProcessSpec:
    """Subprocess invocation parameters."""

    args: tuple[str, ...]
    workdir: Path
    env: dict[str, str]
    timeout: float | None = None
    check: bool = True
    capture: bool = False
    cancel_event: Event | None = None
    line_prefix: str | None = None
    quiet_stdout: bool = False


def terminate_process_tree(proc: subprocess.Popen[str]) -> None:
    """Terminate a child process and its POSIX process group gracefully."""
    if proc.poll() is not None:
        return
    try:
        if os.name != "nt":
            os.killpg(proc.pid, signal.SIGTERM)
        else:
            proc.terminate()
    except OSError:
        pass
    try:
        proc.wait(timeout=_KILL_GRACE_SEC)
    except subprocess.TimeoutExpired:
        try:
            if os.name != "nt":
                os.killpg(proc.pid, signal.SIGKILL)
            else:
                proc.kill()
        except OSError:
            pass
        proc.wait()


def _emit_line(line: str, spec: ProcessSpec, *, is_stderr: bool) -> None:
    target = sys.stderr if (is_stderr or spec.quiet_stdout) else sys.stdout
    out = f"{spec.line_prefix}{line}" if spec.line_prefix else line
    with _WRITE_LOCK:
        target.write(out)
        target.flush()


def _drain_stream(
    stream: IO[str] | None,
    sink: list[str],
    spec: ProcessSpec,
    *,
    is_stderr: bool,
) -> None:
    if stream is None:
        return
    try:
        for line in stream:
            if spec.capture:
                sink.append(line)
            else:
                _emit_line(line, spec, is_stderr=is_stderr)
    finally:
        stream.close()


def _wait_with_cancellation(proc: subprocess.Popen[str], spec: ProcessSpec) -> None:
    deadline = (time.monotonic() + spec.timeout) if spec.timeout is not None else None
    while proc.poll() is None:
        if spec.cancel_event is not None and spec.cancel_event.is_set():
            terminate_process_tree(proc)
            raise ToolError(
                f"Command cancelled: {' '.join(spec.args)}",
                exit_code=_CANCEL_EXIT_CODE,
            )
        if deadline is not None and time.monotonic() >= deadline:
            terminate_process_tree(proc)
            raise ToolError(f"Command timed out after {spec.timeout}s: {' '.join(spec.args)}")
        time.sleep(_POLL_INTERVAL_SEC)


def run_streaming_process(spec: ProcessSpec) -> tuple[int, str, str]:
    """Execute a subprocess with optional line-prefix streaming and cancellation."""
    if spec.cancel_event is not None and spec.cancel_event.is_set():
        raise ToolError(
            f"Command cancelled: {' '.join(spec.args)}",
            exit_code=_CANCEL_EXIT_CODE,
        )
    try:
        proc = subprocess.Popen(  # noqa: S603 - explicit argv list with shell=False
            spec.args,
            cwd=spec.workdir,
            env=spec.env,
            shell=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=1,
            start_new_session=(os.name != "nt"),
        )
    except OSError as exc:
        raise ToolError(f"Failed to execute command {spec.args[0]!r}: {exc}") from exc

    out_chunks: list[str] = []
    err_chunks: list[str] = []
    t_out = Thread(
        target=_drain_stream,
        args=(proc.stdout, out_chunks, spec),
        kwargs={"is_stderr": False},
    )
    t_err = Thread(
        target=_drain_stream,
        args=(proc.stderr, err_chunks, spec),
        kwargs={"is_stderr": True},
    )
    t_out.start()
    t_err.start()
    try:
        _wait_with_cancellation(proc, spec)
    finally:
        t_out.join(timeout=_KILL_GRACE_SEC)
        t_err.join(timeout=_KILL_GRACE_SEC)
    return proc.returncode or 0, "".join(out_chunks), "".join(err_chunks)


def resolve_persistent_workers(
    requested_jobs: int | None,
    base_workers: int,
    persistent_count: int,
) -> int:
    """Resolve effective worker count when persistent tasks are present."""
    if persistent_count <= 0:
        return base_workers
    if requested_jobs is not None and requested_jobs < persistent_count:
        raise ValidationError(
            f"Cannot run {persistent_count} persistent tasks concurrently "
            f"with --jobs {requested_jobs}; increase --jobs to at least {persistent_count}."
        )
    env_cap = os.environ.get("TASKNEST_WORKER_BUDGET")
    if env_cap and env_cap.isdigit() and int(env_cap) < persistent_count:
        raise ValidationError(
            f"Cannot run {persistent_count} persistent tasks concurrently "
            f"with TASKNEST_WORKER_BUDGET={env_cap}."
        )
    return max(base_workers, persistent_count)


@contextmanager
def install_interrupt_handlers(
    cancel_event: Event,
    enabled: bool,
) -> Iterator[list[int | None]]:
    """Temporarily capture SIGINT/SIGTERM in the main thread to trigger cancellation."""
    captured: list[int | None] = [None]
    if not enabled or threading.current_thread() is not threading.main_thread():
        yield captured
        return

    def _on_signal(signum: int, _frame: Any) -> None:
        if captured[0] is None:
            captured[0] = 128 + signum
        cancel_event.set()

    prev_int = signal.getsignal(signal.SIGINT)
    prev_term = signal.getsignal(signal.SIGTERM)
    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)
    try:
        yield captured
    finally:
        signal.signal(signal.SIGINT, prev_int)
        signal.signal(signal.SIGTERM, prev_term)
