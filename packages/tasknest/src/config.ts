import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createRuntimeAdapter, type RuntimeAdapter } from "@/src/adapter";
import { ConfigError } from "@/src/errors";

export const DEFAULT_CONFIG_NAME = "tasknest.toml";

export interface DiscoveryRoot {
  readonly path: string;
  readonly namespace: string;
  readonly projectRoot: string;
}

export interface TasknestConfig {
  readonly repoRoot: string;
  readonly roots: readonly DiscoveryRoot[];
  readonly marks: Readonly<Record<string, string>>;
  readonly jobs: number;
}

export interface LoadConfigOptions {
  readonly configPath?: string;
  readonly adapter?: RuntimeAdapter;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(entry: Record<string, unknown>, field: string, fallback?: string): string {
  const value = entry[field] ?? fallback;
  if (typeof value !== "string") {
    throw new ConfigError(`[[discovery.roots]] field '${field}' must be a string.`);
  }
  return value;
}

function parseRoot(entry: unknown): DiscoveryRoot {
  if (!isPlainObject(entry) || !("path" in entry)) {
    throw new ConfigError("Each [[discovery.roots]] entry must be a table with a 'path'.");
  }
  const rawPath = requireString(entry, "path");
  const rawNamespace = requireString(entry, "namespace", "");
  const rawProjectRoot = requireString(entry, "project_root", ".");
  return {
    path: rawPath,
    namespace: rawNamespace.replace(/^\.+|\.+$/g, ""),
    projectRoot: rawProjectRoot,
  };
}

function parseRoots(raw: Record<string, unknown>): readonly DiscoveryRoot[] {
  const discovery = raw.discovery;
  if (discovery === undefined) {
    return [{ path: "tools", namespace: "", projectRoot: "." }];
  }
  if (!isPlainObject(discovery)) {
    throw new ConfigError("[discovery] must be a table.");
  }
  const roots = discovery.roots;
  if (roots === undefined) {
    return [{ path: "tools", namespace: "", projectRoot: "." }];
  }
  if (!Array.isArray(roots)) {
    throw new ConfigError("[[discovery.roots]] must be an array of tables.");
  }
  return roots.map(parseRoot);
}

function parseMarks(rawMarks: unknown): Record<string, string> {
  if (rawMarks === undefined) {
    return {};
  }
  if (!isPlainObject(rawMarks)) {
    throw new ConfigError("[marks] must be a table.");
  }
  const marks: Record<string, string> = {};
  for (const [key, desc] of Object.entries(rawMarks)) {
    if (typeof desc !== "string") {
      throw new ConfigError("[marks] values must map mark names to string descriptions.");
    }
    marks[key] = desc;
  }
  return marks;
}

function parseJobs(raw: Record<string, unknown>): number {
  const execution = raw.execution;
  if (execution === undefined) {
    return 1;
  }
  if (!isPlainObject(execution)) {
    throw new ConfigError("[execution] must be a table.");
  }
  const jobs = execution.jobs ?? 1;
  if (typeof jobs !== "number" || !Number.isInteger(jobs) || jobs < 1) {
    throw new ConfigError("[execution].jobs must be a positive integer.");
  }
  return jobs;
}

function resolveTarget(resolvedRoot: string, configPath?: string): string | undefined {
  if (configPath === undefined) {
    const candidate = join(resolvedRoot, DEFAULT_CONFIG_NAME);
    return existsSync(candidate) ? candidate : undefined;
  }
  const target = isAbsolute(configPath) ? configPath : resolve(resolvedRoot, configPath);
  if (!existsSync(target)) {
    throw new ConfigError(`Configuration file not found: ${target}`);
  }
  return target;
}

export function loadConfig(repoRoot: string, options: LoadConfigOptions = {}): TasknestConfig {
  const resolvedRoot = resolve(repoRoot);
  const target = resolveTarget(resolvedRoot, options.configPath);
  if (target === undefined) {
    return {
      repoRoot: resolvedRoot,
      roots: [{ path: "tools", namespace: "", projectRoot: "." }],
      marks: {},
      jobs: 1,
    };
  }
  const adapter = options.adapter ?? createRuntimeAdapter();
  const raw = adapter.parseToml(readFileSync(target, "utf-8"));
  return {
    repoRoot: resolvedRoot,
    roots: parseRoots(raw),
    marks: parseMarks(raw.marks),
    jobs: parseJobs(raw),
  };
}
