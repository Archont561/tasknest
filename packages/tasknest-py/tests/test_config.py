"""Tests for tasknest.config and property-based TOML configuration loading."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest
import tomli_w
from hypothesis import given
from hypothesis import strategies as st
from tasknest.config import DiscoveryRoot, load_config
from tasknest.errors import ConfigError

_IDENT = st.from_regex(r"[a-z][a-z0-9_]{0,8}", fullmatch=True)
_SAFE_DESC = st.text(min_size=1, max_size=24)


def test_load_config_defaults_when_file_absent(tmp_path: Path) -> None:
    cfg = load_config(tmp_path)
    assert cfg.repo_root == tmp_path.resolve()
    assert cfg.roots == (DiscoveryRoot(path=Path("tools"), namespace="", project_root=Path(".")),)
    assert cfg.marks == {}
    assert cfg.jobs == 1


def test_load_config_explicit_missing_and_invalid_raises(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="not found"):
        load_config(tmp_path, tmp_path / "missing.toml")

    bad_toml = tmp_path / "bad.toml"
    bad_toml.write_text("not valid toml", encoding="utf-8")
    with pytest.raises(ConfigError, match="Invalid TOML"):
        load_config(tmp_path, bad_toml)

    bad_jobs = tmp_path / "bad_jobs.toml"
    bad_jobs.write_text(tomli_w.dumps({"execution": {"jobs": 0}}), encoding="utf-8")
    with pytest.raises(ConfigError, match="positive integer"):
        load_config(tmp_path, bad_jobs)


@given(
    root_paths=st.lists(_IDENT, min_size=1, max_size=3),
    namespaces=st.lists(_IDENT, min_size=1, max_size=3),
    marks=st.dictionaries(_IDENT, _SAFE_DESC, max_size=4),
    jobs=st.integers(min_value=1, max_value=16),
)
def test_property_load_config_parses_generated_toml(
    root_paths: list[str],
    namespaces: list[str],
    marks: dict[str, str],
    jobs: int,
) -> None:
    count = min(len(root_paths), len(namespaces))
    expected_roots = tuple(
        DiscoveryRoot(path=Path(root_paths[i]), namespace=namespaces[i], project_root=Path("."))
        for i in range(count)
    )
    payload: dict[str, object] = {
        "tasknest": {"config_version": 1},
        "execution": {"jobs": jobs},
        "discovery": {
            "roots": [
                {
                    "path": root.path.as_posix(),
                    "namespace": root.namespace,
                    "project_root": ".",
                }
                for root in expected_roots
            ]
        },
    }
    if marks:
        payload["marks"] = marks

    with tempfile.TemporaryDirectory() as tmp:
        workspace = Path(tmp)
        (workspace / "tasknest.toml").write_text(tomli_w.dumps(payload), encoding="utf-8")
        cfg = load_config(workspace)
        assert cfg.roots == expected_roots
        assert cfg.marks == marks
        assert cfg.jobs == jobs
