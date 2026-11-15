import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRuntimeAdapter, type RuntimeAdapter } from "@/src/adapter";
import { ToolError } from "@/src/errors";

export type ChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "unknown";

const STATUS_CODE_MAP: Readonly<Record<string, ChangeStatus>> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
};

export const DEFAULT_ALWAYS_FULL: readonly string[] = [
  "pyproject.toml",
  "package.json",
  "tsconfig.json",
  "bun.lock",
  "pixi.toml",
  "pixi.lock",
  "tasknest.toml",
  "conftest.py",
  "tests/conftest.py",
  "tests/test.ts",
];

export function normalizeRelPath(raw: string): string {
  let cleaned = raw.trim().replaceAll("\\", "/");
  while (cleaned.startsWith("./")) {
    cleaned = cleaned.slice(2);
  }
  return cleaned;
}

export interface ChangedFile {
  readonly path: string;
  readonly status: ChangeStatus;
  readonly oldPath?: string;
}

export interface AffectedContextData {
  readonly available: boolean;
  readonly complete: boolean;
  readonly files: readonly ChangedFile[];
  readonly baseRef?: string;
  readonly targetRef?: string;
  readonly reason?: string;
  readonly includeUntracked: boolean;
}

export class AffectedContext implements AffectedContextData {
  readonly available: boolean;
  readonly complete: boolean;
  readonly files: readonly ChangedFile[];
  readonly baseRef?: string;
  readonly targetRef?: string;
  readonly reason?: string;
  readonly includeUntracked: boolean;

  constructor(params: Partial<AffectedContextData> = {}) {
    this.available = params.available ?? false;
    this.complete = params.complete ?? false;
    this.files = params.files ?? [];
    this.includeUntracked = params.includeUntracked ?? true;
    if (params.baseRef !== undefined) {
      this.baseRef = params.baseRef;
    }
    if (params.targetRef !== undefined) {
      this.targetRef = params.targetRef;
    }
    if (params.reason !== undefined) {
      this.reason = params.reason;
    } else if (!this.available) {
      this.reason = "no change context provided";
    }
  }

  paths(): string[] {
    return this.files.map((item) => normalizeRelPath(item.path));
  }

  oldPaths(): string[] {
    const out: string[] = [];
    for (const item of this.files) {
      if (item.oldPath !== undefined) {
        out.push(normalizeRelPath(item.oldPath));
      }
    }
    return out;
  }

  allTouchedPaths(): string[] {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const item of this.files) {
      const candidates =
        item.oldPath !== undefined && normalizeRelPath(item.oldPath) !== normalizeRelPath(item.path)
          ? [normalizeRelPath(item.oldPath), normalizeRelPath(item.path)]
          : [normalizeRelPath(item.path)];
      for (const touched of candidates) {
        if (!seen.has(touched)) {
          seen.add(touched);
          ordered.push(touched);
        }
      }
    }
    return ordered;
  }

  toDict(): Record<string, unknown> {
    return {
      available: this.available,
      complete: this.complete,
      base_ref: this.baseRef ?? null,
      target_ref: this.targetRef ?? null,
      reason: this.reason ?? null,
      include_untracked: this.includeUntracked,
      files: this.files.map((item) => ({
        path: item.path,
        status: item.status,
        old_path: item.oldPath ?? null,
      })),
    };
  }
}

export interface AffectedTestPlan {
  readonly targets: readonly string[];
  readonly fallbackReason?: string;
  readonly reasons?: Readonly<Record<string, string>>;
}

export interface SelectionPolicy {
  readonly defaultTarget?: string;
  readonly alwaysFull?: readonly string[];
  readonly forceAll?: boolean;
  readonly strict?: boolean;
}

