"""Tasknest error hierarchy."""

from __future__ import annotations


class TasknestError(Exception):
    """Base exception for Tasknest errors."""

    exit_code: int = 2

    def __init__(self, message: str, *, exit_code: int | None = None) -> None:
        super().__init__(message)
        if exit_code is not None:
            self.exit_code = exit_code


class ConfigError(TasknestError):
    """Configuration file missing or malformed."""


class DiscoveryError(TasknestError):
    """Task discovery or registration failed."""


class ValidationError(TasknestError):
    """Task definition, annotation, or structure validation failed."""


class GraphError(TasknestError):
    """Dependency reference or cycle error."""


class CliUsageError(TasknestError):
    """Invalid CLI subcommand, task path, or option."""


class ToolError(TasknestError):
    """Runtime failure raised inside a task or subprocess invocation."""

    exit_code: int = 1

    def __init__(self, message: str, *, exit_code: int = 1) -> None:
        super().__init__(message, exit_code=exit_code)
