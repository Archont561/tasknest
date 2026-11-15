import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { RuntimeAdapter } from "@/src/adapter";
import { findExecutable } from "@/src/adapters";
import type { ManifestRoot, TasknestConfig } from "@/src/config";
import type { DiscoveredTask } from "@/src/discovery";
import { ConfigError, DiscoveryError } from "@/src/errors";
import { type TaskDefinition, tool } from "@/src/task";

const IGNORED_DIRS = new Set(["node_modules", ".git", ".pixi", "dist", "out", ".next"]);

const LOCKFILE_RUNNERS: readonly (readonly [string, string])[] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

interface MetaSpec {
  readonly description: string;
  readonly depends: readonly string[];
  readonly marks: readonly string[];
  readonly requires: readonly string[];
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly cache: boolean;
  readonly persistent: boolean;
  readonly env: readonly string[];
  readonly resources: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isGlobPattern(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

function globSegmentToRegex(segment: string): RegExp {
  let out = "^";
  let idx = 0;
  while (idx < segment.length) {
    const ch = segment[idx] as string;
    if (ch === "*") {
      out += "[^/]*";
      idx += 1;
    } else if (ch === "?") {
      out += "[^/]";
      idx += 1;
    } else if (ch === "[") {
      const end = segment.indexOf("]", idx + 1);
      if (end === -1) {
        out += "\\[";
        idx += 1;
      } else {
        const body = segment.slice(idx + 1, end);
        out += body.startsWith("!") ? `[^${body.slice(1)}]` : `[${body}]`;
        idx = end + 1;
      }
    } else if ("\\^$.|+(){}".includes(ch)) {
      out += `\\${ch}`;
      idx += 1;
    } else {
      out += ch;
      idx += 1;
    }
  }
  out += "$";
  return new RegExp(out);
}

function listSubdirs(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => {
      if (IGNORED_DIRS.has(entry.name)) {
        return false;
      }
      if (entry.isDirectory()) {
        return true;
      }
      return entry.isSymbolicLink() && statSync(join(dir, entry.name)).isDirectory();
    })
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function expandGlobDirs(repoRoot: string, pattern: string): string[] {
  const parts = pattern.split(/[\\/]+/).filter((part) => part.length > 0 && part !== ".");
  let current: string[] = [repoRoot];
  for (const part of parts) {
    const next: string[] = [];
    if (part === "**") {
      const queue = [...current];
      const visited = new Set<string>(queue);
      while (queue.length > 0) {
        const dir = queue.shift() as string;
        next.push(dir);
        for (const sub of listSubdirs(dir)) {
          const child = join(dir, sub);
          if (!visited.has(child)) {
            visited.add(child);
            queue.push(child);
          }
        }
      }
    } else {
      const rx = globSegmentToRegex(part);
      for (const dir of current) {
        for (const sub of listSubdirs(dir)) {
          if (rx.test(sub)) {
            next.push(join(dir, sub));
          }
        }
      }
    }
    current = next;
  }
  return [...new Set(current)].sort((a, b) => a.localeCompare(b));
}

function readJsonTable(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Invalid JSON in ${path}: ${msg}`);
  }
  if (!isPlainObject(parsed)) {
    throw new ConfigError(`Manifest ${path} root must be a JSON object.`);
  }
  return parsed;
}

function readTomlTable(path: string, adapter: RuntimeAdapter): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = adapter.parseToml(readFileSync(path, "utf-8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Invalid TOML in ${path}: ${msg}`);
  }
  if (!isPlainObject(parsed)) {
    throw new ConfigError(`Manifest ${path} root must be a TOML table.`);
  }
  return parsed;
}