export function parseGitNameStatus(rawDiff: string, rawUntracked = ""): ChangedFile[] {
  const entries: ChangedFile[] = [];
  for (const line of rawDiff.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped) {
      continue;
    }
    const parts = stripped.split("\t");
    const code = (parts[0] ?? "").slice(0, 1);
    const status: ChangeStatus = STATUS_CODE_MAP[code] ?? "unknown";
    if ((code === "R" || code === "C") && parts.length >= 3) {
      entries.push({
        path: normalizeRelPath(parts[2] ?? ""),
        status,
        oldPath: normalizeRelPath(parts[1] ?? ""),
      });
    } else if (parts.length >= 2) {
      const filePath = normalizeRelPath(parts[1] ?? "");
      entries.push(
        status === "deleted"
          ? { path: filePath, status, oldPath: filePath }
          : { path: filePath, status },
      );
    }
  }
  for (const line of rawUntracked.split(/\r?\n/)) {
    const rel = normalizeRelPath(line);
    if (rel) {
      entries.push({ path: rel, status: "untracked" });
    }
  }
  return entries;
}

export function collectGitChanges(
  repoRoot: string,
  options: {
    readonly baseRef?: string;
    readonly includeUntracked?: boolean;
    readonly adapter?: RuntimeAdapter;
  } = {},
): AffectedContext {
  const adapter = options.adapter ?? createRuntimeAdapter();
  const diffRef = options.baseRef ?? "HEAD";
  const includeUntracked = options.includeUntracked ?? true;
  const diffRes = adapter.spawn(["git", "diff", "--name-status", "-M", diffRef], {
    cwd: repoRoot,
    capture: true,
  });
  if (diffRes.spawnError || diffRes.exitCode !== 0) {
    return new AffectedContext({
      available: false,
      complete: false,
      baseRef: diffRef,
      targetRef: "WORKTREE",
      reason: `git diff against '${diffRef}' failed: ${diffRes.stderr.trim() || "unavailable"}`,
      includeUntracked,
    });
  }
  let untrackedOut = "";
  if (includeUntracked) {
    const untrackedRes = adapter.spawn(["git", "ls-files", "--others", "--exclude-standard"], {
      cwd: repoRoot,
      capture: true,
    });
    if (untrackedRes.spawnError || untrackedRes.exitCode !== 0) {
      return new AffectedContext({
        available: true,
        complete: false,
        files: parseGitNameStatus(diffRes.stdout),
        baseRef: diffRef,
        targetRef: "WORKTREE",
        reason: `git untracked listing failed: ${untrackedRes.stderr.trim() || "unavailable"}`,
        includeUntracked,
      });
    }
    untrackedOut = untrackedRes.stdout;
  }
  return new AffectedContext({
    available: true,
    complete: true,
    files: parseGitNameStatus(diffRes.stdout, untrackedOut),
    baseRef: diffRef,
    targetRef: "WORKTREE",
    includeUntracked,
  });
}

function fallbackOrThrow(defaultTarget: string, strict: boolean, reason: string): AffectedTestPlan {
  if (strict) {
    throw new ToolError(`Affected selection could not narrow scope safely: ${reason}`);
  }
  return { targets: [defaultTarget], fallbackReason: reason };
}

function asChangedFiles(
  changes: AffectedContext | readonly (ChangedFile | string)[],
): ChangedFile[] {
  if (changes instanceof AffectedContext) {
    return [...changes.files];
  }
  return changes.map((item) =>
    typeof item === "string" ? { path: normalizeRelPath(item), status: "modified" as const } : item,
  );
}

