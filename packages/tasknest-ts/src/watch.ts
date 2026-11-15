import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createRuntimeAdapter, type RuntimeAdapter, type WatchHandle } from "@/src/adapter";
import { expandInputHashes } from "@/src/cache";
import type { TaskRegistry } from "@/src/discovery";
import { ValidationError } from "@/src/errors";
import { type ExecutionReport, executeOrder, resolvePlan, validateGraph } from "@/src/graph";

export interface WatchConfig {
  readonly debounceMs?: number;
  readonly pollIntervalMs?: number;
  readonly jobs?: number;
  readonly failFast?: boolean;
  readonly verbose?: boolean;
  readonly useFsWatch?: boolean;
}

export interface WatchCycle {
  readonly changedFiles: readonly string[];
  readonly executed: readonly string[];
  readonly skippedClean: readonly string[];
  readonly report: ExecutionReport;
}

function normalizePath(base: string, full: string): string {
  return relative(base, full).replaceAll("\\", "/");
}

function globToRegExp(pattern: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          regex += "(?:.*/)?";
          i += 3;
          continue;
        }
        regex += ".*";
        i += 2;
        continue;
      }
      regex += "[^/]*";
    } else if (ch === "?") {
      regex += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      regex += `\\${ch}`;
    } else {
      regex += ch;
    }
    i += 1;
  }
  regex += "$";
  return new RegExp(regex);
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function scanSnapshot(
  repoRoot: string,
  registry: TaskRegistry,
  order: readonly string[],
): Map<string, string> {
  const snapshot = new Map<string, string>();
  const outputDirsOrFiles = new Set<string>();
  for (const name of order) {
    const task = registry.tasks[name];
    if (!task) {
      continue;
    }
    for (const outRel of task.definition.outputs) {
      const fullOut = join(task.projectRoot, outRel);
      outputDirsOrFiles.add(normalizePath(repoRoot, fullOut));
    }
  }

  for (const name of order) {
    const task = registry.tasks[name];
    if (!task) {
      continue;
    }
    for (const [relFromProj, digest] of expandInputHashes(
      task.projectRoot,
      task.definition.inputs,
    )) {
      if (relFromProj.startsWith("missing:")) {
        continue;
      }
      const relFromRepo = normalizePath(repoRoot, join(task.projectRoot, relFromProj));
      if (relFromRepo === ".tasknest" || relFromRepo.startsWith(".tasknest/")) {
        continue;
      }
      if (
        [...outputDirsOrFiles].some((o) => relFromRepo === o || relFromRepo.startsWith(`${o}/`))
      ) {
        continue;
      }
      snapshot.set(relFromRepo, digest);
    }
  }

  if (snapshot.size === 0) {
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === ".tasknest" || entry === ".git" || entry === "node_modules") {
          continue;
        }
        const full = join(dir, entry);
        const rel = normalizePath(repoRoot, full);
        if ([...outputDirsOrFiles].some((o) => rel === o || rel.startsWith(`${o}/`))) {
          continue;
        }
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (stat.isFile()) {
          snapshot.set(rel, sha256File(full));
        }
      }
    };
    if (existsSync(repoRoot)) {
      walk(repoRoot);
    }
  }

  return snapshot;
}

function diffSnapshots(prev: Map<string, string>, next: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [k, v] of next.entries()) {
    if (prev.get(k) !== v) {
      changed.add(k);
    }
  }
  for (const k of prev.keys()) {
    if (!next.has(k)) {
      changed.add(k);
    }
  }
  return [...changed].sort();
}

function taskMatchesChanged(
  repoRoot: string,
  taskRoot: string,
  inputs: readonly string[],
  outputs: readonly string[],
  changedFiles: readonly string[],
): boolean {
  const outputRelSet = new Set(outputs.map((o) => normalizePath(repoRoot, join(taskRoot, o))));
  const filtered = changedFiles.filter(
    (f) => ![...outputRelSet].some((o) => f === o || f.startsWith(`${o}/`)),
  );
  if (filtered.length === 0) {
    return false;
  }
  if (inputs.length === 0) {
    return true;
  }
  for (const rawPattern of inputs) {
    const patternRel = normalizePath(repoRoot, join(taskRoot, rawPattern));
    const re = globToRegExp(patternRel);
    for (const file of filtered) {
      if (re.test(file) || file === patternRel || file.startsWith(`${patternRel}/`)) {
        return true;
      }
    }
  }
  return false;
}

export class WatchSession {
  readonly registry: TaskRegistry;
  readonly target: string;
  readonly config: Required<WatchConfig>;
  readonly adapter: RuntimeAdapter;
  readonly order: readonly string[];
  private readonly adjacency: Map<string, string[]>;
  private snapshot: Map<string, string>;
  private lastOutputs: Record<string, unknown> = {};
  private lastOutputHashes: Record<string, string> = {};
  private handles: WatchHandle[] = [];

  constructor(
    registry: TaskRegistry,
    target: string,
    config: WatchConfig = {},
    adapter?: RuntimeAdapter,
  ) {
    this.registry = registry;
    this.target = target;
    this.config = {
      debounceMs: config.debounceMs ?? 150,
      pollIntervalMs: config.pollIntervalMs ?? 200,
      jobs: config.jobs ?? 1,
      failFast: config.failFast ?? false,
      verbose: config.verbose ?? false,
      useFsWatch: config.useFsWatch ?? true,
    };
    this.adapter = adapter ?? createRuntimeAdapter();
    this.adjacency = validateGraph(registry);
    this.order = resolvePlan(registry, target);
    for (const name of this.order) {
      if (registry.tasks[name]?.definition.persistent) {
        throw new ValidationError(
          `Cannot use 'watch' on persistent task '${name}'; run it directly instead.`,
        );
      }
    }
    this.snapshot = scanSnapshot(registry.config.repoRoot, registry, this.order);
  }

