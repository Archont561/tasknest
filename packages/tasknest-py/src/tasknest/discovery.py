"""File-based task discovery from configured roots."""

from __future__ import annotations

import importlib.util
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from tasknest.config import DiscoveryRoot, TasknestConfig, load_config
from tasknest.errors import DiscoveryError
from tasknest.task import TaskDefinition

if TYPE_CHECKING:
    from pathlib import Path

_RESERVED_DIRS = frozenset({"tests", "features"})
_DOT = "."


@dataclass
class TaskRegistry:
    """Discovered tasks indexed by canonical dotted name and CLI path."""

    config: TasknestConfig
    tasks: dict[str, TaskDefinition]
    _by_cli: dict[tuple[str, ...], TaskDefinition] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._by_cli = {task.cli_path: task for task in self.tasks.values()}

    def resolve_path(self, tokens: tuple[str, ...] | list[str]) -> tuple[TaskDefinition, list[str]]:
        """Match the longest task-path prefix or a single canonical dotted token."""
        if not tokens:
            raise DiscoveryError("Missing task path.")
        if len(tokens) == 1 and tokens[0] in self.tasks:
            return self.tasks[tokens[0]], []
        for end in range(len(tokens), 0, -1):
            candidate = tuple(tokens[:end])
            if candidate in self._by_cli:
                return self._by_cli[candidate], list(tokens[end:])
        if _DOT in tokens[0] and tokens[0] in self.tasks:
            return self.tasks[tokens[0]], list(tokens[1:])
        raise DiscoveryError(f"Unknown task: {' '.join(tokens)}")

    def ordered_tasks(self) -> list[TaskDefinition]:
        """Return tasks sorted by canonical dotted name."""
        return [self.tasks[name] for name in sorted(self.tasks)]


def _iter_task_files(root_dir: Path) -> list[Path]:
    found: list[Path] = []
    for path in sorted(root_dir.rglob("*.py")):
        rel_parts = path.relative_to(root_dir).parts
        if rel_parts[0] in _RESERVED_DIRS:
            continue
        if any(part.startswith("_") for part in rel_parts):
            continue
        found.append(path)
    return found


def _load_file_task(
    file_path: Path, canonical: str, cli_path: tuple[str, ...], proj_root: Path
) -> TaskDefinition:
    module_name = f"_tasknest_discovered_{canonical.replace(_DOT, '_')}_{abs(hash(file_path))}"
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec is None or spec.loader is None:
        raise DiscoveryError(f"Cannot load task module: {file_path}")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        raise DiscoveryError(f"Failed importing task file {file_path}: {exc}") from exc
    tasks = [val for val in vars(module).values() if isinstance(val, TaskDefinition)]
    if len(tasks) != 1:
        raise DiscoveryError(
            f"Task file {file_path} must register exactly one @tool task (found {len(tasks)})."
        )
    task = tasks[0]
    task.name = canonical
    task.cli_path = cli_path
    task.source_path = file_path
    task.project_root = proj_root
    return task


def _discover_root(
    config: TasknestConfig, entry: DiscoveryRoot, tasks: dict[str, TaskDefinition]
) -> None:
    root_dir = config.repo_root / entry.path
    if not root_dir.is_dir():
        raise DiscoveryError(f"Configured discovery root does not exist: {root_dir}")
    proj_root = (config.repo_root / entry.project_root).resolve()
    ns_parts = tuple(p for p in entry.namespace.split(_DOT) if p)
    for file_path in _iter_task_files(root_dir):
        rel = file_path.relative_to(root_dir).with_suffix("")
        parts = ns_parts + rel.parts
        canonical = _DOT.join(parts)
        if canonical in tasks:
            raise DiscoveryError(f"Duplicate task name {canonical!r} found at {file_path}.")
        loaded = _load_file_task(file_path, canonical, parts, proj_root)
        loaded.root_dir = root_dir
        tasks[canonical] = loaded


def discover_tasks(repo_root: Path, config_path: Path | None = None) -> TaskRegistry:
    """Load configuration and discover all tasks from configured roots."""
    config = load_config(repo_root, config_path=config_path)
    tasks: dict[str, TaskDefinition] = {}
    for entry in config.roots:
        _discover_root(config, entry, tasks)
    return TaskRegistry(config=config, tasks=tasks)
