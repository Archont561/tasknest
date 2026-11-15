import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { type BufferedOutput, canonicalJsonString, OUTPUT_FORMAT_JSON } from "@/src/context";
import type { TaskDefinition } from "@/src/task";

export type CacheMode = "default" | "force" | "no_cache";
export type CacheStatus = "hit" | "miss" | "bypassed" | "disabled";

const CACHE_SCHEMA_VERSION = 1;
const CACHE_DIR = ".tasknest/cache";
const META_SUFFIX = ".meta.json";

export interface CacheLookup {
  readonly status: CacheStatus;
  readonly reason: string;
  readonly cacheKey?: string;
  readonly staticKey?: string;
  readonly output?: BufferedOutput;
}

export interface CacheContext {
  readonly repoRoot: string;
  readonly projectRoot: string;
  readonly task: TaskDefinition;
  readonly kwargs: Readonly<Record<string, unknown>>;
  readonly depHashes: Readonly<Record<string, string>>;
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  readonly mode?: CacheMode;
}

function sha256Bytes(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function sha256File(filePath: string): string {
  return sha256Bytes(readFileSync(filePath));
}

function safeTaskDir(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizeRel(base: string, target: string): string {
  return relative(base, target).replaceAll("\\", "/");
}

function normalizeOptionValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeOptionValue(item));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = normalizeOptionValue(record[key]);
    }
    return out;
  }
  return value;
}

function hashDirectoryFiles(base: string, directory: string): [string, string][] {
  const entries: [string, string][] = [];
  if (!existsSync(directory)) {
    return entries;
  }
  const stack: string[] = [directory];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of readdirSync(current).sort()) {
      if (entry === ".tasknest") {
        continue;
      }
      const full = join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (stat.isFile()) {
        entries.push([normalizeRel(base, full), sha256File(full)]);
      }
    }
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries;
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

function listAllProjectEntries(
  projectRoot: string,
): { rel: string; full: string; isDir: boolean }[] {
  const results: { rel: string; full: string; isDir: boolean }[] = [];
  if (!existsSync(projectRoot)) {
    return results;
  }
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === ".tasknest") {
        continue;
      }
      const full = join(dir, entry);
      const stat = statSync(full);
      const rel = normalizeRel(projectRoot, full);
      results.push({ rel, full, isDir: stat.isDirectory() });
      if (stat.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(projectRoot);
  return results;
}