  async runInitial(): Promise<WatchCycle> {
    const report = await executeOrder(
      this.registry,
      this.order,
      {
        jobs: this.config.jobs,
        failFast: this.config.failFast,
        verbose: this.config.verbose,
        adapter: this.adapter,
      },
      this.target,
    );
    this.lastOutputs = { ...report.outputs };
    this.lastOutputHashes = { ...report.outputHashes };
    this.snapshot = scanSnapshot(this.registry.config.repoRoot, this.registry, this.order);
    return {
      changedFiles: [],
      executed: report.executed,
      skippedClean: [],
      report,
    };
  }

  pollChanges(): string[] {
    const nextSnapshot = scanSnapshot(this.registry.config.repoRoot, this.registry, this.order);
    const changed = diffSnapshots(this.snapshot, nextSnapshot);
    if (changed.length > 0) {
      this.snapshot = nextSnapshot;
    }
    return changed;
  }

  async step(changedFiles?: readonly string[]): Promise<WatchCycle | undefined> {
    const detected = changedFiles !== undefined ? [...changedFiles] : this.pollChanges();
    if (detected.length === 0) {
      return undefined;
    }

    const dirty = new Set<string>();
    const seedOutputs: Record<string, unknown> = {};
    const seedOutputHashes: Record<string, string> = {};
    const subOrder: string[] = [];
    const skippedClean: string[] = [];

    for (const name of this.order) {
      const task = this.registry.tasks[name];
      if (!task) {
        continue;
      }
      const deps = this.adjacency.get(name) ?? [];
      const depDirty = deps.some((dep) => dirty.has(dep));
      const inputDirty = taskMatchesChanged(
        this.registry.config.repoRoot,
        task.projectRoot,
        task.definition.inputs,
        task.definition.outputs,
        detected,
      );
      if (depDirty || inputDirty) {
        dirty.add(name);
        subOrder.push(name);
      } else {
        skippedClean.push(name);
        if (name in this.lastOutputs) {
          seedOutputs[name] = this.lastOutputs[name];
        }
        const savedHash = this.lastOutputHashes[name];
        if (savedHash !== undefined) {
          seedOutputHashes[name] = savedHash;
        }
      }
    }

    if (subOrder.length === 0) {
      return {
        changedFiles: detected,
        executed: [],
        skippedClean,
        report: {
          exitCode: 0,
          executed: [],
          blocked: [],
          cancelled: [],
          records: [],
          outputs: this.lastOutputs,
          outputHashes: this.lastOutputHashes,
          cacheHits: [],
        },
      };
    }

    const report = await executeOrder(
      this.registry,
      subOrder,
      {
        jobs: this.config.jobs,
        failFast: this.config.failFast,
        verbose: this.config.verbose,
        adapter: this.adapter,
        seedOutputs,
        seedOutputHashes,
      },
      this.target,
    );
    this.lastOutputs = { ...this.lastOutputs, ...report.outputs };
    this.lastOutputHashes = { ...this.lastOutputHashes, ...report.outputHashes };
    this.snapshot = scanSnapshot(this.registry.config.repoRoot, this.registry, this.order);
    return {
      changedFiles: detected,
      executed: report.executed,
      skippedClean,
      report,
    };
  }

  startWatchers(onEvent: (filename: string | null) => void): void {
    this.stopWatchers();
    if (!this.config.useFsWatch) {
      return;
    }
    const dirs = new Set<string>([this.registry.config.repoRoot]);
    for (const name of this.order) {
      const task = this.registry.tasks[name];
      if (!task) {
        continue;
      }
      dirs.add(task.projectRoot);
      for (const input of task.definition.inputs) {
        const candidate = join(task.projectRoot, input);
        if (existsSync(candidate)) {
          dirs.add(statSync(candidate).isDirectory() ? candidate : dirname(candidate));
        }
      }
    }
    for (const dir of dirs) {
      if (existsSync(dir)) {
        try {
          this.handles.push(this.adapter.watchPath(dir, onEvent));
        } catch {
          // Fallback to polling when fs.watch is unavailable on a directory
        }
      }
    }
  }

  stopWatchers(): void {
    for (const handle of this.handles) {
      try {
        handle.close();
      } catch {
        // ignore close errors
      }
    }
    this.handles = [];
  }

  async watch(
    options: {
      readonly maxCycles?: number;
      readonly signal?: AbortSignal;
      readonly onCycle?: (cycle: WatchCycle) => void;
    } = {},
  ): Promise<WatchCycle[]> {
    const cycles: WatchCycle[] = [];
    const initial = await this.runInitial();
    cycles.push(initial);
    options.onCycle?.(initial);

    let fsTriggered = false;
    let lastEventAt = 0;
    this.startWatchers((filename) => {
      if (filename?.includes(".tasknest")) {
        return;
      }
      fsTriggered = true;
      lastEventAt = Date.now();
    });

    try {
      while (!options.signal?.aborted) {
        if (options.maxCycles !== undefined && cycles.length >= options.maxCycles) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, this.config.pollIntervalMs));
        if (options.signal?.aborted) {
          break;
        }
        if (fsTriggered && Date.now() - lastEventAt < this.config.debounceMs) {
          continue;
        }
        fsTriggered = false;
        const cycle = await this.step();
        if (cycle !== undefined) {
          cycles.push(cycle);
          options.onCycle?.(cycle);
        }
      }
    } finally {
      this.stopWatchers();
    }
    return cycles;
  }
}
