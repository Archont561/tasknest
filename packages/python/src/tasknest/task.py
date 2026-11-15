"""Task decorator, metadata, and typed parameter inspection."""

from __future__ import annotations

import inspect
import types
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, Union, get_args, get_origin, get_type_hints

from tasknest.context import ToolContext
from tasknest.errors import ValidationError

if TYPE_CHECKING:
    from collections.abc import Callable

_MISSING = inspect.Parameter.empty
_SCALAR_TYPES: tuple[type[Any], ...] = (str, int, float, bool, Path)


@dataclass(frozen=True)
class TaskOption:
    """Validated CLI option extracted from a task function parameter."""

    param_name: str
    cli_name: str
    base_type: type[Any]
    is_list: bool = False
    required: bool = False
    default: Any = None
    choices: tuple[Any, ...] = ()
    allow_none: bool = False

    def format_type(self) -> str:
        """Render a concise human-readable type label."""
        label = "|".join(repr(c) for c in self.choices) if self.choices else self.base_type.__name__
        return f"list[{label}]" if self.is_list else label


@dataclass
class TaskDefinition:
    """Registered Tasknest task metadata and callable."""

    callable_fn: Any
    name: str
    depends: tuple[str | TaskDefinition, ...] = ()
    marks: tuple[str, ...] = ()
    requires: tuple[str, ...] = ()
    description: str = ""
    takes_context: bool = True
    options: tuple[TaskOption, ...] = ()
    source_path: Path | None = None
    project_root: Path | None = None
    cli_path: tuple[str, ...] = field(default_factory=tuple)

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return self.callable_fn(*args, **kwargs)


def _unwrap_optional(annotation: Any, task_name: str, param: str) -> tuple[Any, bool]:
    origin = get_origin(annotation)
    if origin not in (Union, types.UnionType):
        return annotation, False
    args = [arg for arg in get_args(annotation) if arg is not type(None)]
    if len(args) != 1 or len(args) == len(get_args(annotation)):
        raise ValidationError(
            f"Unsupported union type {annotation!r} for parameter {param!r} in task {task_name!r}."
        )
    return args[0], True


def _resolve_scalar_and_choices(
    inner: Any, annotation: Any, param_name: str, task_name: str
) -> tuple[type[Any], tuple[Any, ...]]:
    if get_origin(inner) is Literal:
        choices = tuple(get_args(inner))
        base_type: type[Any] = type(choices[0]) if choices else str
        return base_type, choices
    if isinstance(inner, type) and inner in _SCALAR_TYPES:
        return inner, ()
    raise ValidationError(
        f"Unsupported parameter type {annotation!r} for {param_name!r} in task {task_name!r}."
    )


def _infer_param_annotation(param: inspect.Parameter, annotation: Any) -> Any:
    if annotation is not _MISSING:
        return annotation
    if param.default not in (_MISSING, None):
        return type(param.default)
    return str


def _build_option(param: inspect.Parameter, annotation: Any, task_name: str) -> TaskOption:
    if param.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
        raise ValidationError(
            f"Variadic parameter *{param.name} is not supported in task {task_name!r}."
        )
    resolved_ann = _infer_param_annotation(param, annotation)
    inner, allow_none = _unwrap_optional(resolved_ann, task_name, param.name)
    is_list = get_origin(inner) is list
    if is_list:
        list_args = get_args(inner)
        if len(list_args) != 1:
            raise ValidationError(
                f"list annotation for {param.name!r} in {task_name!r} needs one element type."
            )
        inner = list_args[0]
    base_type, choices = _resolve_scalar_and_choices(inner, resolved_ann, param.name, task_name)
    required = param.default is _MISSING
    return TaskOption(
        param_name=param.name,
        cli_name=param.name.replace("_", "-"),
        base_type=base_type,
        is_list=is_list,
        required=required,
        default=None if required else param.default,
        choices=choices,
        allow_none=allow_none,
    )


def inspect_task_signature(target_fn: Any, task_name: str) -> tuple[bool, tuple[TaskOption, ...]]:
    """Inspect a task callable and validate its ToolContext and typed CLI options."""
    sig = inspect.signature(target_fn)
    try:
        hints = get_type_hints(target_fn, localns={"ToolContext": ToolContext})
    except Exception:
        hints = {}
    params = list(sig.parameters.values())
    takes_context = False
    if params:
        first = params[0]
        first_hint = hints.get(first.name, first.annotation)
        if first.name == "ctx" or first_hint is ToolContext:
            takes_context = True
            params = params[1:]
    options = tuple(_build_option(p, hints.get(p.name, p.annotation), task_name) for p in params)
    return takes_context, options


def _parse_bool_token(raw: str, cli_name: str) -> bool:
    lower = raw.lower()
    if lower in ("1", "true", "yes", "on"):
        return True
    if lower in ("0", "false", "no", "off"):
        return False
    raise ValidationError(f"Invalid boolean value {raw!r} for --{cli_name}.")


def _coerce_scalar(target: type[Any], raw: str, cli_name: str) -> Any:
    if target is bool:
        return _parse_bool_token(raw, cli_name)
    if target is int:
        try:
            return int(raw)
        except ValueError as exc:
            raise ValidationError(f"Invalid int value {raw!r} for --{cli_name}.") from exc
    if target is float:
        try:
            return float(raw)
        except ValueError as exc:
            raise ValidationError(f"Invalid float value {raw!r} for --{cli_name}.") from exc
    return Path(raw) if target is Path else raw


def coerce_option_value(option: TaskOption, raw: str) -> Any:
    """Convert a raw CLI string token to the option's declared scalar type."""
    converted = _coerce_scalar(option.base_type, raw, option.cli_name)
    if option.choices and converted not in option.choices:
        allowed = ", ".join(repr(c) for c in option.choices)
        raise ValidationError(
            f"Invalid choice {converted!r} for --{option.cli_name}; expected {allowed}."
        )
    return converted


def _summary_from_docstring(target_fn: Any, explicit: str | None) -> str:
    if explicit is not None:
        return explicit.strip()
    doc = inspect.getdoc(target_fn)
    return doc.strip() if doc else ""


def tool(
    *,
    name: str | None = None,
    depends: tuple[str | TaskDefinition, ...] | list[str | TaskDefinition] = (),
    marks: tuple[str, ...] | list[str] = (),
    requires: tuple[str, ...] | list[str] = (),
    description: str | None = None,
) -> Callable[[Callable[..., Any]], TaskDefinition]:
    """Register a Python function as a Tasknest task."""

    def decorator(target_fn: Callable[..., Any]) -> TaskDefinition:
        if not callable(target_fn):
            raise ValidationError("@tool must decorate a callable function.")
        task_name = name if name is not None else str(getattr(target_fn, "__name__", "task"))
        takes_context, options = inspect_task_signature(target_fn, task_name)
        return TaskDefinition(
            callable_fn=target_fn,
            name=task_name,
            depends=tuple(depends),
            marks=tuple(marks),
            requires=tuple(requires),
            description=_summary_from_docstring(target_fn, description),
            takes_context=takes_context,
            options=options,
        )

    return decorator
