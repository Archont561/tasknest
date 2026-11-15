import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createRuntimeAdapter, type RuntimeAdapter } from "@/src/adapter";
import { ConfigError } from "@/src/errors";

export const DEFAULT_CONFIG_NAME = "tasknest.toml";

export type UnknownMarkMode = "ignore" | "warn" | "error";

export interface ChecksConfig {
  readonly strict: boolean;
  readonly requireDescription: boolean;
  readonly requireTests: boolean;
  readonly requireFeatures: boolean;
  readonly unknownMarks: UnknownMarkMode;
}

export interface SkillConfig {
  readonly output: string;
  readonly command: string;
  readonly template?: string;
}

export interface DiscoveryRoot {
  readonly path: string;
  readonly namespace: string;
  readonly projectRoot: string;
}

export interface ManifestRoot {
  readonly path: string;
  readonly namespace: string;
  readonly runner: string;
  readonly persistentScripts: readonly string[];
  readonly excludeScripts: readonly string[];
}

export interface TasknestConfig {
  readonly repoRoot: string;
  readonly roots: readonly DiscoveryRoot[];
  readonly manifests: readonly ManifestRoot[];
  readonly workspaces: boolean;
  readonly marks: Readonly<Record<string, string>>;
  readonly jobs: number;
  readonly checks: ChecksConfig;
  readonly skill: SkillConfig;
}

const DEFAULT_CHECKS: ChecksConfig = {
  strict: false,
  requireDescription: false,
  requireTests: false,
  requireFeatures: false,
  unknownMarks: "ignore",
};

const DEFAULT_SKILL: SkillConfig = {
  output: ".agents/skills/project-tools/SKILL.md",
  command: "tasknest",
};

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

function requireStrList(
  entry: Record<string, unknown>,
  field: string,
  label: string,
): readonly string[] {
  const value = entry[field];
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new ConfigError(`${label} field '${field}' must be a list of non-empty strings.`);
  }
  return [...value];
}

function parseManifest(entry: unknown): ManifestRoot {
  if (!isPlainObject(entry) || !("path" in entry)) {
    throw new ConfigError("Each [[discovery.manifests]] entry must be a table with a 'path'.");
  }
  const rawPath = entry.path;
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new ConfigError("[[discovery.manifests]] field 'path' must be a non-empty string.");
  }
  const rawNamespace = entry.namespace ?? "";
  if (typeof rawNamespace !== "string") {
    throw new ConfigError("[[discovery.manifests]] field 'namespace' must be a string.");
  }
  const rawRunner = entry.runner ?? "auto";
  if (typeof rawRunner !== "string" || rawRunner.length === 0) {
    throw new ConfigError("[[discovery.manifests]] field 'runner' must be a non-empty string.");
  }
  return {
    path: rawPath,
    namespace: rawNamespace.replace(/^\.+|\.+$/g, ""),
    runner: rawRunner,
    persistentScripts: requireStrList(entry, "persistent_scripts", "[[discovery.manifests]]"),
    excludeScripts: requireStrList(entry, "exclude_scripts", "[[discovery.manifests]]"),
  };
}