function expandWorkspaceEntries(config: TasknestConfig): readonly ManifestRoot[] {
  const entries = [...config.manifests];
  if (!config.workspaces) {
    return entries;
  }
  const pkgJsonPath = join(config.repoRoot, "package.json");
  if (!existsSync(pkgJsonPath)) {
    return entries;
  }
  const data = readJsonTable(pkgJsonPath);
  const rawWs = data.workspaces;
  let patterns: string[] = [];
  if (Array.isArray(rawWs)) {
    patterns = rawWs.filter((item): item is string => typeof item === "string" && item.length > 0);
  } else if (isPlainObject(rawWs) && Array.isArray(rawWs.packages)) {
    patterns = rawWs.packages.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
  }
  const seen = new Set(entries.map((e) => e.path));
  for (const pat of patterns) {
    if (!seen.has(pat)) {
      entries.push({
        path: pat,
        namespace: "",
        runner: "auto",
        persistentScripts: [],
        excludeScripts: [],
      });
      seen.add(pat);
    }
  }
  return entries;
}

function expandManifestDirs(repoRoot: string, entry: ManifestRoot): string[] {
  if (isGlobPattern(entry.path)) {
    return expandGlobDirs(repoRoot, entry.path);
  }
  const target = resolve(repoRoot, entry.path);
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new DiscoveryError(`Configured manifest path does not exist: ${target}`);
  }
  return [target];
}

function detectJsRunner(pkgDir: string, repoRoot: string, configured: string): string {
  if (configured !== "auto") {
    return configured;
  }
  for (const base of [pkgDir, repoRoot]) {
    for (const [lockName, runner] of LOCKFILE_RUNNERS) {
      if (existsSync(join(base, lockName))) {
        return runner;
      }
    }
  }
  return findExecutable("bun") ? "bun" : "npm";
}

function asStrArray(raw: unknown, label: string, source: string): readonly string[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new ConfigError(`${label} in ${source} must be a list of non-empty strings.`);
  }
  return [...raw];
}

function asBool(raw: unknown, fallback: boolean, label: string, source: string): boolean {
  if (raw === undefined) {
    return fallback;
  }
  if (typeof raw !== "boolean") {
    throw new ConfigError(`${label} in ${source} must be a boolean.`);
  }
  return raw;
}

function parseMeta(
  rawMeta: Record<string, unknown>,
  defaultDesc: string,
  defaultPersistent: boolean,
  source: string,
): MetaSpec {
  const rawDesc = rawMeta.description;
  if (rawDesc !== undefined && typeof rawDesc !== "string") {
    throw new ConfigError(`description in ${source} must be a string.`);
  }
  const desc = typeof rawDesc === "string" && rawDesc.trim() ? rawDesc.trim() : defaultDesc;
  return {
    description: desc,
    depends: asStrArray(rawMeta.depends, "depends", source),
    marks: asStrArray(rawMeta.marks, "marks", source),
    requires: asStrArray(rawMeta.requires, "requires", source),
    inputs: asStrArray(rawMeta.inputs, "inputs", source),
    outputs: asStrArray(rawMeta.outputs, "outputs", source),
    cache: asBool(rawMeta.cache, false, "cache", source),
    persistent: asBool(rawMeta.persistent, defaultPersistent, "persistent", source),
    env: asStrArray(rawMeta.env, "env", source),
    resources: asStrArray(rawMeta.resources, "resources", source),
  };
}

function resolvePackageId(
  pkgDir: string,
  repoRoot: string,
  entry: ManifestRoot,
  customNs: unknown,
): readonly [readonly string[], string] {
  const nsParts = entry.namespace.split(".").filter(Boolean);
  let pkgSeg: string;
  if (typeof customNs === "string" && customNs.trim()) {
    pkgSeg = customNs.trim().replace(/^\.+|\.+$/g, "");
  } else if (pkgDir === repoRoot) {
    pkgSeg = "root";
  } else {
    pkgSeg = basename(pkgDir);
  }
  const parts = [...nsParts, ...pkgSeg.split(".").filter(Boolean)];
  return [parts, parts.join(".")];
}

