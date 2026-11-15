import { performance } from "node:perf_hooks";
import type { RuntimeAdapter } from "@/src/adapter";
import type { AffectedContext } from "@/src/affected";
import { type CacheContext, type CacheMode, lookupCache, storeCache } from "@/src/cache";
import { ToolContext } from "@/src/context";
import type { TaskRegistry } from "@/src/discovery";
import { DependencyError, TasknestError } from "@/src/errors";
import type { TaskRunRecord } from "@/src/report";
import { createDefaultArgValues, isTaskDefinition, type TaskDefinition } from "@/src/task";

export interface ExecutionReport {
  readonly exitCode: number;
  readonly executed: readonly string[];
  readonly blocked: readonly string[];
  readonly cancelled: readonly string[];
  readonly failedTask?: string;
  readonly failureMessage?: string;
  readonly records: readonly TaskRunRecord[];
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly outputHashes: Readonly<Record<string, string>>;
  readonly cacheHits: readonly string[];
}

export interface ExecutePlanOptions {
  readonly targetValues?: Record<string, unknown>;
  readonly targetPositionals?: readonly string[];
  readonly verbose?: boolean;
  readonly adapter?: RuntimeAdapter;
  readonly jobs?: number;
  readonly failFast?: boolean;
  readonly cacheMode?: CacheMode;
  readonly affected?: AffectedContext;
  readonly quietStdout?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly seedOutputs?: Readonly<Record<string, unknown>>;
  readonly seedOutputHashes?: Readonly<Record<string, string>>;
  readonly stderrWriter?: (chunk: string) => void;
}

