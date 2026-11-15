"""Tests for tasknest.errors exception hierarchy and exit codes."""

from __future__ import annotations

from tasknest.errors import (
    CliUsageError,
    ConfigError,
    DiscoveryError,
    GraphError,
    TasknestError,
    ToolError,
    ValidationError,
)


def test_non_tool_errors_default_to_exit_code_2() -> None:
    for err_cls in (ConfigError, DiscoveryError, ValidationError, GraphError, CliUsageError):
        err = err_cls("bad input")
        assert isinstance(err, TasknestError)
        assert err.exit_code == 2
        assert str(err) == "bad input"


def test_tool_error_defaults_to_exit_code_1_and_accepts_override() -> None:
    default_err = ToolError("task failed")
    assert isinstance(default_err, TasknestError)
    assert default_err.exit_code == 1

    custom_err = ToolError("custom fail", exit_code=42)
    assert custom_err.exit_code == 42
