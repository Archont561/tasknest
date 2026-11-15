"""Unit and Hypothesis property tests for tasknest.task."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Literal

import pytest
from hypothesis import given
from hypothesis import strategies as st
from tasknest.errors import ValidationError
from tasknest.task import TaskOption, coerce_option_value, tool

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
