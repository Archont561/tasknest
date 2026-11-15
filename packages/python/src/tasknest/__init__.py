"""Tasknest Python runner package."""

from __future__ import annotations

from tasknest.config import DiscoveryRoot, TasknestConfig, load_config
from tasknest.context import CommandResult, ToolContext
from tasknest.discovery import TaskRegistry, discover_tasks
from tasknest.errors import (
    CliUsageError,
    ConfigError,
    DiscoveryError,
    GraphError,
    TasknestError,
    ToolError,
    ValidationError,
)
from tasknest.graph import ExecutionReport, plan_execution, run_plan, validate_graph
from tasknest.task import TaskDefinition, TaskOption, tool

__version__ = "0.1.0.dev0"

__all__ = [
    "CliUsageError",
    "CommandResult",
    "ConfigError",
    "DiscoveryError",
    "DiscoveryRoot",
    "ExecutionReport",
    "GraphError",
    "TaskDefinition",
    "TaskOption",
    "TaskRegistry",
    "TasknestConfig",
    "TasknestError",
    "ToolContext",
    "ToolError",
    "ValidationError",
    "__version__",
    "discover_tasks",
    "load_config",
    "plan_execution",
    "run_plan",
    "tool",
    "validate_graph",
]