export function selectConservativeTargets(
  changes: AffectedContext | readonly (ChangedFile | string)[],
  mapping: Readonly<Record<string, readonly string[]>> | undefined,
  policy: SelectionPolicy = {},
): AffectedTestPlan {
  const defaultTarget = policy.defaultTarget ?? "tests";
  const alwaysFull = policy.alwaysFull ?? DEFAULT_ALWAYS_FULL;
  const forceAll = policy.forceAll ?? false;
  const strict = policy.strict ?? false;

  if (forceAll) {
    return { targets: [defaultTarget], fallbackReason: "full suite forced (--all / --force)" };
  }
  if (changes instanceof AffectedContext && (!changes.available || !changes.complete)) {
    return fallbackOrThrow(defaultTarget, strict, changes.reason ?? "change context incomplete");
  }
  if (mapping === undefined) {
    return fallbackOrThrow(defaultTarget, strict, "no source-to-test mapping provided");
  }
  const entries = asChangedFiles(changes);
  if (entries.length === 0) {
    return { targets: [] };
  }

  const selected: string[] = [];
  const seen = new Set<string>();
  const reasons: Record<string, string> = {};

  for (const entry of entries) {
    const touchedPaths =
      entry.oldPath !== undefined &&
      normalizeRelPath(entry.oldPath) !== normalizeRelPath(entry.path)
        ? [normalizeRelPath(entry.oldPath), normalizeRelPath(entry.path)]
        : [normalizeRelPath(entry.path)];
    for (const touched of touchedPaths) {
      if (alwaysFull.includes(touched) || touched.endsWith("/conftest.py")) {
        return fallbackOrThrow(defaultTarget, strict, `global trigger changed: ${touched}`);
      }
      const mapped = mapping[touched];
      if (!mapped || mapped.length === 0) {
        const label =
          entry.status === "deleted" || entry.status === "renamed"
            ? "unmapped deletion/rename"
            : "unmapped change";
        return fallbackOrThrow(defaultTarget, strict, `${label}: ${touched}`);
      }
      for (const target of mapped) {
        if (!seen.has(target)) {
          seen.add(target);
          selected.push(target);
          reasons[target] = `matched ${touched}`;
        }
      }
    }
  }
  return { targets: selected, reasons };
}

function walkTsFiles(dir: string, out: string[]): void {
  if (!existsSync(dir)) {
    return;
  }
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist") {
      continue;
    }
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkTsFiles(full, out);
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      out.push(full);
    }
  }
}

export function buildTsReverseMap(
  repoRoot: string,
  sourceRoot: string,
  testRoot: string,
): Record<string, string[]> {
  const absRepo = resolve(repoRoot);
  const absSrc = isAbsolute(sourceRoot) ? sourceRoot : join(absRepo, sourceRoot);
  const absTests = isAbsolute(testRoot) ? testRoot : join(absRepo, testRoot);
  const srcFiles: string[] = [];
  const testFiles: string[] = [];
  walkTsFiles(absSrc, srcFiles);
  walkTsFiles(absTests, testFiles);

  const pkgRoot = dirname(absSrc);
  const reverse = new Map<string, Set<string>>();
  for (const srcFile of srcFiles) {
    reverse.set(normalizeRelPath(relative(absRepo, srcFile)), new Set());
  }

  const importRe = /(?:import|export)\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/g;
  for (const testFile of testFiles) {
    const relTest = normalizeRelPath(relative(absRepo, testFile));
    reverse.set(relTest, new Set([relTest]));
    const body = readFileSync(testFile, "utf-8");
    for (const match of body.matchAll(importRe)) {
      const spec = match[1] ?? "";
      let resolvedBase: string | undefined;
      if (spec.startsWith("@/")) {
        resolvedBase = join(pkgRoot, spec.slice(2));
      } else if (spec.startsWith(".")) {
        resolvedBase = resolve(dirname(testFile), spec);
      }
      if (!resolvedBase) {
        continue;
      }
      for (const candidate of [
        resolvedBase,
        `${resolvedBase}.ts`,
        `${resolvedBase}.tsx`,
        join(resolvedBase, "index.ts"),
      ]) {
        const relCand = normalizeRelPath(relative(absRepo, candidate));
        const bucket = reverse.get(relCand);
        if (bucket) {
          bucket.add(relTest);
        }
      }
    }
  }

  const out: Record<string, string[]> = {};
  for (const [key, set] of [...reverse.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (set.size > 0) {
      out[key] = [...set].sort();
    }
  }
  return out;
}
