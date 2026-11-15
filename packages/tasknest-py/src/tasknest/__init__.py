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
from tasknest.affected import (
    AffectedContext,
    ChangedFile,
    SelectionPolicy,
    build_python_reverse_map,
    collect_git_changes,
    parse_git_name_status,
    select_conservative_targets,
)
from tasknest.cache import CacheContext, CacheLookup, CacheMode, lookup_cache, store_cache
from tasknest.config import ChecksConfig, DiscoveryRoot, SkillConfig, TasknestConfig, load_config
from tasknest.context import CommandResult, DepsMapping, ToolContext
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
from tasknest.graph import (
    ExecutionReport,
    RunOptions,
    compute_worker_budget,
    plan_execution,
    run_order,
    run_plan,
    validate_graph,
)
from tasknest.report import (
    REPORT_SCHEMA_VERSION,
    ReportMetadata,
    TaskRunRecord,
    build_json_report,
    redact_argv,
    redact_text,
    serialize_json_report,
    write_json_report,
)
from tasknest.skill import check_skill, render_skill, write_skill
from tasknest.task import TaskDefinition, TaskOption, tool
from tasknest.testing import CliResult, CliRunner
from tasknest.validation import (
    ValidationResult,
    format_effect_summary,
    select_tasks_by_marks,
    validate_registry,
)
from tasknest.watch import WatchConfig, WatchCycle, WatchSession

__all__ = [
    "REPORT_SCHEMA_VERSION",
    "VERSION",
    "ActionlintAdapter",
    "AffectedContext",
    "AffectedTestPlan",
    "BunAdapter",
    "CacheContext",
    "CacheLookup",
    "CacheMode",
    "ChangedFile",
    "ChecksConfig",
    "CliResult",
    "CliRunner",
    "CliUsageError",
    "CommandResult",
    "ConfigError",
    "DepsMapping",
    "DiscoveryError",
    "DiscoveryRoot",
    "ExecutionReport",
    "GraphError",
    "PytestAdapter",
    "ReportMetadata",
    "RuffAdapter",
    "RunOptions",
    "SelectionPolicy",
    "SkillConfig",
    "TaskDefinition",
    "TaskOption",
    "TaskRegistry",
    "TaskRunRecord",
    "TasknestConfig",
    "TasknestError",
    "ToolAdapter",
    "ToolContext",
    "ToolError",
    "ValidationError",
    "ValidationResult",
    "WatchConfig",
    "WatchCycle",
    "WatchSession",
    "__version__",
    "build_json_report",
    "build_python_reverse_map",
    "check_skill",
    "collect_git_changes",
    "compute_worker_budget",
    "discover_tasks",
    "find_executable",
    "format_effect_summary",
    "load_config",
    "lookup_cache",
    "parse_git_name_status",
    "plan_execution",
    "redact_argv",
    "redact_text",
    "render_skill",
    "require_executable",
    "run_order",
    "run_plan",
    "select_conservative_targets",
    "select_pytest_targets",
    "select_tasks_by_marks",
    "serialize_json_report",
    "store_cache",
    "tool",
    "validate_graph",
    "validate_registry",
    "write_json_report",
    "write_skill",
]
