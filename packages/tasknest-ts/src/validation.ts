import { existsSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { DiscoveredTask, TaskRegistry } from "@/src/discovery";
import { ValidationError } from "@/src/errors";
import { resolvePlan, validateGraph } from "@/src/graph";

export interface ValidationResult {
  readonly warnings: readonly string[];
}

function expectedTestCandidates(task: DiscoveredTask): readonly string[] {
  const rel = relative(task.rootDir, task.sourcePath).replace(/\.[^.]+$/, "");
  const dir = dirname(rel);
  const base = basename(rel);
  const nested = join(task.rootDir, "tests", dir === "." ? "" : dir, `${base}.test.ts`);
  const flat = join(task.rootDir, "tests", `${rel.replaceAll("/", "_")}.test.ts`);
  return [nested, flat];
}

function expectedFeatureCandidates(task: DiscoveredTask): readonly string[] {
  const rel = relative(task.rootDir, task.sourcePath).replace(/\.[^.]+$/, "");
  const nested = join(task.rootDir, "features", `${rel}.feature`);
  const flat = join(task.rootDir, "features", `${rel.replaceAll("/", "_")}.feature`);
  return [nested, flat];
}

function checkMarksForTask(task: DiscoveredTask, registry: TaskRegistry, warnings: string[]): void {
  const { checks, marks } = registry.config;
  const mode = checks.strict && checks.unknownMarks === "ignore" ? "error" : checks.unknownMarks;
  if (mode === "ignore") {
    return;
  }
  const unknown = task.definition.marks.filter((mark) => !(mark in marks));
  if (unknown.length === 0) {
    return;
  }
  const msg = `Task '${task.canonicalName}' uses unknown mark(s): ${unknown.join(", ")}.`;
  if (mode === "error") {
    throw new ValidationError(msg);
  }
  warnings.push(msg);
}

function checkTaskFiles(task: DiscoveredTask, registry: TaskRegistry): void {
  const { checks } = registry.config;
  if (checks.requireTests) {
    const candidates = expectedTestCandidates(task);
    if (!candidates.some((candidate) => existsSync(candidate))) {
      throw new ValidationError(
        `Task '${task.canonicalName}' is missing required test file (${candidates.join(" or ")}).`,
      );
    }
  }
  if (checks.requireFeatures) {
    const candidates = expectedFeatureCandidates(task);
    if (!candidates.some((candidate) => existsSync(candidate))) {
      throw new ValidationError(
        `Task '${task.canonicalName}' is missing required feature file (${candidates.join(" or ")}).`,
      );
    }
  }
}

export function validateRegistry(registry: TaskRegistry): ValidationResult {
  const { checks } = registry.config;
  const warnings: string[] = [];
  const tasks = Object.values(registry.tasks).sort((a, b) =>
    a.canonicalName.localeCompare(b.canonicalName),
  );
  for (const task of tasks) {
    if (checks.requireDescription && task.description.trim().length === 0) {
      throw new ValidationError(`Task '${task.canonicalName}' is missing a required description.`);
    }
    checkMarksForTask(task, registry, warnings);
    checkTaskFiles(task, registry);
  }
  return { warnings };
}

export function selectTasksByMarks(
  registry: TaskRegistry,
  marks: readonly string[],
  options: { readonly matchAll?: boolean } = {},
): readonly string[] {
  if (marks.length === 0) {
    throw new ValidationError("At least one --mark value is required.");
  }
  validateGraph(registry);
  const matchAll = options.matchAll ?? false;
  const matched = Object.values(registry.tasks)
    .sort((a, b) => a.canonicalName.localeCompare(b.canonicalName))
    .filter((task) => {
      const taskMarks = task.definition.marks;
      return matchAll
        ? marks.every((m) => taskMarks.includes(m))
        : marks.some((m) => taskMarks.includes(m));
    })
    .map((task) => task.canonicalName);

  if (matched.length === 0) {
    throw new ValidationError(`No tasks matched mark(s): ${marks.join(", ")}.`);
  }

  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const target of matched) {
    for (const name of resolvePlan(registry, target)) {
      if (!seen.has(name)) {
        seen.add(name);
        ordered.push(name);
      }
    }
  }
  return ordered;
}

export function formatEffectSummary(
  registry: TaskRegistry,
  taskNames: readonly string[],
): readonly string[] {
  const lines: string[] = [];
  for (const name of taskNames) {
    const task = registry.tasks[name];
    if (!task) {
      continue;
    }
    const parts: string[] = [];
    if (task.definition.marks.length > 0) {
      parts.push(`marks=${task.definition.marks.join(",")}`);
    }
    if (task.definition.requires.length > 0) {
      parts.push(`requires=${task.definition.requires.join(",")}`);
    }
    if (parts.length > 0) {
      lines.push(`${name}: ${parts.join("; ")}`);
    }
  }
  return lines;
}
