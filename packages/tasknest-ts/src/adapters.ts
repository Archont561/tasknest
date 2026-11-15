import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { CommandResult, RunOptions, ToolContext } from "@/src/context";
import { ToolError } from "@/src/errors";

export interface AffectedTestPlan {
  readonly targets: readonly string[];
  readonly fallbackReason?: string;
}

export function findExecutable(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (name.includes("/") || name.includes("\\")) {
    return existsSync(name) ? name : undefined;
  }
  const pathValue = env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function requireExecutable(name: string): string {
  const found = findExecutable(name);
  if (found === undefined) {
    throw new ToolError(
      `Required external executable '${name}' was not found on PATH; install it before running this task.`,
    );
  }
  return found;
}

export function selectAffectedTargets(
  changedFiles: readonly string[],
  mapping: Readonly<Record<string, readonly string[]>> | undefined,
  options: {
    readonly defaultTarget?: string;
    readonly alwaysFull?: readonly string[];
  } = {},
): AffectedTestPlan {
  const defaultTarget = options.defaultTarget ?? "tests";
  const alwaysFull = options.alwaysFull ?? ["package.json", "tsconfig.json", "bun.lock"];
  if (mapping === undefined) {
    return { targets: [defaultTarget], fallbackReason: "no source-to-test mapping provided" };
  }
  if (changedFiles.length === 0) {
    return { targets: [] };
  }
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const rel of changedFiles) {
    const norm = rel.replaceAll("\\", "/");
    if (alwaysFull.includes(norm)) {
      return { targets: [defaultTarget], fallbackReason: `global trigger changed: ${norm}` };
    }
    const mapped = mapping[norm];
    if (!mapped || mapped.length === 0) {
      return { targets: [defaultTarget], fallbackReason: `unmapped change: ${norm}` };
    }
    for (const target of mapped) {
      if (!seen.has(target)) {
        seen.add(target);
        selected.push(target);
      }
    }
  }
  return { targets: selected };
}

export abstract class ToolAdapter {
  abstract readonly executable: string;
  protected readonly ctx: ToolContext;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  checkAvailable(): string {
    return requireExecutable(this.executable);
  }

  exec(argv: readonly string[], options: RunOptions = {}): CommandResult {
    return this.ctx.run(argv, options);
  }
}

export class BunAdapter extends ToolAdapter {
  readonly executable = "bun";

  test(
    targets: readonly string[] = [],
    options: { readonly coverage?: boolean } = {},
  ): CommandResult {
    const exe = this.checkAvailable();
    const argv = [exe, "test", ...(options.coverage ? ["--coverage"] : []), ...targets];
    return this.exec(argv);
  }
}

export class NodeAdapter extends ToolAdapter {
  readonly executable = "node";

  test(targets: readonly string[] = []): CommandResult {
    const exe = this.checkAvailable();
    return this.exec([exe, "--test", ...targets]);
  }
}

export class RuffAdapter extends ToolAdapter {
  readonly executable = "ruff";

  check(paths: readonly string[] = ["."], options: { readonly fix?: boolean } = {}): CommandResult {
    const exe = this.checkAvailable();
    return this.exec([exe, "check", ...(options.fix ? ["--fix"] : []), ...paths]);
  }
}

export class PytestAdapter extends ToolAdapter {
  readonly executable = "pytest";

  run(targets: readonly string[] = [], options: RunOptions = {}): CommandResult {
    const exe = this.checkAvailable();
    return this.exec([exe, "-m", "pytest", ...targets], options);
  }

  runAffected(
    changedFiles: readonly string[],
    mapping?: Readonly<Record<string, readonly string[]>>,
    options: { readonly defaultTarget?: string; readonly capture?: boolean } = {},
  ): { readonly plan: AffectedTestPlan; readonly result?: CommandResult } {
    const plan = selectAffectedTargets(changedFiles, mapping, {
      ...(options.defaultTarget !== undefined ? { defaultTarget: options.defaultTarget } : {}),
      alwaysFull: ["pyproject.toml", "conftest.py", "tests/conftest.py"],
    });
    if (plan.targets.length === 0) {
      return { plan };
    }
    const result = this.run(
      plan.targets,
      options.capture !== undefined ? { capture: options.capture } : {},
    );
    return { plan, result };
  }
}
