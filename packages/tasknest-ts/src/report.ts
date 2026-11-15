import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AffectedContext, AffectedTestPlan } from "@/src/affected";
import type { CacheStatus } from "@/src/cache";
import type { RecordedCommand } from "@/src/context";
import { VERSION } from "@/src/version";

export const REPORT_SCHEMA_VERSION = 1;
export const REDACTED_PLACEHOLDER = "***REDACTED***";

export type TaskStatus = "passed" | "failed" | "skipped" | "blocked" | "cancelled";

const SECRET_FLAG_NAMES = new Set<string>([
  "token",
  "secret",
  "password",
  "passwd",
  "api-key",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "credential",
  "private-key",
  "private_key",
]);

const KV_SECRET_RE =
  /(\b(?:--)?[a-z0-9_-]*(?:token|secret|password|passwd|api[-_]?key|auth|credential|private[-_]?key)\s*[=:]\s*)([^\s"']+)/gi;
const BEARER_RE = /(Bearer\s+)([A-Za-z0-9._\-~+/]+=*)/gi;
const URL_CRED_RE = /(https?:\/\/)([^:/\s]+:[^@/\s]+)(@)/g;
const KNOWN_TOKEN_RE = /\b(?:ghp|gho|github_pat|pypi|npm|sk)[_-][A-Za-z0-9_-]{8,}\b/g;

export function redactText(text: string, extraSecrets: readonly string[] = []): string {
  let result = text;
  for (const secret of extraSecrets) {
    if (secret) {
      result = result.replaceAll(secret, REDACTED_PLACEHOLDER);
    }
  }
  result = result.replace(URL_CRED_RE, `$1${REDACTED_PLACEHOLDER}$3`);
  result = result.replace(BEARER_RE, `$1${REDACTED_PLACEHOLDER}`);
  result = result.replace(KV_SECRET_RE, `$1${REDACTED_PLACEHOLDER}`);
  return result.replace(KNOWN_TOKEN_RE, REDACTED_PLACEHOLDER);
}

function isSecretFlag(token: string): boolean {
  if (!token.startsWith("--") || token.includes("=")) {
    return false;
  }
  const name = token.slice(2).toLowerCase();
  if (SECRET_FLAG_NAMES.has(name)) {
    return true;
  }
  for (const key of SECRET_FLAG_NAMES) {
    if (name.includes(key)) {
      return true;
    }
  }
  return false;
}

export function redactArgv(
  argv: readonly string[],
  extraSecrets: readonly string[] = [],
): string[] {
  const redacted: string[] = [];
  let maskNext = false;
  for (const tok of argv) {
    if (maskNext) {
      redacted.push(REDACTED_PLACEHOLDER);
      maskNext = false;
      continue;
    }
    if (isSecretFlag(tok)) {
      redacted.push(tok);
      maskNext = true;
      continue;
    }
    redacted.push(redactText(tok, extraSecrets));
  }
  return redacted;
}

export interface TaskRunRecord {
  readonly name: string;
  readonly status: TaskStatus;
  readonly cacheStatus?: CacheStatus;
  readonly cacheReason?: string;
  readonly durationMs?: number;
  readonly commands?: readonly RecordedCommand[];
  readonly error?: string;
  readonly outputHash?: string;
  readonly selectionReason?: string;
}

export interface ReportMetadata {
  readonly target?: string;
  readonly jobs?: number;
  readonly startedAt?: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly affected?: AffectedContext;
  readonly selection?: AffectedTestPlan;
  readonly extraSecrets?: readonly string[];
}

export function serializeTaskRecord(
  rec: TaskRunRecord,
  extraSecrets: readonly string[] = [],
): Record<string, unknown> {
  return {
    name: rec.name,
    status: rec.status,
    cache_status: rec.cacheStatus ?? "disabled",
    cache_reason: rec.cacheReason ?? null,
    duration_ms: Math.round((rec.durationMs ?? 0) * 1000) / 1000,
    commands: (rec.commands ?? []).map((cmd) => ({
      argv: redactArgv(cmd.argv, extraSecrets),
      returncode: cmd.exitCode,
      cwd: cmd.cwd.replaceAll("\\", "/"),
    })),
    error: rec.error !== undefined ? redactText(rec.error, extraSecrets) : null,
    output_hash: rec.outputHash ?? null,
    selection_reason: rec.selectionReason ?? null,
  };
}

export function buildJsonReport(
  records: readonly TaskRunRecord[],
  meta: ReportMetadata = {},
): Record<string, unknown> {
  const exitCode = meta.exitCode ?? 0;
  const extraSecrets = meta.extraSecrets ?? [];
  const payload: Record<string, unknown> = {
    schema_version: REPORT_SCHEMA_VERSION,
    runner: "typescript",
    runner_version: VERSION,
    status: exitCode === 0 ? "passed" : "failed",
    exit_code: exitCode,
    target: meta.target ?? null,
    jobs: meta.jobs ?? 1,
    started_at: meta.startedAt ?? "",
    duration_ms: Math.round((meta.durationMs ?? 0) * 1000) / 1000,
    tasks: records.map((rec) => serializeTaskRecord(rec, extraSecrets)),
  };
  if (meta.affected !== undefined) {
    payload.affected = meta.affected.toDict();
  }
  if (meta.selection !== undefined) {
    payload.selection = {
      targets: [...meta.selection.targets],
      fallback_reason: meta.selection.fallbackReason ?? null,
      reasons: meta.selection.reasons ?? null,
    };
  }
  return payload;
}

export function serializeJsonReport(
  records: readonly TaskRunRecord[],
  meta: ReportMetadata = {},
): string {
  return JSON.stringify(buildJsonReport(records, meta), null, 2);
}

export function writeJsonReport(
  filePath: string,
  records: readonly TaskRunRecord[],
  meta: ReportMetadata = {},
): string {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${serializeJsonReport(records, meta)}\n`, "utf-8");
  return filePath;
}