function parseDiscovery(raw: Record<string, unknown>): {
  readonly roots: readonly DiscoveryRoot[];
  readonly manifests: readonly ManifestRoot[];
  readonly workspaces: boolean;
} {
  const discovery = raw.discovery;
  if (discovery === undefined) {
    return {
      roots: [{ path: "tools", namespace: "", projectRoot: "." }],
      manifests: [],
      workspaces: false,
    };
  }
  if (!isPlainObject(discovery)) {
    throw new ConfigError("[discovery] must be a table.");
  }
  const roots = discovery.roots;
  let parsedRoots: readonly DiscoveryRoot[];
  if (roots === undefined) {
    parsedRoots = [{ path: "tools", namespace: "", projectRoot: "." }];
  } else if (!Array.isArray(roots)) {
    throw new ConfigError("[[discovery.roots]] must be an array of tables.");
  } else {
    parsedRoots = roots.map(parseRoot);
  }
  const manifests = discovery.manifests;
  let parsedManifests: readonly ManifestRoot[];
  if (manifests === undefined) {
    parsedManifests = [];
  } else if (!Array.isArray(manifests)) {
    throw new ConfigError("[[discovery.manifests]] must be an array of tables.");
  } else {
    parsedManifests = manifests.map(parseManifest);
  }
  const workspaces = discovery.workspaces ?? false;
  if (typeof workspaces !== "boolean") {
    throw new ConfigError("[discovery].workspaces must be a boolean.");
  }
  return { roots: parsedRoots, manifests: parsedManifests, workspaces };
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

function parseBoolField(
  table: Record<string, unknown>,
  key: string,
  fallback: boolean,
  section: string,
): boolean {
  const val = table[key] ?? fallback;
  if (typeof val !== "boolean") {
    throw new ConfigError(`[${section}].${key} must be a boolean.`);
  }
  return val;
}

function parseChecks(raw: Record<string, unknown>): ChecksConfig {
  const checks = raw.checks;
  if (checks === undefined) {
    return DEFAULT_CHECKS;
  }
  if (!isPlainObject(checks)) {
    throw new ConfigError("[checks] must be a table.");
  }
  const mode = checks.unknown_marks ?? "ignore";
  if (mode !== "ignore" && mode !== "warn" && mode !== "error") {
    throw new ConfigError("[checks].unknown_marks must be 'ignore', 'warn', or 'error'.");
  }
  return {
    strict: parseBoolField(checks, "strict", false, "checks"),
    requireDescription: parseBoolField(checks, "require_description", false, "checks"),
    requireTests: parseBoolField(checks, "require_tests", false, "checks"),
    requireFeatures: parseBoolField(checks, "require_features", false, "checks"),
    unknownMarks: mode,
  };
}

function parseSkill(raw: Record<string, unknown>): SkillConfig {
  const skill = raw.skill;
  if (skill === undefined) {
    return DEFAULT_SKILL;
  }
  if (!isPlainObject(skill)) {
    throw new ConfigError("[skill] must be a table.");
  }
  const output = skill.output ?? DEFAULT_SKILL.output;
  const command = skill.command ?? DEFAULT_SKILL.command;
  const template = skill.template;
  if (typeof output !== "string" || output.length === 0) {
    throw new ConfigError("[skill].output must be a non-empty string.");
  }
  if (typeof command !== "string" || command.length === 0) {
    throw new ConfigError("[skill].command must be a non-empty string.");
  }
  if (template !== undefined && (typeof template !== "string" || template.length === 0)) {
    throw new ConfigError("[skill].template must be a non-empty string.");
  }
  return {
    output,
    command,
    ...(template !== undefined ? { template } : {}),
  };
}

export function loadConfig(repoRoot: string, options: LoadConfigOptions = {}): TasknestConfig {
  const resolvedRoot = resolve(repoRoot);
  const target = resolveTarget(resolvedRoot, options.configPath);
  if (target === undefined) {
    return {
      repoRoot: resolvedRoot,
      roots: [{ path: "tools", namespace: "", projectRoot: "." }],
      manifests: [],
      workspaces: false,
      marks: {},
      jobs: 1,
      checks: DEFAULT_CHECKS,
      skill: DEFAULT_SKILL,
    };
  }
  const adapter = options.adapter ?? createRuntimeAdapter();
  const raw = adapter.parseToml(readFileSync(target, "utf-8"));
  const discovery = parseDiscovery(raw);
  return {
    repoRoot: resolvedRoot,
    roots: discovery.roots,
    manifests: discovery.manifests,
    workspaces: discovery.workspaces,
    marks: parseMarks(raw.marks),
    jobs: parseJobs(raw),
    checks: parseChecks(raw),
    skill: parseSkill(raw),
  };
}
