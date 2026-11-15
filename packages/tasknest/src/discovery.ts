import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createRuntimeAdapter, type RuntimeAdapter } from "@/src/adapter";
import { type DiscoveryRoot, loadConfig, type TasknestConfig } from "@/src/config";
import { DiscoveryError } from "@/src/errors";
import { collectTaskRegistrations, isTaskDefinition, type TaskDefinition } from "@/src/task";

const RESERVED_TOP_DIRS = new Set(["tests", "features"]);
const TASK_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs"]);

let importSequence = 0;

export interface DiscoveredTask {
  readonly canonicalName: string;
  readonly cliPath: readonly string[];
  readonly definition: TaskDefinition;
  readonly sourcePath: string;
  readonly projectRoot: string;
  readonly description: string;
}

export interface TaskRegistry {
  readonly config: TasknestConfig;
  readonly tasks: Readonly<Record<string, DiscoveredTask>>;
  resolveCliPath(
    tokens: readonly string[],
  ): readonly [DiscoveredTask, readonly string[]] | undefined;
}

export interface DiscoverOptions {
  readonly configPath?: string;
  readonly adapter?: RuntimeAdapter;
}

function isIgnoredEntry(name: string, isTopLevel: boolean): boolean {
  if (name.startsWith("_") || name === "node_modules" || name === "dist") {
    return true;
  }
  return isTopLevel && RESERVED_TOP_DIRS.has(name);
}

function isSupportedTaskFile(name: string): boolean {
  if (name.startsWith("_") || name.endsWith(".d.ts")) {
    return false;
  }
  return TASK_EXTENSIONS.has(extname(name));
}

function collectTaskFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }
  const files: string[] = [];
  const walk = (dir: string, isTopLevel: boolean): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (isIgnoredEntry(entry.name, isTopLevel)) {
        continue;
      }
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory() || (entry.isSymbolicLink() && statSync(fullPath).isDirectory())) {
        walk(fullPath, false);
      } else if (entry.isFile() && isSupportedTaskFile(entry.name)) {
        files.push(fullPath);
      }
    }
  };
  walk(rootDir, true);
  return files;
}

function deriveSegments(rootDir: string, filePath: string, namespace: string): string[] {
  const rel = relative(rootDir, filePath);
  const ext = extname(rel);
  const withoutExt = ext ? rel.slice(0, -ext.length) : rel;
  const relParts = withoutExt.split(sep).filter(Boolean);
  const nsParts = namespace ? namespace.split(".").filter(Boolean) : [];
  return [...nsParts, ...relParts];
}

async function loadSingleTaskFromFile(filePath: string): Promise<TaskDefinition> {
  const url = `${pathToFileURL(filePath).href}?t=${++importSequence}`;
  let mod: Record<string, unknown> = {};
  const collected = await collectTaskRegistrations(async () => {
    try {
      mod = (await import(url)) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof DiscoveryError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new DiscoveryError(`Failed importing task module ${filePath}: ${message}`);
    }
  });

  const exportedDefs = Object.values(mod).filter(isTaskDefinition);
  const uniqueDefs = exportedDefs.length > 0 ? Array.from(new Set(exportedDefs)) : collected;
  if (uniqueDefs.length !== 1) {
    throw new DiscoveryError(
      `Task file ${filePath} must register exactly one @tool (found ${uniqueDefs.length}).`,
    );
  }
  return uniqueDefs[0] as TaskDefinition;
}

export function createTaskRegistry(
  config: TasknestConfig,
  tasks: Record<string, DiscoveredTask>,
): TaskRegistry {
  const byCliPath = new Map<string, DiscoveredTask>();
  for (const task of Object.values(tasks)) {
    byCliPath.set(task.cliPath.join("\0"), task);
  }
  return {
    config,
    tasks,
    resolveCliPath(tokens: readonly string[]) {
      if (tokens.length === 1 && tokens[0]?.includes(".")) {
        const direct = tasks[tokens[0]];
        if (direct) {
          return [direct, []];
        }
      }
      for (let size = tokens.length; size > 0; size -= 1) {
        const key = tokens.slice(0, size).join("\0");
        const matched = byCliPath.get(key);
        if (matched) {
          return [matched, tokens.slice(size)];
        }
      }
      return undefined;
    },
  };
}

export async function discoverTasks(
  repoRoot: string,
  options: DiscoverOptions = {},
): Promise<TaskRegistry> {
  const adapter = options.adapter ?? createRuntimeAdapter();
  const config = loadConfig(repoRoot, {
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    adapter,
  });
  const tasks: Record<string, DiscoveredTask> = {};

  for (const rootEntry of config.roots) {
    await registerRootTasks(config.repoRoot, rootEntry, tasks);
  }
  return createTaskRegistry(config, tasks);
}

async function registerRootTasks(
  repoRoot: string,
  rootEntry: DiscoveryRoot,
  tasks: Record<string, DiscoveredTask>,
): Promise<void> {
  const rootDir = resolve(repoRoot, rootEntry.path);
  const projectRoot = resolve(repoRoot, rootEntry.projectRoot);
  for (const filePath of collectTaskFiles(rootDir)) {
    const segments = deriveSegments(rootDir, filePath, rootEntry.namespace);
    const canonicalName = segments.join(".");
    if (canonicalName in tasks) {
      throw new DiscoveryError(
        `Duplicate task name '${canonicalName}' from ${filePath} (already registered by ${tasks[canonicalName]?.sourcePath}).`,
      );
    }
    const definition = await loadSingleTaskFromFile(filePath);
    tasks[canonicalName] = {
      canonicalName,
      cliPath: segments,
      definition,
      sourcePath: filePath,
      projectRoot,
      description: definition.description,
    };
  }
}
