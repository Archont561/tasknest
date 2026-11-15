"""Tasknest Python runner package."""

from __future__ import annotations

from tasknest._version import VERSION, __version__
from tasknest.adapters import (
    ActionlintAdapter,
    AffectedTestPlan,
    BunAdapter,
    PytestAdapter,
    RuffAdapter,
    ToolAdapter,
    find_executable,
    require_executable,
    select_pytest_targets,
)
from tasknest.config import ChecksConfig, DiscoveryRoot, SkillConfig, TasknestConfig, load_config
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
from tasknest.graph import ExecutionReport, plan_execution, run_order, run_plan, validate_graph
from tasknest.skill import check_skill, render_skill, write_skill
from tasknest.task import TaskDefinition, TaskOption, tool
from tasknest.testing import CliResult, CliRunner
from tasknest.validation import (
    ValidationResult,
    format_effect_summary,
    select_tasks_by_marks,
    validate_registry,
)

__all__ = [
    "VERSION",
    "ActionlintAdapter",
    "AffectedTestPlan",
    "BunAdapter",
    "ChecksConfig",
    "CliResult",
    "CliRunner",
    "CliUsageError",
    "CommandResult",
    "ConfigError",
    "DiscoveryError",
    "DiscoveryRoot",
    "ExecutionReport",
    "GraphError",
    "PytestAdapter",
    "RuffAdapter",
    "SkillConfig",
    "TaskDefinition",
    "TaskOption",
    "TaskRegistry",
    "TasknestConfig",
    "TasknestError",
    "ToolAdapter",
    "ToolContext",
    "ToolError",
    "ValidationError",
    "ValidationResult",
    "__version__",
    "check_skill",
    "discover_tasks",
    "find_executable",
    "format_effect_summary",
    "load_config",
    "plan_execution",
    "render_skill",
    "require_executable",
    "run_order",
    "run_plan",
    "select_pytest_targets",
    "select_tasks_by_marks",
    "tool",
    "validate_graph",
    "validate_registry",
    "write_skill",
]
