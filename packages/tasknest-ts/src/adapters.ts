import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  type AffectedContext,
  type AffectedTestPlan,
  type ChangedFile,
  selectConservativeTargets,
} from "@/src/affected";
import type { CommandResult, RunOptions, ToolContext } from "@/src/context";
import { ToolError } from "@/src/errors";

export type { AffectedTestPlan } from "@/src/affected";

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
  changes: AffectedContext | readonly (ChangedFile | string)[],
  mapping: Readonly<Record<string, readonly string[]>> | undefined,
  options: {
    readonly defaultTarget?: string;
    readonly alwaysFull?: readonly string[];
    readonly forceAll?: boolean;
    readonly strict?: boolean;
  } = {},
): AffectedTestPlan {
  return selectConservativeTargets(changes, mapping, {
    ...(options.defaultTarget !== undefined ? { defaultTarget: options.defaultTarget } : {}),
    alwaysFull: options.alwaysFull ?? ["package.json", "tsconfig.json", "bun.lock"],
    forceAll: options.forceAll ?? false,
    strict: options.strict ?? false,
  });
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
    options: { readonly coverage?: boolean; readonly forceAll?: boolean } = {},
  ): CommandResult {
    const exe = this.checkAvailable();
    const argv = [exe, "test", ...(options.coverage ? ["--coverage"] : []), ...targets];
    return this.exec(argv);
  }

  runAffected(
    changes: AffectedContext | readonly (ChangedFile | string)[],
    mapping?: Readonly<Record<string, readonly string[]>>,
    options: {
      readonly defaultTarget?: string;
      readonly forceAll?: boolean;
      readonly strict?: boolean;
      readonly capture?: boolean;
    } = {},
  ): { readonly plan: AffectedTestPlan; readonly result?: CommandResult } {
    const plan = selectAffectedTargets(changes, mapping, {
      defaultTarget: options.defaultTarget ?? "tests",
      alwaysFull: ["package.json", "tsconfig.json", "bun.lock"],
      forceAll: options.forceAll ?? false,
      strict: options.strict ?? false,
    });
    if (plan.targets.length === 0) {
      return { plan };
    }
    const exe = this.checkAvailable();
    const result = this.exec(
      [exe, "test", ...plan.targets],
      options.capture !== undefined ? { capture: options.capture } : {},
    );
    return { plan, result };
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
    changes: AffectedContext | readonly (ChangedFile | string)[],
    mapping?: Readonly<Record<string, readonly string[]>>,
    options: {
      readonly defaultTarget?: string;
      readonly forceAll?: boolean;
      readonly strict?: boolean;
      readonly capture?: boolean;
    } = {},
  ): { readonly plan: AffectedTestPlan; readonly result?: CommandResult } {
    const plan = selectAffectedTargets(changes, mapping, {
      ...(options.defaultTarget !== undefined ? { defaultTarget: options.defaultTarget } : {}),
      alwaysFull: ["pyproject.toml", "conftest.py", "tests/conftest.py"],
      forceAll: options.forceAll ?? false,
      strict: options.strict ?? false,
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
