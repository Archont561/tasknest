import { createBunAdapter } from "@/src/bun-adapter";
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

export function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

export function createRuntimeAdapter(runtime?: RuntimeName): RuntimeAdapter {
  const selected = runtime ?? (isBunRuntime() ? "bun" : "node");
  return selected === "bun" ? createBunAdapter() : createNodeAdapter();
}
