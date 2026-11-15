# tasknest

Python task runner with file-based `@tool` discovery, dependency graph planning, and typed CLI flags.

## Installation

```bash
pip install tasknest
```

Optional template support:

```bash
pip install "tasknest[skill]"
```

## Quickstart

Create `tasknest.toml`:

```toml
[[discovery.roots]]
path = "tools"
```

Create `tools/hello.py`:

```python
from tasknest import ToolContext, tool


@tool(description="Print a greeting.")
def hello(ctx: ToolContext, name: str = "world") -> None:
    print(f"Hello, {name}!")
```

List, validate, and run tasks:

```bash
tasknest ls
tasknest check
tasknest run hello --name Tasknest
```

## License

MIT — see [LICENSE](./LICENSE).
