import type { RuntimeAdapter } from "@/src/adapter";
import { ToolContext } from "@/src/context";
import type { TaskRegistry } from "@/src/discovery";
import { DependencyError } from "@/src/errors";
import { createDefaultArgValues, isTaskDefinition, type TaskDefinition } from "@/src/task";

export interface ExecutionReport {
  readonly exitCode: number;
  readonly executed: readonly string[];
  readonly blocked: readonly string[];
  readonly failedTask?: string;
  readonly failureMessage?: string;
}

export interface ExecutePlanOptions {
  readonly targetValues?: Record<string, unknown>;
  readonly targetPositionals?: readonly string[];
  readonly verbose?: boolean;
  readonly adapter?: RuntimeAdapter;
}

function resolveDependencyName(
  registry: TaskRegistry,
  ownerName: string,
  ref: string | TaskDefinition,
): string {
  if (typeof ref === "string") {
    if (!(ref in registry.tasks)) {
      throw new DependencyError(`Unknown dependency '${ref}' required by '${ownerName}'.`);
    }
    return ref;
  }
  if (isTaskDefinition(ref)) {
    for (const [name, task] of Object.entries(registry.tasks)) {
      if (task.definition === ref) {
        return name;
      }
    }
  }
  throw new DependencyError(`Unknown dependency '${ref.name}' required by '${ownerName}'.`);
}

function buildAdjacency(registry: TaskRegistry): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const [name, task] of Object.entries(registry.tasks)) {
    adjacency.set(
      name,
      task.definition.depends.map((dep) => resolveDependencyName(registry, name, dep)),
    );
  }
  return adjacency;
}

export function validateGraph(registry: TaskRegistry): Map<string, string[]> {
  const adjacency = buildAdjacency(registry);
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const dfs = (node: string): void => {
    state.set(node, 1);
    stack.push(node);
    for (const dep of adjacency.get(node) ?? []) {
      const depState = state.get(dep) ?? 0;
      if (depState === 1) {
        const idx = stack.indexOf(dep);
        const cycle = [...stack.slice(idx), dep].join(" -> ");
        throw new DependencyError(`Dependency cycle detected: ${cycle}`);
      }
      if (depState === 0) {
        dfs(dep);
      }
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const name of Object.keys(registry.tasks)) {
    if ((state.get(name) ?? 0) === 0) {
      dfs(name);
    }
  }
  return adjacency;
}

export function resolvePlan(registry: TaskRegistry, target: string): string[] {
  if (!(target in registry.tasks)) {
    throw new DependencyError(`Unknown task '${target}'.`);
  }
  const adjacency = validateGraph(registry);
  const visited = new Set<string>();
  const order: string[] = [];

  const visit = (node: string): void => {
    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    for (const dep of adjacency.get(node) ?? []) {
      visit(dep);
    }
    order.push(node);
  };
  visit(target);
  return order;
}

export async function executePlan(
  registry: TaskRegistry,
  target: string,
  options: ExecutePlanOptions = {},
): Promise<ExecutionReport> {
  const order = resolvePlan(registry, target);
  const executed: string[] = [];

  for (let idx = 0; idx < order.length; idx += 1) {
    const name = order[idx] as string;
    const task = registry.tasks[name];
    if (!task) {
      throw new DependencyError(`Unknown task '${name}'.`);
    }
    const ctx = new ToolContext({
      repoRoot: registry.config.repoRoot,
      projectRoot: task.projectRoot,
      taskName: name,
      verbose: options.verbose ?? false,
      ...(options.adapter !== undefined ? { adapter: options.adapter } : {}),
    });
    const isTarget = name === target;
    const args =
      isTarget && options.targetValues
        ? options.targetValues
        : createDefaultArgValues(task.definition);
    const positionals = isTarget && options.targetPositionals ? options.targetPositionals : [];

    try {
      await task.definition.handler(ctx, args, positionals);
      executed.push(name);
    } catch (err) {
      const failureMessage = err instanceof Error ? err.message : String(err);
      return {
        exitCode: 1,
        executed,
        blocked: order.slice(idx + 1),
        failedTask: name,
        failureMessage,
      };
    }
  }
  return {
    exitCode: 0,
    executed,
    blocked: [],
  };
}
