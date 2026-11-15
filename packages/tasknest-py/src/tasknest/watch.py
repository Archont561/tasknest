"""DAG-aware watch mode monitoring declared inputs with early-cutoff caching."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from tasknest.cache import expand_input_hashes
from tasknest.errors import ValidationError
from tasknest.graph import ExecutionReport, RunOptions, plan_execution, run_order, validate_graph

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping, Sequence
    from pathlib import Path

    from tasknest.discovery import TaskRegistry


@dataclass(frozen=True)
class WatchConfig:
    """Polling and execution settings for WatchSession."""

    interval_ms: int = 250
    max_cycles: int | None = None
    jobs: int | None = None
    is_verbose: bool = False


@dataclass(frozen=True)
class WatchCycle:
    """Result of one initial or incremental watch execution cycle."""

    cycle_index: int
    report: ExecutionReport
    dirty_tasks: tuple[str, ...]
    skipped_clean: tuple[str, ...]


def _normalize_output_paths(outputs: Sequence[str]) -> set[str]:
    return {raw.strip().replace("\\", "/").rstrip("/") for raw in outputs if raw.strip()}


def _is_under_output(rel_path: str, output_set: set[str]) -> bool:
    norm = rel_path.replace("\\", "/")
    return any(norm == out or norm.startswith(f"{out}/") for out in output_set)


def _snapshot_task_inputs(
    repo_root: Path, project_root: Path, inputs: Sequence[str], outputs: Sequence[str]
) -> tuple[tuple[str, str], ...]:
    if not inputs:
        return ()
    excluded = _normalize_output_paths(outputs)
    pairs = expand_input_hashes(project_root, inputs)
    filtered: list[tuple[str, str]] = []
    for rel, digest in pairs:
        if _is_under_output(rel, excluded):
            continue
        if rel.startswith("missing:"):
            raw_pat = rel.split(":", 1)[1]
            if _is_under_output(raw_pat, excluded):
                continue
        _ = repo_root
        filtered.append((rel, digest))
    return tuple(filtered)


def _expand_dirty_subgraph(
    order: tuple[str, ...],
    deps_map: Mapping[str, tuple[str, ...]],
    dirty_roots: set[str],
) -> tuple[str, ...]:
    dirty = set(dirty_roots)
    for name in order:
        if any(dep in dirty for dep in deps_map[name]):
            dirty.add(name)
    return tuple(name for name in order if name in dirty)


@dataclass
class WatchSession:
    """Stateful DAG-aware watch session for a target task and its dependencies."""

    registry: TaskRegistry
    target_name: str
    target_kwargs: dict[str, Any] = field(default_factory=dict)
    config: WatchConfig = field(default_factory=WatchConfig)
    order: tuple[str, ...] = field(init=False)
    deps_map: dict[str, tuple[str, ...]] = field(init=False)
    _cycle_index: int = field(init=False, default=0)
    _last_hashes: dict[str, tuple[tuple[str, str], ...]] = field(init=False, default_factory=dict)
    _committed_outputs: dict[str, Any] = field(init=False, default_factory=dict)
    _output_hashes: dict[str, str] = field(init=False, default_factory=dict)

    def __post_init__(self) -> None:
        self.deps_map = validate_graph(self.registry)
        self.order = plan_execution(self.registry, self.target_name)
        for name in self.order:
            if self.registry.tasks[name].persistent:
                raise ValidationError(
                    f"Cannot use 'watch' on persistent task {name!r}; run it directly instead."
                )

    def _capture_all_inputs(self) -> dict[str, tuple[tuple[str, str], ...]]:
        snapshots: dict[str, tuple[tuple[str, str], ...]] = {}
        for name in self.order:
            task = self.registry.tasks[name]
            proj_root = task.project_root or self.registry.config.repo_root
            snapshots[name] = _snapshot_task_inputs(
                self.registry.config.repo_root, proj_root, task.inputs, task.outputs
            )
        return snapshots

    def _update_state(
        self,
        snapshots: dict[str, tuple[tuple[str, str], ...]],
        report: ExecutionReport,
    ) -> None:
        self._last_hashes = snapshots
        self._committed_outputs.update(report.committed_outputs)
        self._output_hashes.update(report.output_hashes)

    def run_initial(self) -> WatchCycle:
        """Execute the full target subgraph once and record baseline input hashes."""
        snapshots = self._capture_all_inputs()
        opts = RunOptions(
            jobs=self.config.jobs,
            cache_mode="default",
            is_verbose=self.config.is_verbose,
            target_name=self.target_name,
            target_kwargs=self.target_kwargs,
        )
        report = run_order(self.registry, self.order, options=opts)
        self._update_state(snapshots, report)
        cycle = WatchCycle(
            cycle_index=self._cycle_index,
            report=report,
            dirty_tasks=self.order,
            skipped_clean=(),
        )
        self._cycle_index += 1
        return cycle

    def _matches_changed_paths(
        self,
        name: str,
        current_snap: tuple[tuple[str, str], ...],
        changed_paths: Sequence[str] | None,
    ) -> bool:
        if current_snap == self._last_hashes.get(name, ()):
            return False
        if changed_paths is None:
            return True
        task = self.registry.tasks[name]
        excluded = _normalize_output_paths(task.outputs)
        normalized = {p.replace("\\", "/").lstrip("./") for p in changed_paths}
        return any(not _is_under_output(p, excluded) for p in normalized)

    def step(self, changed_paths: Sequence[str] | None = None) -> WatchCycle | None:
        """Inspect declared inputs and re-run only the minimal dirty subgraph."""
        snapshots = self._capture_all_inputs()
        dirty_roots = {
            name
            for name in self.order
            if self._matches_changed_paths(name, snapshots[name], changed_paths)
        }
        if not dirty_roots:
            return None
        dirty_order = _expand_dirty_subgraph(self.order, self.deps_map, dirty_roots)
        skipped_clean = tuple(name for name in self.order if name not in dirty_order)
        opts = RunOptions(
            jobs=self.config.jobs,
            cache_mode="default",
            is_verbose=self.config.is_verbose,
            seed_outputs=self._committed_outputs,
            seed_output_hashes=self._output_hashes,
            target_name=self.target_name,
            target_kwargs=self.target_kwargs,
        )
        report = run_order(self.registry, dirty_order, options=opts)
        self._update_state(snapshots, report)
        cycle = WatchCycle(
            cycle_index=self._cycle_index,
            report=report,
            dirty_tasks=dirty_order,
            skipped_clean=skipped_clean,
        )
        self._cycle_index += 1
        return cycle

    def run(self, on_cycle: Callable[[WatchCycle], None] | None = None) -> list[WatchCycle]:
        """Run initial build then poll for input changes until max_cycles or interrupt."""
        cycles: list[WatchCycle] = []
        initial = self.run_initial()
        cycles.append(initial)
        if on_cycle is not None:
            on_cycle(initial)
        limit = self.config.max_cycles
        sleep_sec = max(0.01, self.config.interval_ms / 1000.0)
        try:
            while limit is None or len(cycles) < limit:
                time.sleep(sleep_sec)
                nxt = self.step()
                if nxt is not None:
                    cycles.append(nxt)
                    if on_cycle is not None:
                        on_cycle(nxt)
        except KeyboardInterrupt:
            pass
        return cycles