export function expandInputHashes(
  projectRoot: string,
  patterns: readonly string[],
): [string, string][] {
  const collected = new Map<string, string>();
  let allEntries: { rel: string; full: string; isDir: boolean }[] | undefined;

  for (const raw of patterns) {
    const norm = raw.replaceAll("\\", "/");
    const hasGlob = /[*?[]/.test(norm);
    const matches: { full: string; isDir: boolean }[] = [];
    if (hasGlob) {
      allEntries ??= listAllProjectEntries(projectRoot);
      const re = globToRegExp(norm);
      for (const item of allEntries) {
        if (re.test(item.rel)) {
          matches.push({ full: item.full, isDir: item.isDir });
        }
      }
    } else {
      const candidate = join(projectRoot, norm);
      if (existsSync(candidate)) {
        matches.push({ full: candidate, isDir: statSync(candidate).isDirectory() });
      }
    }

    if (matches.length === 0) {
      collected.set(`missing:${norm}`, "MISSING");
      continue;
    }

    for (const match of matches) {
      const rel = normalizeRel(projectRoot, match.full);
      if (rel === ".tasknest" || rel.startsWith(".tasknest/")) {
        continue;
      }
      if (!match.isDir) {
        collected.set(rel, sha256File(match.full));
      } else {
        for (const [subRel, digest] of hashDirectoryFiles(projectRoot, match.full)) {
          collected.set(subRel, digest);
        }
      }
    }
  }

  return [...collected.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => [k, v]);
}

function resolveEnvMap(
  keys: readonly string[],
  baseEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string | null> {
  const resolved: Record<string, string | null> = {};
  for (const key of [...new Set(keys)].sort()) {
    const val = key in baseEnv ? baseEnv[key] : process.env[key];
    resolved[key] = val ?? null;
  }
  return resolved;
}

export function computeStaticKey(ctx: CacheContext): string {
  const optionsNorm: Record<string, unknown> = {};
  for (const key of Object.keys(ctx.kwargs).sort()) {
    const val = ctx.kwargs[key];
    optionsNorm[key] = normalizeOptionValue(val === undefined ? null : val);
  }
  const depsNorm: Record<string, string> = {};
  for (const key of Object.keys(ctx.depHashes).sort()) {
    const hash = ctx.depHashes[key];
    if (hash !== undefined) {
      depsNorm[key] = hash;
    }
  }
  const payload = {
    deps: depsNorm,
    declared_env: resolveEnvMap(ctx.task.env, ctx.baseEnv),
    inputs: expandInputHashes(ctx.projectRoot, ctx.task.inputs),
    options: optionsNorm,
    schema: CACHE_SCHEMA_VERSION,
    task: ctx.task.name,
  };
  return sha256Bytes(canonicalJsonString(payload));
}

export function computeFullKey(
  staticKey: string,
  dynamicEnv: Readonly<Record<string, string | null>>,
  runnerCompat = "cross",
): string {
  const sortedDynamic: Record<string, string | null> = {};
  for (const key of Object.keys(dynamicEnv).sort()) {
    sortedDynamic[key] = dynamicEnv[key] ?? null;
  }
  const payload = {
    dynamic_env: sortedDynamic,
    runner_compat: runnerCompat,
    static_key: staticKey,
  };
  return sha256Bytes(canonicalJsonString(payload));
}

function entryDir(repoRoot: string, taskName: string): string {
  return join(repoRoot, CACHE_DIR, "entries", safeTaskDir(taskName));
}

function blobsDir(repoRoot: string): string {
  return join(repoRoot, CACHE_DIR, "blobs");
}

function verifyDeclaredOutputs(
  projectRoot: string,
  recorded: readonly Record<string, unknown>[],
): string | undefined {
  for (const item of recorded) {
    const rel = String(item.path ?? "");
    const kind = String(item.kind ?? "");
    const target = join(projectRoot, rel);
    if (kind === "missing" || !existsSync(target)) {
      return `missing declared output: ${rel}`;
    }
    const stat = statSync(target);
    if (kind === "file") {
      if (!stat.isFile() || sha256File(target) !== item.sha256) {
        return `modified declared output: ${rel}`;
      }
    } else if (kind === "dir") {
      if (!stat.isDirectory()) {
        return `missing declared output: ${rel}`;
      }
      const currentHash = sha256Bytes(canonicalJsonString(hashDirectoryFiles(projectRoot, target)));
      if (currentHash !== item.sha256) {
        return `modified declared output: ${rel}`;
      }
    }
  }
  return undefined;
}

function restoreCachedOutput(entry: Record<string, unknown>): {
  output?: BufferedOutput;
  error?: string;
} {
  const fmt = entry.output_format;
  if (fmt === undefined || fmt === null) {
    return {};
  }
  if (fmt !== OUTPUT_FORMAT_JSON) {
    return { error: `unsupported cached output format: ${String(fmt)}` };
  }
  const payload = entry.output_payload;
  const serialized = canonicalJsonString(payload);
  const sha256 = String(entry.output_hash ?? sha256Bytes(serialized));
  return {
    output: {
      value: payload,
      format: OUTPUT_FORMAT_JSON,
      serialized,
      sha256,
    },
  };
}

export function lookupCache(ctx: CacheContext): CacheLookup {
  if (!ctx.task.cache) {
    return { status: "disabled", reason: "caching disabled" };
  }
  const mode = ctx.mode ?? "default";
  if (mode === "force") {
    return { status: "bypassed", reason: "bypassed via --force" };
  }
  if (mode === "no_cache") {
    return { status: "bypassed", reason: "bypassed via --no-cache" };
  }
  const staticKey = computeStaticKey(ctx);
  const taskDir = entryDir(ctx.repoRoot, ctx.task.name);
  const metaPath = join(taskDir, `${staticKey}${META_SUFFIX}`);
  if (!existsSync(metaPath)) {
    return { status: "miss", reason: "no cached entry", staticKey };
  }
  const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
  const dynKeys = Array.isArray(meta.dynamic_env_keys)
    ? meta.dynamic_env_keys.map((k) => String(k))
    : [];
  const compat = String(meta.runner_compat ?? "cross");
  const fullKey = computeFullKey(staticKey, resolveEnvMap(dynKeys, ctx.baseEnv), compat);
  const entryPath = join(taskDir, `${fullKey}.json`);
  if (!existsSync(entryPath)) {
    return { status: "miss", reason: "cache key mismatch", cacheKey: fullKey, staticKey };
  }
  const entry = JSON.parse(readFileSync(entryPath, "utf-8")) as Record<string, unknown>;
  const outputsList = Array.isArray(entry.outputs)
    ? (entry.outputs as Record<string, unknown>[])
    : [];
  const invalid = verifyDeclaredOutputs(ctx.projectRoot, outputsList);
  if (invalid) {
    return { status: "miss", reason: invalid, cacheKey: fullKey, staticKey };
  }
  const restored = restoreCachedOutput(entry);
  if (restored.error) {
    return { status: "miss", reason: restored.error, cacheKey: fullKey, staticKey };
  }
  return restored.output
    ? {
        status: "hit",
        reason: "cache hit",
        cacheKey: fullKey,
        staticKey,
        output: restored.output,
      }
    : { status: "hit", reason: "cache hit", cacheKey: fullKey, staticKey };
}

function snapshotDeclaredOutputs(
  repoRoot: string,
  projectRoot: string,
  outputs: readonly string[],
): Record<string, unknown>[] {
  const blobs = blobsDir(repoRoot);
  mkdirSync(blobs, { recursive: true });
  const records: Record<string, unknown>[] = [];
  for (const rel of outputs) {
    const norm = rel.replaceAll("\\", "/");
    const target = join(projectRoot, norm);
    if (!existsSync(target)) {
      records.push({ path: norm, kind: "missing", sha256: null });
      continue;
    }
    const stat = statSync(target);
    if (stat.isFile()) {
      const digest = sha256File(target);
      const blob = join(blobs, digest);
      if (!existsSync(blob)) {
        copyFileSync(target, blob);
      }
      records.push({ path: norm, kind: "file", sha256: digest });
    } else if (stat.isDirectory()) {
      const files = hashDirectoryFiles(projectRoot, target);
      for (const [itemRel, digest] of files) {
        const blob = join(blobs, digest);
        if (!existsSync(blob)) {
          copyFileSync(join(projectRoot, itemRel), blob);
        }
      }
      const dirHash = sha256Bytes(canonicalJsonString(files));
      records.push({ path: norm, kind: "dir", sha256: dirHash, files });
    }
  }
  return records;
}

export function storeCache(
  ctx: CacheContext,
  dynamicEnv: Readonly<Record<string, string | null>>,
  output: BufferedOutput | undefined,
): string | undefined {
  if (!ctx.task.cache || ctx.mode === "no_cache") {
    return undefined;
  }
  const staticKey = computeStaticKey(ctx);
  const compat = "cross";
  const fullKey = computeFullKey(staticKey, dynamicEnv, compat);
  const taskDir = entryDir(ctx.repoRoot, ctx.task.name);
  mkdirSync(taskDir, { recursive: true });
  const metaPayload = {
    dynamic_env_keys: Object.keys(dynamicEnv).sort(),
    runner_compat: compat,
  };
  writeFileSync(
    join(taskDir, `${staticKey}${META_SUFFIX}`),
    canonicalJsonString(metaPayload),
    "utf-8",
  );

  const sortedDyn: Record<string, string | null> = {};
  for (const key of Object.keys(dynamicEnv).sort()) {
    sortedDyn[key] = dynamicEnv[key] ?? null;
  }
  const entry: Record<string, unknown> = {
    schema_version: CACHE_SCHEMA_VERSION,
    task: ctx.task.name,
    cache_key: fullKey,
    static_key: staticKey,
    runner_compat: compat,
    outputs: snapshotDeclaredOutputs(ctx.repoRoot, ctx.projectRoot, ctx.task.outputs),
    dynamic_env: sortedDyn,
  };
  if (output !== undefined) {
    entry.output_format = output.format;
    entry.output_hash = output.sha256;
    entry.abi_tag = null;
    entry.output_payload = output.value;
  }
  writeFileSync(join(taskDir, `${fullKey}.json`), canonicalJsonString(entry), "utf-8");
  return fullKey;
}
