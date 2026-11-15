"""Opt-in content-hashed caching for declared inputs, outputs, and ctx.output."""

from __future__ import annotations

import hashlib
import json
import os
import pickle
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from tasknest.context import BufferedOutput, python_abi_tag

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

    from tasknest.task import TaskDefinition

CacheMode = Literal["default", "force", "no_cache"]
CacheStatus = Literal["hit", "miss", "bypassed", "disabled"]

_CACHE_SCHEMA_VERSION = 1
_CACHE_DIR = ".tasknest/cache"
_META_SUFFIX = ".meta.json"


@dataclass(frozen=True)
class CacheLookup:
    """Result of checking the cache before running a task."""

    status: CacheStatus
    reason: str
    cache_key: str | None = None
    static_key: str | None = None
    output: BufferedOutput | None = None


@dataclass(frozen=True)
class CacheContext:
    """Inputs required to compute and verify a task cache entry."""

    repo_root: Path
    project_root: Path
    task: TaskDefinition
    kwargs: Mapping[str, Any]
    dep_hashes: Mapping[str, str]
    base_env: Mapping[str, str]
    mode: CacheMode = "default"


def _canonical_json_bytes(payload: Any) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(65536):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_task_dir(name: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in name)


def _normalize_option_value(value: Any) -> Any:
    if isinstance(value, Path):
        return value.as_posix()
    if isinstance(value, (list, tuple)):
        return [_normalize_option_value(item) for item in value]
    if isinstance(value, dict):
        return {str(k): _normalize_option_value(v) for k, v in sorted(value.items())}
    return value


def _hash_directory_files(base: Path, directory: Path) -> list[list[str]]:
    entries: list[list[str]] = []
    for item in sorted(directory.rglob("*")):
        if item.is_file() and ".tasknest" not in item.parts:
            rel = item.relative_to(base).as_posix()
            entries.append([rel, _sha256_file(item)])
    return entries


def expand_input_hashes(project_root: Path, patterns: Sequence[str]) -> list[list[str]]:
    """Expand declared input paths/globs into sorted [rel_path, sha256] pairs."""
    collected: dict[str, str] = {}
    for raw in patterns:
        norm = raw.replace("\\", "/")
        has_glob = any(ch in norm for ch in "*?[")
        if has_glob:
            matches = sorted(project_root.glob(norm))
        else:
            candidate = project_root / norm
            matches = [candidate] if candidate.exists() else []
        if not matches:
            collected[f"missing:{norm}"] = "MISSING"
            continue
        for match in matches:
            if ".tasknest" in match.parts:
                continue
            if match.is_file():
                collected[match.relative_to(project_root).as_posix()] = _sha256_file(match)
            elif match.is_dir():
                for rel, digest in _hash_directory_files(project_root, match):
                    collected[rel] = digest
    return [[key, collected[key]] for key in sorted(collected)]


def _resolve_env_map(keys: Sequence[str], base_env: Mapping[str, str]) -> dict[str, str | None]:
    resolved: dict[str, str | None] = {}
    for key in sorted(set(keys)):
        resolved[key] = base_env[key] if key in base_env else os.environ.get(key)
    return resolved


def compute_static_key(ctx: CacheContext) -> str:
    """Compute the deterministic static cache key excluding dynamic ctx.env keys."""
    payload = {
        "schema": _CACHE_SCHEMA_VERSION,
        "task": ctx.task.name,
        "options": {str(k): _normalize_option_value(v) for k, v in sorted(ctx.kwargs.items())},
        "inputs": expand_input_hashes(ctx.project_root, ctx.task.inputs),
        "deps": {k: ctx.dep_hashes[k] for k in sorted(ctx.dep_hashes)},
        "declared_env": _resolve_env_map(ctx.task.env, ctx.base_env),
    }
    return _sha256_bytes(_canonical_json_bytes(payload))


def compute_full_key(
    static_key: str,
    dynamic_env: Mapping[str, str | None],
    runner_compat: str = "cross",
) -> str:
    """Combine static_key, dynamic env values, and runner compatibility tag."""
    payload = {
        "static_key": static_key,
        "dynamic_env": {k: dynamic_env[k] for k in sorted(dynamic_env)},
        "runner_compat": runner_compat,
    }
    return _sha256_bytes(_canonical_json_bytes(payload))


def _entry_dir(repo_root: Path, task_name: str) -> Path:
    return repo_root / _CACHE_DIR / "entries" / _safe_task_dir(task_name)


def _local_dir(repo_root: Path, task_name: str) -> Path:
    return repo_root / _CACHE_DIR / "local" / _safe_task_dir(task_name)


def _blobs_dir(repo_root: Path) -> Path:
    return repo_root / _CACHE_DIR / "blobs"


def _verify_declared_outputs(
    project_root: Path, recorded: Sequence[Mapping[str, Any]]
) -> str | None:
    for item in recorded:
        rel = str(item["path"])
        kind = str(item["kind"])
        target = project_root / rel
        if kind == "missing" or not target.exists():
            return f"missing declared output: {rel}"
        if kind == "file":
            if not target.is_file() or _sha256_file(target) != item.get("sha256"):
                return f"modified declared output: {rel}"
        elif kind == "dir":
            if not target.is_dir():
                return f"missing declared output: {rel}"
            current_hash = _sha256_bytes(
                _canonical_json_bytes(_hash_directory_files(project_root, target))
            )
            if current_hash != item.get("sha256"):
                return f"modified declared output: {rel}"
    return None


