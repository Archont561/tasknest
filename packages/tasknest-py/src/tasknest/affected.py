"""Affected change provenance and conservative task/test selection."""

from __future__ import annotations

import ast
import shutil
import subprocess
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from tasknest.errors import ToolError

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence
    from pathlib import Path

ChangeStatus = Literal[
    "added",
    "modified",
    "deleted",
    "renamed",
    "copied",
    "untracked",
    "unknown",
]

_STATUS_CODE_MAP: dict[str, ChangeStatus] = {
    "A": "added",
    "M": "modified",
    "D": "deleted",
    "R": "renamed",
    "C": "copied",
}

DEFAULT_ALWAYS_FULL: tuple[str, ...] = (
    "pyproject.toml",
    "package.json",
    "tsconfig.json",
    "bun.lock",
    "pixi.toml",
    "pixi.lock",
    "tasknest.toml",
    "conftest.py",
    "tests/conftest.py",
)


def normalize_rel_path(raw: str) -> str:
    """Normalize a repository-relative path with forward slashes."""
    cleaned = raw.strip().replace("\\", "/")
    while cleaned.startswith("./"):
        cleaned = cleaned[2:]
    return cleaned


@dataclass(frozen=True)
class ChangedFile:
    """Single file change entry with status and optional rename/copy source path."""

    path: str
    status: ChangeStatus = "modified"
    old_path: str | None = None

    def touched_paths(self) -> tuple[str, ...]:
        """Return all affected relative paths including old_path for renames/deletions."""
        norm_path = normalize_rel_path(self.path)
        if self.old_path:
            norm_old = normalize_rel_path(self.old_path)
            if norm_old != norm_path:
                return (norm_old, norm_path)
        return (norm_path,)

    def to_dict(self) -> dict[str, str | None]:
        """Serialize entry to a JSON-compatible dictionary."""
        return {"path": self.path, "status": self.status, "old_path": self.old_path}


@dataclass(frozen=True)
class AffectedContext:
    """Explicit change provenance exposed via ctx.affected."""

    available: bool = False
    complete: bool = False
    files: tuple[ChangedFile, ...] = ()
    base_ref: str | None = None
    target_ref: str | None = None
    reason: str | None = "no change context provided"
    include_untracked: bool = True

    def paths(self) -> tuple[str, ...]:
        """Return normalized primary paths for all changed entries."""
        return tuple(normalize_rel_path(item.path) for item in self.files)

    def old_paths(self) -> tuple[str, ...]:
        """Return normalized old paths for renames and copies."""
        return tuple(
            normalize_rel_path(item.old_path) for item in self.files if item.old_path is not None
        )

    def all_touched_paths(self) -> tuple[str, ...]:
        """Return deduplicated paths including rename/copy source paths and deletions."""
        seen: set[str] = set()
        ordered: list[str] = []
        for entry in self.files:
            for touched in entry.touched_paths():
                if touched not in seen:
                    seen.add(touched)
                    ordered.append(touched)
        return tuple(ordered)

    def to_dict(self) -> dict[str, object]:
        """Serialize provenance context for diagnostics and reports."""
        return {
            "available": self.available,
            "complete": self.complete,
            "base_ref": self.base_ref,
            "target_ref": self.target_ref,
            "reason": self.reason,
            "include_untracked": self.include_untracked,
            "files": [entry.to_dict() for entry in self.files],
        }


@dataclass(frozen=True)
class AffectedTestPlan:
    """Selection plan produced by conservative affected test or task lookup."""

    targets: tuple[str, ...]
    fallback_reason: str | None = None
    reasons: dict[str, str] | None = None


@dataclass(frozen=True)
class SelectionPolicy:
    """Options controlling conservative affected selection."""

    default_target: str = "tests"
    always_full: Sequence[str] = DEFAULT_ALWAYS_FULL
    force_all: bool = False
    strict: bool = False


def parse_git_name_status(raw_diff: str, raw_untracked: str = "") -> tuple[ChangedFile, ...]:
    """Parse `git diff --name-status -M` and optional untracked file lines."""
    entries: list[ChangedFile] = []
    for line in raw_diff.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        parts = stripped.split("\t")
        code = parts[0][:1]
        status: ChangeStatus = _STATUS_CODE_MAP.get(code, "unknown")
        if code in ("R", "C") and len(parts) >= 3:
            entries.append(
                ChangedFile(
                    path=normalize_rel_path(parts[2]),
                    status=status,
                    old_path=normalize_rel_path(parts[1]),
                )
            )
        elif len(parts) >= 2:
            path = normalize_rel_path(parts[1])
            old = path if status == "deleted" else None
            entries.append(ChangedFile(path=path, status=status, old_path=old))
    for line in raw_untracked.splitlines():
        rel = normalize_rel_path(line)
        if rel:
            entries.append(ChangedFile(path=rel, status="untracked", old_path=None))
    return tuple(entries)


