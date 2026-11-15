"""Tests for tasknest.report versioned JSON output and secret redaction."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from tasknest.context import CommandResult
from tasknest.report import (
    REDACTED_PLACEHOLDER,
    REPORT_SCHEMA_VERSION,
    ReportMetadata,
    TaskRunRecord,
    build_json_report,
    redact_argv,
    redact_text,
    write_json_report,
)

if TYPE_CHECKING:
    from pathlib import Path


def test_redact_text_and_argv_mask_tokens_passwords_and_urls() -> None:
    cmd = [
        "curl",
        "https://alice:s3cr3t@example.com/api",
        "--token",
        "supersecret",
        "--api-key=ghp_1234567890abcdef",
    ]
    masked = redact_argv(cmd)
    assert masked[1] == f"https://{REDACTED_PLACEHOLDER}@example.com/api"
    assert masked[3] == REDACTED_PLACEHOLDER
    assert masked[4] == f"--api-key={REDACTED_PLACEHOLDER}"

    msg = "Authorization: Bearer my.secret.jwt password=hunter2 pypi-AgEIcHlwaS5vcmc123456"
    cleaned = redact_text(msg, extra_secrets=("hunter2",))
    assert "my.secret.jwt" not in cleaned
    assert "hunter2" not in cleaned
    assert "pypi-AgEIcHlwaS5vcmc123456" not in cleaned


def test_build_and_write_versioned_json_report(tmp_path: Path) -> None:
    rec_pass = TaskRunRecord(
        name="build",
        status="passed",
        cache_status="miss",
        duration_ms=12.5,
        commands=(
            CommandResult(
                argv=("tool", "--token", "secret-val"),
                returncode=0,
                stdout="",
                stderr="",
                cwd=tmp_path,
            ),
        ),
        output_hash="abc123",
    )
    rec_skip = TaskRunRecord(
        name="lint", status="skipped", cache_status="hit", cache_reason="cache hit"
    )
    rec_block = TaskRunRecord(name="deploy", status="blocked")

    meta = ReportMetadata(target="deploy", jobs=2, started_at="2026-11-15T18:00:00Z", exit_code=0)
    payload = build_json_report((rec_pass, rec_skip, rec_block), meta)
    assert payload["schema_version"] == REPORT_SCHEMA_VERSION
    assert payload["runner"] == "python"
    assert [t["status"] for t in payload["tasks"]] == ["passed", "skipped", "blocked"]
    assert payload["tasks"][0]["commands"][0]["argv"] == ["tool", "--token", REDACTED_PLACEHOLDER]

    out = write_json_report(tmp_path / "reports/run.json", (rec_pass, rec_skip), meta)
    loaded = json.loads(out.read_text(encoding="utf-8"))
    assert loaded["schema_version"] == REPORT_SCHEMA_VERSION
    assert len(loaded["tasks"]) == 2