function makeCmdTask(opts: {
  readonly argv: readonly string[];
  readonly meta: MetaSpec;
  readonly canonicalName: string;
  readonly cliPath: readonly string[];
  readonly packageName: string;
  readonly sourcePath: string;
  readonly pkgDir: string;
}): DiscoveredTask {
  const definition: TaskDefinition = tool(
    {
      name: opts.canonicalName,
      depends: opts.meta.depends,
      marks: opts.meta.marks,
      requires: opts.meta.requires,
      description: opts.meta.description,
      inputs: opts.meta.inputs,
      outputs: opts.meta.outputs,
      cache: opts.meta.cache,
      persistent: opts.meta.persistent,
      env: opts.meta.env,
      resources: opts.meta.resources,
    },
    (ctx) => {
      ctx.run(opts.argv);
    },
  );
  return {
    canonicalName: opts.canonicalName,
    cliPath: opts.cliPath,
    definition,
    sourcePath: opts.sourcePath,
    rootDir: opts.pkgDir,
    projectRoot: opts.pkgDir,
    description: opts.meta.description,
    packageName: opts.packageName,
    isManifest: true,
  };
}

function collectPackageJsonTasks(
  pkgDir: string,
  repoRoot: string,
  entry: ManifestRoot,
  pkgTasks: Record<string, DiscoveredTask>,
): void {
  const manifestPath = join(pkgDir, "package.json");
  if (!existsSync(manifestPath)) {
    return;
  }
  const data = readJsonTable(manifestPath);
  const scripts = data.scripts ?? {};
  if (!isPlainObject(scripts)) {
    throw new ConfigError(`'scripts' in ${manifestPath} must be an object.`);
  }
  const tn = data.tasknest ?? {};
  if (!isPlainObject(tn)) {
    throw new ConfigError(`'tasknest' in ${manifestPath} must be an object.`);
  }
  const tnTasks = tn.tasks ?? {};
  if (!isPlainObject(tnTasks)) {
    throw new ConfigError(`'tasknest.tasks' in ${manifestPath} must be an object.`);
  }
  const configuredRunner = typeof tn.runner === "string" && tn.runner ? tn.runner : entry.runner;
  const runner = detectJsRunner(pkgDir, repoRoot, configuredRunner);
  const [pkgParts, pkgId] = resolvePackageId(pkgDir, repoRoot, entry, tn.namespace);
  const relDir = pkgDir === repoRoot ? "." : relative(repoRoot, pkgDir);
  const excluded = new Set(entry.excludeScripts);

  const scriptNames = Object.keys(scripts).filter((name) => !excluded.has(name));
  const extraNames = Object.keys(tnTasks).filter(
    (name) => !(name in scripts) && !excluded.has(name),
  );

  for (const name of [...scriptNames, ...extraNames]) {
    const rawMeta = tnTasks[name] ?? {};
    if (!isPlainObject(rawMeta)) {
      throw new ConfigError(`tasknest.tasks.${name} in ${manifestPath} must be an object.`);
    }
    const customCmd = rawMeta.cmd;
    let argv: readonly string[];
    if (customCmd !== undefined) {
      argv = asStrArray(customCmd, `tasknest.tasks.${name}.cmd`, manifestPath);
      if (argv.length === 0) {
        throw new ConfigError(`tasknest.tasks.${name}.cmd in ${manifestPath} cannot be empty.`);
      }
    } else {
      argv = [runner, "run", name];
    }
    const meta = parseMeta(
      rawMeta,
      `Run package.json script '${name}' in ${relDir}.`,
      entry.persistentScripts.includes(name),
      manifestPath,
    );
    const cliPath = [...pkgParts, name];
    const canonicalName = cliPath.join(".");
    pkgTasks[canonicalName] = makeCmdTask({
      argv,
      meta,
      canonicalName,
      cliPath,
      packageName: pkgId,
      sourcePath: manifestPath,
      pkgDir,
    });
  }
}

