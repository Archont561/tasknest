"""Versioned machine-readable JSON reports and diagnostic redaction policy."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from tasknest._version import VERSION

if TYPE_CHECKING:
    from collections.abc import Sequence
    from pathlib import Path

    from tasknest.affected import AffectedContext, AffectedTestPlan
    from tasknest.cache import CacheStatus
    from tasknest.context import CommandResult

REPORT_SCHEMA_VERSION = 1
REDACTED_PLACEHOLDER = "***REDACTED***"

TaskStatus = Literal["passed", "failed", "skipped", "blocked", "cancelled"]

_SECRET_FLAG_NAMES = frozenset(
    {
        "token",
        "secret",
        "password",
        "passwd",
        "api-key",
        "api_key",
        "apikey",
        "auth",
        "authorization",
        "credential",
        "private-key",
        "private_key",
    }
)

_KV_SECRET_RE = re.compile(
    r"(?i)(\b(?:--)?[a-z0-9_-]*(?:token|secret|password|passwd|api[-_]?key|auth|credential|private[-_]?key)\s*[=:]\s*)([^\s\"']+)"
)
_BEARER_RE = re.compile(r"(?i)(Bearer\s+)([A-Za-z0-9._\-~+/]+=*)")
_URL_CRED_RE = re.compile(r"(https?://)([^:/\s]+:[^@/\s]+)(@)")
_KNOWN_TOKEN_RE = re.compile(r"\b(?:ghp|gho|github_pat|pypi|npm|sk)[_-][A-Za-z0-9_-]{8,}\b")


def redact_text(text: str, extra_secrets: Sequence[str] = ()) -> str:
    """Apply best-effort redaction to commands, errors, and diagnostics."""
    result = text
    for secret in extra_secrets:
        if secret:
            result = result.replace(secret, REDACTED_PLACEHOLDER)
    result = _URL_CRED_RE.sub(rf"\1{REDACTED_PLACEHOLDER}\3", result)
    result = _BEARER_RE.sub(rf"\1{REDACTED_PLACEHOLDER}", result)
    result = _KV_SECRET_RE.sub(rf"\1{REDACTED_PLACEHOLDER}", result)
    return _KNOWN_TOKEN_RE.sub(REDACTED_PLACEHOLDER, result)


def _is_secret_flag(token: str) -> bool:
    if not token.startswith("--") or "=" in token:
        return False
    name = token[2:].lower()
    return name in _SECRET_FLAG_NAMES or any(key in name for key in _SECRET_FLAG_NAMES)


def redact_argv(argv: Sequence[str], extra_secrets: Sequence[str] = ()) -> list[str]:
    """Redact sensitive flag arguments and inline secret patterns from argv."""
    redacted: list[str] = []
    mask_next = False
    for tok in argv:
        if mask_next:
            redacted.append(REDACTED_PLACEHOLDER)
            mask_next = False
            continue
        if _is_secret_flag(tok):
            redacted.append(tok)
            mask_next = True
            continue
        redacted.append(redact_text(tok, extra_secrets))
    return redacted


def _serialize_command(cmd: CommandResult, extra_secrets: Sequence[str]) -> dict[str, Any]:
    return {
        "argv": redact_argv(cmd.argv, extra_secrets),
        "returncode": cmd.returncode,
        "cwd": cmd.cwd.as_posix(),
    }


@dataclass(frozen=True)
class TaskRunRecord:
    """Per-task execution summary included in ExecutionReport and JSON output."""

    name: str
    status: TaskStatus
    cache_status: CacheStatus = "disabled"
    cache_reason: str | None = None
    duration_ms: float = 0.0
    commands: tuple[CommandResult, ...] = ()
    error: str | None = None
    output_hash: str | None = None
    selection_reason: str | None = None

    def to_dict(self, extra_secrets: Sequence[str] = ()) -> dict[str, Any]:
        """Serialize record into a redacted JSON-compatible dict."""
        return {
            "name": self.name,
            "status": self.status,
            "cache_status": self.cache_status,
            "cache_reason": self.cache_reason,
            "duration_ms": round(self.duration_ms, 3),
            "commands": [_serialize_command(c, extra_secrets) for c in self.commands],
            "error": redact_text(self.error, extra_secrets) if self.error else None,
            "output_hash": self.output_hash,
            "selection_reason": self.selection_reason,
        }


@dataclass(frozen=True)
class ReportMetadata:
    """Invocation-level context for a machine-readable JSON report."""

    target: str | None = None
    jobs: int = 1
    started_at: str = ""
    duration_ms: float = 0.0
    exit_code: int = 0
    affected: AffectedContext | None = None
    selection: AffectedTestPlan | None = None
    extra_secrets: tuple[str, ...] = field(default=())


def build_json_report(
    records: Sequence[TaskRunRecord],
    meta: ReportMetadata,
) -> dict[str, Any]:
    """Build a versioned, redacted JSON report payload."""
    payload: dict[str, Any] = {
        "schema_version": REPORT_SCHEMA_VERSION,
        "runner": "python",
        "runner_version": VERSION,
        "status": "passed" if meta.exit_code == 0 else "failed",
        "exit_code": meta.exit_code,
        "target": meta.target,
        "jobs": meta.jobs,
        "started_at": meta.started_at,
        "duration_ms": round(meta.duration_ms, 3),
        "tasks": [rec.to_dict(meta.extra_secrets) for rec in records],
    }
    if meta.affected is not None:
        payload["affected"] = meta.affected.to_dict()
    if meta.selection is not None:
        payload["selection"] = {
            "targets": list(meta.selection.targets),
            "fallback_reason": meta.selection.fallback_reason,
            "reasons": meta.selection.reasons,
        }
    return payload


def serialize_json_report(records: Sequence[TaskRunRecord], meta: ReportMetadata) -> str:
    """Render a deterministic JSON report string."""
    return json.dumps(build_json_report(records, meta), indent=2, sort_keys=False)


def write_json_report(
    path: Path,
    records: Sequence[TaskRunRecord],
    meta: ReportMetadata,
) -> Path:
    """Write a versioned JSON report to disk, creating parent directories."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(serialize_json_report(records, meta) + "\n", encoding="utf-8")
    return path
