"""Structural, mark, and effect validation for discovered Tasknest tasks."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from tasknest.errors import ValidationError
from tasknest.graph import _collect_order, validate_graph

if TYPE_CHECKING:
    from collections.abc import Sequence
    from pathlib import Path

    from tasknest.discovery import TaskRegistry
    from tasknest.task import TaskDefinition


@dataclass(frozen=True)
class ValidationResult:
    """Outcome of strict structural and mark validation."""

    warnings: tuple[str, ...] = ()


def _expected_test_candidates(task: TaskDefinition, root_dir: Path) -> tuple[Path, ...]:
    if task.source_path is None:
        return ()
    rel = task.source_path.relative_to(root_dir).with_suffix("")
    nested = root_dir / "tests" / rel.parent / f"test_{rel.name}.py"
    flat = root_dir / "tests" / f"test_{'_'.join(rel.parts)}.py"
    return (nested, flat)


def _expected_feature_candidates(task: TaskDefinition, root_dir: Path) -> tuple[Path, ...]:
    if task.source_path is None:
        return ()
    rel = task.source_path.relative_to(root_dir).with_suffix("")
    nested = root_dir / "features" / f"{rel.as_posix()}.feature"
    flat = root_dir / "features" / f"{'_'.join(rel.parts)}.feature"
    return (nested, flat)


def _check_marks_for_task(
    task: TaskDefinition, registry: TaskRegistry, warnings: list[str]
) -> None:
    checks = registry.config.checks
    mode = "error" if (checks.strict and checks.unknown_marks == "ignore") else checks.unknown_marks
    if mode == "ignore":
        return
    unknown = [mark for mark in task.marks if mark not in registry.config.marks]
    if not unknown:
        return
    msg = f"Task {task.name!r} uses unknown mark(s): {', '.join(unknown)}."
    if mode == "error":
        raise ValidationError(msg)
    warnings.append(msg)


def _check_task_files(task: TaskDefinition, registry: TaskRegistry) -> None:
    checks = registry.config.checks
    root_dir = task.root_dir
    if root_dir is None:
        return
    if checks.require_tests:
        candidates = _expected_test_candidates(task, root_dir)
        if not any(path.is_file() for path in candidates):
            expected = " or ".join(str(p) for p in candidates)
            raise ValidationError(f"Task {task.name!r} is missing required test file ({expected}).")
    if checks.require_features:
        candidates = _expected_feature_candidates(task, root_dir)
        if not any(path.is_file() for path in candidates):
            expected = " or ".join(str(p) for p in candidates)
            raise ValidationError(
                f"Task {task.name!r} is missing required feature file ({expected})."
            )


def validate_registry(registry: TaskRegistry) -> ValidationResult:
    """Validate task descriptions, marks, and optional test/feature presence."""
    checks = registry.config.checks
    warnings: list[str] = []
    for task in registry.ordered_tasks():
        if checks.require_description and not task.description.strip():
            raise ValidationError(f"Task {task.name!r} is missing a required description.")
        _check_marks_for_task(task, registry, warnings)
        _check_task_files(task, registry)
    return ValidationResult(warnings=tuple(warnings))


def _matches_marks(task: TaskDefinition, marks: Sequence[str], *, match_all: bool) -> bool:
    if match_all:
        return all(m in task.marks for m in marks)
    return any(m in task.marks for m in marks)


def select_tasks_by_marks(
    registry: TaskRegistry, marks: Sequence[str], *, match_all: bool = False
) -> tuple[str, ...]:
    """Return ordered task names matching marks together with prerequisites."""
    if not marks:
        raise ValidationError("At least one --mark value is required.")
    deps_map = validate_graph(registry)
    targets = [
        task.name
        for task in registry.ordered_tasks()
        if _matches_marks(task, marks, match_all=match_all)
    ]
    if not targets:
        raise ValidationError(f"No tasks matched mark(s): {', '.join(marks)}.")
    ordered: list[str] = []
    seen: set[str] = set()
    for target in targets:
        for name in _collect_order(deps_map, target):
            if name not in seen:
                seen.add(name)
                ordered.append(name)
    return tuple(ordered)


def format_effect_summary(registry: TaskRegistry, task_names: Sequence[str]) -> list[str]:
    """Build explicit human-readable lines describing marks and requires."""
    lines: list[str] = []
    for name in task_names:
        task = registry.tasks[name]
        parts: list[str] = []
        if task.marks:
            parts.append(f"marks={','.join(task.marks)}")
        if task.requires:
            parts.append(f"requires={','.join(task.requires)}")
        if parts:
            lines.append(f"{name}: {'; '.join(parts)}")
    return lines