def _run_git_lines(repo_root: Path, argv: Sequence[str]) -> tuple[bool, str, str]:
    git_exe = shutil.which("git")
    if git_exe is None:
        return False, "", "git executable not found"
    try:
        proc = subprocess.run(  # noqa: S603 - explicit git argv without shell
            [git_exe, *argv],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError as exc:
        return False, "", str(exc)
    return proc.returncode == 0, proc.stdout, proc.stderr.strip()


def collect_git_changes(
    repo_root: Path,
    *,
    base_ref: str | None = None,
    include_untracked: bool = True,
) -> AffectedContext:
    """Collect changed files comparing base_ref (or HEAD) against the working tree."""
    diff_ref = base_ref or "HEAD"
    ok, diff_out, diff_err = _run_git_lines(repo_root, ["diff", "--name-status", "-M", diff_ref])
    if not ok:
        return AffectedContext(
            available=False,
            complete=False,
            base_ref=diff_ref,
            target_ref="WORKTREE",
            reason=f"git diff against {diff_ref!r} failed: {diff_err or 'unavailable'}",
            include_untracked=include_untracked,
        )
    untracked_out = ""
    if include_untracked:
        u_ok, u_out, u_err = _run_git_lines(
            repo_root, ["ls-files", "--others", "--exclude-standard"]
        )
        if not u_ok:
            return AffectedContext(
                available=True,
                complete=False,
                files=parse_git_name_status(diff_out),
                base_ref=diff_ref,
                target_ref="WORKTREE",
                reason=f"git untracked listing failed: {u_err or 'unavailable'}",
                include_untracked=include_untracked,
            )
        untracked_out = u_out
    files = parse_git_name_status(diff_out, untracked_out)
    return AffectedContext(
        available=True,
        complete=True,
        files=files,
        base_ref=diff_ref,
        target_ref="WORKTREE",
        reason=None,
        include_untracked=include_untracked,
    )


def _as_changed_files(changes: AffectedContext | Sequence[ChangedFile | str]) -> list[ChangedFile]:
    if isinstance(changes, AffectedContext):
        return list(changes.files)
    converted: list[ChangedFile] = []
    for item in changes:
        if isinstance(item, ChangedFile):
            converted.append(item)
        else:
            converted.append(ChangedFile(path=normalize_rel_path(item), status="modified"))
    return converted


def _fallback_or_raise(policy: SelectionPolicy, reason: str) -> AffectedTestPlan:
    if policy.strict:
        raise ToolError(f"Affected selection could not narrow scope safely: {reason}")
    return AffectedTestPlan((policy.default_target,), reason)


def _is_global_trigger(norm: str, always_full: Sequence[str]) -> bool:
    return norm in always_full or norm.endswith("/conftest.py")


def select_conservative_targets(
    changes: AffectedContext | Sequence[ChangedFile | str],
    mapping: Mapping[str, Sequence[str]] | None,
    policy: SelectionPolicy | None = None,
) -> AffectedTestPlan:
    """Select affected targets from a reverse mapping with conservative fallback."""
    cfg = policy or SelectionPolicy()
    if cfg.force_all:
        return AffectedTestPlan((cfg.default_target,), "full suite forced (--all / --force)")
    if isinstance(changes, AffectedContext) and (not changes.available or not changes.complete):
        return _fallback_or_raise(cfg, changes.reason or "change context incomplete")
    if mapping is None:
        return _fallback_or_raise(cfg, "no source-to-test mapping provided")
    entries = _as_changed_files(changes)
    if not entries:
        return AffectedTestPlan((), None)
    return _map_changed_entries(entries, mapping, cfg)


def _map_changed_entries(
    entries: Sequence[ChangedFile],
    mapping: Mapping[str, Sequence[str]],
    cfg: SelectionPolicy,
) -> AffectedTestPlan:
    selected: list[str] = []
    seen: set[str] = set()
    reasons: dict[str, str] = {}
    for entry in entries:
        for touched in entry.touched_paths():
            if _is_global_trigger(touched, cfg.always_full):
                return _fallback_or_raise(cfg, f"global trigger changed: {touched}")
            mapped = mapping.get(touched)
            if not mapped:
                label = (
                    "unmapped deletion/rename"
                    if entry.status in ("deleted", "renamed")
                    else "unmapped change"
                )
                return _fallback_or_raise(cfg, f"{label}: {touched}")
            for target in mapped:
                if target not in seen:
                    seen.add(target)
                    selected.append(target)
                    reasons[target] = f"matched {touched}"
    return AffectedTestPlan(tuple(selected), None, reasons)


def _module_name_for_file(src_root: Path, file_path: Path) -> str:
    rel = file_path.relative_to(src_root).with_suffix("")
    parts = list(rel.parts)
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _imported_modules(file_path: Path) -> set[str]:
    tree = ast.parse(file_path.read_text(encoding="utf-8"))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module)
    return imported


def build_python_reverse_map(
    repo_root: Path,
    source_root: Path,
    test_root: Path,
) -> dict[str, list[str]]:
    """Build a conservative source-file to pytest-test-file reverse dependency map."""
    abs_src = source_root if source_root.is_absolute() else (repo_root / source_root)
    abs_tests = test_root if test_root.is_absolute() else (repo_root / test_root)
    module_to_rel: dict[str, str] = {}
    for py_file in sorted(abs_src.rglob("*.py")):
        mod = _module_name_for_file(abs_src, py_file)
        if mod:
            module_to_rel[mod] = normalize_rel_path(str(py_file.relative_to(repo_root)))
    reverse: dict[str, list[str]] = {rel: [] for rel in module_to_rel.values()}
    for test_file in sorted(abs_tests.rglob("test_*.py")):
        rel_test = normalize_rel_path(str(test_file.relative_to(repo_root)))
        reverse[rel_test] = [rel_test]
        for imp in _imported_modules(test_file):
            for mod, rel_src in module_to_rel.items():
                if imp == mod or imp.startswith(f"{mod}."):
                    reverse[rel_src].append(rel_test)
    return {key: sorted(set(vals)) for key, vals in reverse.items() if vals}