def _restore_cached_output(
    repo_root: Path, task_name: str, key: str, entry: Mapping[str, Any]
) -> tuple[BufferedOutput | None, str | None]:
    fmt = entry.get("output_format")
    if fmt is None:
        return None, None
    digest = str(entry.get("output_hash", ""))
    if fmt == "json":
        payload = entry.get("output_payload")
        raw = _canonical_json_bytes(payload)
        return BufferedOutput(
            payload=payload, output_format="json", digest=digest, raw_bytes=raw
        ), None
    if fmt == "pickle":
        expected_abi = python_abi_tag()
        if entry.get("abi_tag") != expected_abi:
            return None, f"pickle ABI mismatch ({entry.get('abi_tag')} != {expected_abi})"
        pkl_path = _local_dir(repo_root, task_name) / f"{key}.pkl"
        if not pkl_path.is_file():
            return None, "missing local pickle cache payload"
        raw = pkl_path.read_bytes()
        return (
            BufferedOutput(
                payload=pickle.loads(raw),  # noqa: S301 - local-only opt-in cache keyed by ABI
                output_format="pickle",
                digest=digest,
                raw_bytes=raw,
                abi_tag=expected_abi,
            ),
            None,
        )
    return None, f"unsupported cached output format: {fmt}"


def lookup_cache(ctx: CacheContext) -> CacheLookup:
    """Look up a valid cache entry for ctx, checking outputs and dynamic env."""
    if not ctx.task.cache:
        return CacheLookup("disabled", "caching disabled")
    if ctx.mode == "force":
        return CacheLookup("bypassed", "bypassed via --force")
    if ctx.mode == "no_cache":
        return CacheLookup("bypassed", "bypassed via --no-cache")
    static_key = compute_static_key(ctx)
    task_dir = _entry_dir(ctx.repo_root, ctx.task.name)
    meta_path = task_dir / f"{static_key}{_META_SUFFIX}"
    if not meta_path.is_file():
        return CacheLookup("miss", "no cached entry", static_key=static_key)
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    dyn_keys = [str(k) for k in meta.get("dynamic_env_keys", [])]
    compat = str(meta.get("runner_compat", "cross"))
    full_key = compute_full_key(static_key, _resolve_env_map(dyn_keys, ctx.base_env), compat)
    entry_path = task_dir / f"{full_key}.json"
    if not entry_path.is_file():
        return CacheLookup("miss", "cache key mismatch", cache_key=full_key, static_key=static_key)
    entry = json.loads(entry_path.read_text(encoding="utf-8"))
    invalid = _verify_declared_outputs(ctx.project_root, entry.get("outputs", []))
    if invalid:
        return CacheLookup("miss", invalid, cache_key=full_key, static_key=static_key)
    restored, err = _restore_cached_output(ctx.repo_root, ctx.task.name, full_key, entry)
    if err:
        return CacheLookup("miss", err, cache_key=full_key, static_key=static_key)
    return CacheLookup(
        "hit", "cache hit", cache_key=full_key, static_key=static_key, output=restored
    )


def _snapshot_declared_outputs(
    repo_root: Path, project_root: Path, outputs: Sequence[str]
) -> list[dict[str, Any]]:
    blobs = _blobs_dir(repo_root)
    blobs.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []
    for rel in outputs:
        norm = rel.replace("\\", "/")
        target = project_root / norm
        if not target.exists():
            records.append({"path": norm, "kind": "missing", "sha256": None})
        elif target.is_file():
            digest = _sha256_file(target)
            blob = blobs / digest
            if not blob.exists():
                shutil.copy2(target, blob)
            records.append({"path": norm, "kind": "file", "sha256": digest})
        elif target.is_dir():
            files = _hash_directory_files(project_root, target)
            for item_rel, digest in files:
                blob = blobs / digest
                if not blob.exists():
                    shutil.copy2(project_root / item_rel, blob)
            dir_hash = _sha256_bytes(_canonical_json_bytes(files))
            records.append({"path": norm, "kind": "dir", "sha256": dir_hash, "files": files})
    return records


def store_cache(
    ctx: CacheContext,
    dynamic_env: Mapping[str, str | None],
    output: BufferedOutput | None,
) -> str | None:
    """Persist a cache entry, output blobs, and optional local pickle payload."""
    if not ctx.task.cache or ctx.mode == "no_cache":
        return None
    static_key = compute_static_key(ctx)
    compat = f"py-{output.abi_tag}" if output and output.output_format == "pickle" else "cross"
    full_key = compute_full_key(static_key, dynamic_env, compat)
    task_dir = _entry_dir(ctx.repo_root, ctx.task.name)
    task_dir.mkdir(parents=True, exist_ok=True)
    meta_payload = {"dynamic_env_keys": sorted(dynamic_env), "runner_compat": compat}
    (task_dir / f"{static_key}{_META_SUFFIX}").write_bytes(_canonical_json_bytes(meta_payload))
    entry: dict[str, Any] = {
        "schema_version": _CACHE_SCHEMA_VERSION,
        "task": ctx.task.name,
        "cache_key": full_key,
        "static_key": static_key,
        "runner_compat": compat,
        "outputs": _snapshot_declared_outputs(ctx.repo_root, ctx.project_root, ctx.task.outputs),
        "dynamic_env": {k: dynamic_env[k] for k in sorted(dynamic_env)},
    }
    if output is not None:
        entry["output_format"] = output.output_format
        entry["output_hash"] = output.digest
        entry["abi_tag"] = output.abi_tag
        if output.output_format == "json":
            entry["output_payload"] = output.payload
        elif output.output_format == "pickle":
            local = _local_dir(ctx.repo_root, ctx.task.name)
            local.mkdir(parents=True, exist_ok=True)
            (local / f"{full_key}.pkl").write_bytes(output.raw_bytes)
    (task_dir / f"{full_key}.json").write_bytes(_canonical_json_bytes(entry))
    return full_key
