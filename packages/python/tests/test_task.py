"""Unit and Hypothesis property tests for tasknest.task."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import TYPE_CHECKING, Literal

import pytest
from hypothesis import given
from hypothesis import strategies as st
from tasknest.errors import ValidationError
from tasknest.task import TaskDefinition, TaskOption, coerce_option_value, tool

if TYPE_CHECKING:
    from tasknest.context import ToolContext


def test_tool_decorator_extracts_metadata_and_options() -> None:
    @tool(depends=["prep"], marks=["fast"], requires=["ruff"])
    def sample(
        ctx: ToolContext,
        target: Path,
        dry_run: bool = False,
        mode: Literal["a", "b"] = "a",
        tags: list[str] | None = None,
    ) -> None:
        """Sample task description."""

    assert sample.name == "sample"
    assert sample.depends == ("prep",)
    assert sample.marks == ("fast",)
    assert sample.requires == ("ruff",)
    assert sample.description == "Sample task description."
    assert sample.takes_context is True
    assert [opt.cli_name for opt in sample.options] == ["target", "dry-run", "mode", "tags"]
    assert sample.options[0].base_type is Path
    assert sample.options[0].required is True
    assert sample.options[1].required is False


def test_tool_rejects_unsupported_annotations_and_variadics() -> None:
    with pytest.raises(ValidationError, match="Unsupported parameter type"):

        @tool()
        def bad_dict(mapping: dict[str, int]) -> None:
            pass

    with pytest.raises(ValidationError, match="Unsupported union type"):

        @tool()
        def bad_union(val: int | str) -> None:
            pass

    with pytest.raises(ValidationError, match="Variadic parameter"):

        @tool()
        def bad_varargs(*args: str) -> None:
            pass


@given(n=st.integers(min_value=-100_000, max_value=100_000))
def test_property_coerce_int_roundtrips(n: int) -> None:
    opt = TaskOption(param_name="jobs", cli_name="jobs", base_type=int)
    assert coerce_option_value(opt, str(n)) == n


@given(raw=st.text(alphabet="abcdefghijklmnopqrstuvwxyz", min_size=1, max_size=12))
def test_property_coerce_int_rejects_letters(raw: str) -> None:
    opt = TaskOption(param_name="jobs", cli_name="jobs", base_type=int)
    with pytest.raises(ValidationError, match="Invalid int"):
        coerce_option_value(opt, raw)


@given(token=st.sampled_from(["1", "true", "TRUE", "yes", "on"]))
def test_property_coerce_bool_truthy(token: str) -> None:
    opt = TaskOption(param_name="fix", cli_name="fix", base_type=bool)
    assert coerce_option_value(opt, token) is True


@given(token=st.sampled_from(["0", "false", "FALSE", "no", "off"]))
def test_property_coerce_bool_falsy(token: str) -> None:
    opt = TaskOption(param_name="fix", cli_name="fix", base_type=bool)
    assert coerce_option_value(opt, token) is False


def test_task_definition_equality_matches_across_reloads_and_distinguishes_others(
    tmp_path: Path,
) -> None:
    mod_file = tmp_path / "sample_mod.py"
    mod_file.write_text(
        "from tasknest import tool\n"
        "@tool()\n"
        "def alpha() -> None: pass\n"
        "@tool()\n"
        "def beta() -> None: pass\n",
        encoding="utf-8",
    )
    spec_a = importlib.util.spec_from_file_location("_mod_a", mod_file)
    spec_b = importlib.util.spec_from_file_location("_mod_b", mod_file)
    assert spec_a is not None
    assert spec_a.loader is not None
    assert spec_b is not None
    assert spec_b.loader is not None
    mod_a = importlib.util.module_from_spec(spec_a)
    mod_b = importlib.util.module_from_spec(spec_b)
    spec_a.loader.exec_module(mod_a)
    spec_b.loader.exec_module(mod_b)

    assert isinstance(mod_a.alpha, TaskDefinition)
    assert mod_a.alpha == mod_b.alpha
    assert mod_a.alpha != mod_b.beta

    closures = [tool()(lambda: None) for _ in range(2)]
    assert closures[0] != closures[1]
