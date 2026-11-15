import { watch } from "node:fs";
import { createBunAdapter } from "@/src/bun-adapter";
import { ConfigError } from "@/src/errors";
import { createNodeAdapter } from "@/src/node-adapter";

export type RuntimeName = "bun" | "node";

export interface SpawnOptions {
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
  readonly capture?: boolean;
  readonly signal?: AbortSignal;
  readonly onStdoutLine?: (line: string) => void;
  readonly onStderrLine?: (line: string) => void;
}

export interface RuntimeSpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled?: boolean;
  readonly spawnError?: Error;
}

export interface WatchHandle {
  close(): void;
}

export interface RuntimeAdapter {
  readonly runtime: RuntimeName;
  parseToml(content: string): Record<string, unknown>;
  spawn(argv: readonly string[], options: SpawnOptions): RuntimeSpawnResult;
  spawnAsync?(argv: readonly string[], options: SpawnOptions): Promise<RuntimeSpawnResult>;
  watchPath(targetPath: string, onChange: (filename: string | null) => void): WatchHandle;
}

export function createLineDispatcher(onLine: (line: string) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buffer = "";
  return {
    push(chunk: string): void {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        onLine(buffer.slice(0, nl + 1));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    },
    flush(): void {
      if (buffer.length > 0) {
        onLine(buffer);
        buffer = "";
      }
    },
  };
}

export function watchPathWithNodeFs(
  targetPath: string,
  onChange: (filename: string | null) => void,
): WatchHandle {
  const watcher = watch(targetPath, { persistent: false }, (_eventType, filename) => {
    onChange(typeof filename === "string" ? filename : null);
  });
  return {
    close(): void {
      watcher.close();
    },
  };
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