function collectPyprojectTasks(
  pkgDir: string,
  repoRoot: string,
  entry: ManifestRoot,
  adapter: RuntimeAdapter,
  pkgTasks: Record<string, DiscoveredTask>,
): void {
  const manifestPath = join(pkgDir, "pyproject.toml");
  if (!existsSync(manifestPath)) {
    return;
  }
  const data = readTomlTable(manifestPath, adapter);
  const toolTbl = data.tool;
  if (!isPlainObject(toolTbl)) {
    return;
  }
  const tn = toolTbl.tasknest;
  if (tn === undefined) {
    return;
  }
  if (!isPlainObject(tn)) {
    throw new ConfigError(`[tool.tasknest] in ${manifestPath} must be a table.`);
  }
  const rawTasks = tn.tasks ?? {};
  if (!isPlainObject(rawTasks)) {
    throw new ConfigError(`[tool.tasknest.tasks] in ${manifestPath} must be a table.`);
  }
  const [pkgParts, pkgId] = resolvePackageId(pkgDir, repoRoot, entry, tn.namespace);
  const relDir = pkgDir === repoRoot ? "." : relative(repoRoot, pkgDir);
  const excluded = new Set(entry.excludeScripts);

  for (const [name, spec] of Object.entries(rawTasks)) {
    if (excluded.has(name)) {
      continue;
    }
    let argv: readonly string[];
    let rawMeta: Record<string, unknown>;
    if (Array.isArray(spec)) {
      argv = asStrArray(spec, `[tool.tasknest.tasks.${name}]`, manifestPath);
      rawMeta = {};
    } else if (isPlainObject(spec)) {
      argv = asStrArray(spec.cmd, `[tool.tasknest.tasks.${name}].cmd`, manifestPath);
      rawMeta = spec;
    } else {
      throw new ConfigError(
        `[tool.tasknest.tasks.${name}] in ${manifestPath} must be array or table.`,
      );
    }
    if (argv.length === 0) {
      throw new ConfigError(
        `[tool.tasknest.tasks.${name}] in ${manifestPath} requires non-empty cmd.`,
      );
    }
    const meta = parseMeta(
      rawMeta,
      `Run pyproject.toml task '${name}' in ${relDir}.`,
      entry.persistentScripts.includes(name),
      manifestPath,
    );
    const cliPath = [...pkgParts, name];
    const canonicalName = cliPath.join(".");
    if (canonicalName in pkgTasks) {
      throw new DiscoveryError(
        `Duplicate manifest task name '${canonicalName}' found in ${manifestPath}.`,
      );
    }
    pkgTasks[canonicalName] = makeCmdTask({
      argv,
      meta,
      canonicalName,
      cliPath,
      packageName: pkgId,
      sourcePath: manifestPath,
      pkgDir,
    });
  }
}

function resolveRelativeDeps(pkgTasks: Record<string, DiscoveredTask>): void {
  for (const [canonical, task] of Object.entries(pkgTasks)) {
    if (task.definition.depends.length === 0 || !task.packageName) {
      continue;
    }
    const updatedDeps = task.definition.depends.map((dep) => {
      if (typeof dep === "string" && !dep.includes(".")) {
        const candidate = `${task.packageName}.${dep}`;
        return candidate in pkgTasks ? candidate : dep;
      }
      return dep;
    });
    pkgTasks[canonical] = {
      ...task,
      definition: {
        ...task.definition,
        depends: updatedDeps,
      },
    };
  }
}

export function discoverManifestTasks(
  config: TasknestConfig,
  tasks: Record<string, DiscoveredTask>,
  adapter: RuntimeAdapter,
): void {
  for (const entry of expandWorkspaceEntries(config)) {
    for (const pkgDir of expandManifestDirs(config.repoRoot, entry)) {
      const pkgTasks: Record<string, DiscoveredTask> = {};
      collectPackageJsonTasks(pkgDir, config.repoRoot, entry, pkgTasks);
      collectPyprojectTasks(pkgDir, config.repoRoot, entry, adapter, pkgTasks);
      resolveRelativeDeps(pkgTasks);
      for (const [canonical, task] of Object.entries(pkgTasks)) {
        if (canonical in tasks) {
          throw new DiscoveryError(
            `Duplicate manifest task name '${canonical}' found in ${task.sourcePath}.`,
          );
        }
        tasks[canonical] = task;
      }
    }
  }
}
