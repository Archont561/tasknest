import { createBunAdapter } from "@/src/bun-adapter";
import { ConfigError } from "@/src/errors";
import { createNodeAdapter } from "@/src/node-adapter";

export type RuntimeName = "bun" | "node";

export interface SpawnOptions {
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
  readonly capture?: boolean;
}

export interface RuntimeSpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnError?: Error;
}

export interface RuntimeAdapter {
  readonly runtime: RuntimeName;
  parseToml(content: string): Record<string, unknown>;
  spawn(argv: readonly string[], options: SpawnOptions): RuntimeSpawnResult;
}

export function parseTomlWith(
  parser: (content: string) => unknown,
  content: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parser(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Invalid TOML: ${message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError("Invalid TOML: root document must be a table.");
  }
  return parsed as Record<string, unknown>;
}

export function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

export function createRuntimeAdapter(runtime?: RuntimeName): RuntimeAdapter {
  const selected = runtime ?? (isBunRuntime() ? "bun" : "node");
  return selected === "bun" ? createBunAdapter() : createNodeAdapter();
}