export function computeWorkerBudget(
  jobs: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const requested = Math.max(1, Math.trunc(jobs));
  const rawBudget = env.TASKNEST_WORKER_BUDGET;
  if (rawBudget === undefined || rawBudget.trim() === "") {
    return requested;
  }
  const parsed = Number.parseInt(rawBudget, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return requested;
  }
  return Math.min(requested, parsed);
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

interface ExecState {
  readonly registry: TaskRegistry;
  readonly options: ExecutePlanOptions;
  readonly target: string | undefined;
  readonly adjacency: Map<string, string[]>;
  readonly baseEnv: Record<string, string | undefined>;
  readonly outputs: Record<string, unknown>;
  readonly outputHashes: Record<string, string>;
  readonly succeeded: Set<string>;
  readonly failed: Set<string>;
  readonly executed: string[];
  readonly blocked: string[];
  readonly cancelled: string[];
  readonly cacheHits: string[];
  readonly recordByName: Map<string, TaskRunRecord>;
  failedTask: string | undefined;
  failureMessage: string | undefined;
  exitCode: number;
}

function buildTaskArgs(
  state: ExecState,
  name: string,
  def: TaskDefinition,
): { args: Record<string, unknown>; positionals: readonly string[] } {
  const isTarget = state.target !== undefined && name === state.target;
  const args =
    isTarget && state.options.targetValues
      ? state.options.targetValues
      : createDefaultArgValues(def);
  const positionals =
    isTarget && state.options.targetPositionals ? state.options.targetPositionals : [];
  return { args, positionals };
}

function buildCacheContext(
  state: ExecState,
  name: string,
  args: Record<string, unknown>,
  deps: readonly string[],
): CacheContext {
  const task = state.registry.tasks[name];
  if (!task) {
    throw new DependencyError(`Unknown task '${name}'.`);
  }
  const depHashes: Record<string, string> = {};
  for (const dep of deps) {
    const hash = state.outputHashes[dep];
    if (hash !== undefined) {
      depHashes[dep] = hash;
    }
  }
  return {
    repoRoot: state.registry.config.repoRoot,
    projectRoot: task.projectRoot,
    task: task.definition,
    kwargs: args,
    depHashes,
    baseEnv: state.baseEnv,
    mode: state.options.cacheMode ?? "default",
  };
}

async function runSingleTask(state: ExecState, name: string): Promise<void> {
  const task = state.registry.tasks[name];
  if (!task) {
    throw new DependencyError(`Unknown task '${name}'.`);
  }
  const deps = state.adjacency.get(name) ?? [];
  const { args, positionals } = buildTaskArgs(state, name, task.definition);
  const cacheCtx = buildCacheContext(state, name, args, deps);
  const lookup = lookupCache(cacheCtx);

  if (lookup.status === "hit") {
    state.cacheHits.push(name);
    state.succeeded.add(name);
    if (lookup.output !== undefined) {
      state.outputs[name] = lookup.output.value;
      state.outputHashes[name] = lookup.output.sha256;
    }
    state.recordByName.set(name, {
      name,
      status: "passed",
      cacheStatus: "hit",
      cacheReason: lookup.reason,
      durationMs: 0,
      ...(lookup.output !== undefined ? { outputHash: lookup.output.sha256 } : {}),
    });
    return;
  }

  const depsOutputs: Record<string, unknown> = {};
  for (const dep of deps) {
    if (dep in state.outputs) {
      depsOutputs[dep] = state.outputs[dep];
    }
  }
  const ctx = new ToolContext({
    repoRoot: state.registry.config.repoRoot,
    projectRoot: task.projectRoot,
    taskName: name,
    verbose: state.options.verbose ?? false,
    ...(state.options.adapter !== undefined ? { adapter: state.options.adapter } : {}),
    declaredDeps: deps,
    depsOutputs,
    env: state.baseEnv,
    ...(state.options.affected !== undefined ? { affected: state.options.affected } : {}),
    quietStdout: state.options.quietStdout ?? false,
    ...(state.options.stderrWriter !== undefined
      ? { stderrWriter: state.options.stderrWriter }
      : {}),
  });

  const started = performance.now();
  try {
    await task.definition.handler(ctx, args, positionals);
    const durationMs = performance.now() - started;
    const committed = ctx.commitOutput();
    const dynamicEnv: Record<string, string | null> = {};
    for (const key of ctx.accessedEnvKeys()) {
      dynamicEnv[key] = state.baseEnv[key] ?? null;
    }
    storeCache(cacheCtx, dynamicEnv, committed);
    state.executed.push(name);
    state.succeeded.add(name);
    if (committed !== undefined) {
      state.outputs[name] = committed.value;
      state.outputHashes[name] = committed.sha256;
    }
    state.recordByName.set(name, {
      name,
      status: "passed",
      cacheStatus: lookup.status,
      cacheReason: lookup.reason,
      durationMs,
      commands: ctx.recordedCommands(),
      ...(committed !== undefined ? { outputHash: committed.sha256 } : {}),
    });
  } catch (err) {
    const durationMs = performance.now() - started;
    const failureMessage = err instanceof Error ? err.message : String(err);
    const exitCode = err instanceof TasknestError ? err.exitCode : 1;
    state.failed.add(name);
    if (state.failedTask === undefined) {
      state.failedTask = name;
      state.failureMessage = failureMessage;
      state.exitCode = exitCode;
    }
    state.recordByName.set(name, {
      name,
      status: "failed",
      cacheStatus: lookup.status,
      cacheReason: lookup.reason,
      durationMs,
      commands: ctx.recordedCommands(),
      error: failureMessage,
    });
  }
}

function drainUnstarted(state: ExecState, pending: Set<string>): boolean {
  let progressed = false;
  for (const name of [...pending]) {
    const deps = state.adjacency.get(name) ?? [];
    const blockedByDep = deps.some(
      (dep) =>
        state.failed.has(dep) || state.blocked.includes(dep) || state.cancelled.includes(dep),
    );
    if (blockedByDep) {
      pending.delete(name);
      state.blocked.push(name);
      state.recordByName.set(name, {
        name,
        status: "blocked",
        error: "blocked by upstream failure",
      });
      progressed = true;
    } else if ((state.options.failFast ?? false) && state.failed.size > 0) {
      pending.delete(name);
      state.cancelled.push(name);
      state.recordByName.set(name, {
        name,
        status: "cancelled",
        error: "cancelled by --fail-fast",
      });
      progressed = true;
    }
  }
  return progressed;
}

export async function executeOrder(
  registry: TaskRegistry,
  order: readonly string[],
  options: ExecutePlanOptions = {},
  target?: string,
): Promise<ExecutionReport> {
  const adjacency = validateGraph(registry);
  const envSource = options.env ?? process.env;
  const baseEnv: Record<string, string | undefined> = { ...envSource };
  const workerBudget = computeWorkerBudget(options.jobs ?? 1, baseEnv);

  const state: ExecState = {
    registry,
    options,
    target,
    adjacency,
    baseEnv,
    outputs: { ...(options.seedOutputs ?? {}) },
    outputHashes: { ...(options.seedOutputHashes ?? {}) },
    succeeded: new Set<string>(Object.keys(options.seedOutputs ?? {})),
    failed: new Set<string>(),
    executed: [],
    blocked: [],
    cancelled: [],
    cacheHits: [],
    recordByName: new Map<string, TaskRunRecord>(),
    failedTask: undefined,
    failureMessage: undefined,
    exitCode: 0,
  };

  const pending = new Set<string>(order);
  const running = new Map<string, Promise<string>>();
  const activeResources = new Set<string>();

  const taskResources = (name: string): readonly string[] =>
    registry.tasks[name]?.definition.resources ?? [];

  while (pending.size > 0 || running.size > 0) {
    while (drainUnstarted(state, pending)) {
      // keep draining transitive downstream blocks
    }

    const ready = [...pending].filter((name) => {
      const deps = adjacency.get(name) ?? [];
      if (!deps.every((dep) => state.succeeded.has(dep))) {
        return false;
      }
      const res = taskResources(name);
      return !res.some((r) => activeResources.has(r));
    });

    while (running.size < workerBudget && ready.length > 0) {
      if ((options.failFast ?? false) && state.failed.size > 0) {
        break;
      }
      const next = ready.shift() as string;
      const res = taskResources(next);
      if (res.some((r) => activeResources.has(r))) {
        continue;
      }
      pending.delete(next);
      for (const r of res) {
        activeResources.add(r);
      }
      const promise = runSingleTask(state, next).then(() => next);
      running.set(next, promise);
    }

    if (running.size === 0) {
      if (pending.size > 0) {
        for (const leftover of [...pending]) {
          pending.delete(leftover);
          state.blocked.push(leftover);
          state.recordByName.set(leftover, {
            name: leftover,
            status: "blocked",
            error: "blocked by unresolvable upstream state",
          });
        }
      }
      break;
    }

    const completedName = await Promise.race(running.values());
    running.delete(completedName);
    for (const r of taskResources(completedName)) {
      activeResources.delete(r);
    }
  }

  const orderedRecords = order
    .map((name) => state.recordByName.get(name))
    .filter((rec): rec is TaskRunRecord => rec !== undefined);

  return {
    exitCode: state.exitCode,
    executed: state.executed,
    blocked: state.blocked,
    cancelled: state.cancelled,
    ...(state.failedTask !== undefined ? { failedTask: state.failedTask } : {}),
    ...(state.failureMessage !== undefined ? { failureMessage: state.failureMessage } : {}),
    records: orderedRecords,
    outputs: state.outputs,
    outputHashes: state.outputHashes,
    cacheHits: state.cacheHits,
  };
}

export async function executePlan(
  registry: TaskRegistry,
  target: string,
  options: ExecutePlanOptions = {},
): Promise<ExecutionReport> {
  const order = resolvePlan(registry, target);
  return executeOrder(registry, order, options, target);
}
