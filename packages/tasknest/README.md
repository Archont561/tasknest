# @archont561/tasknest

Native TypeScript task runner for Bun and Node.js with file-based `tool()` discovery, dependency graph planning, and typed CLI flags.

## Installation

```bash
bun add @archont561/tasknest
# or
npm install @archont561/tasknest
```

## Quickstart

Create `tasknest.toml`:

```toml
[[discovery.roots]]
path = "tools"
```

Create `tools/hello.ts`:

```ts
import { type ToolContext, tool } from "@archont561/tasknest";

export const hello = tool(
  {
    description: "Print a greeting.",
    options: {
      name: { type: "string", default: "world" },
    },
  },
  async (_ctx: ToolContext, args) => {
    console.log(`Hello, ${args.name}!`);
  },
);
```

List, validate, and run tasks:

```bash
tasknest ls
tasknest check
tasknest run hello --name Tasknest
```

## License

MIT — see [LICENSE](./LICENSE).
