import type { RuntimeAdapter, RuntimeSpawnResult, SpawnOptions } from "@/src/adapter";
import { ConfigError, NotImplementedError } from "@/src/errors";

interface BunTomlNamespace {
  parse(input: string): unknown;
}

interface BunSyncProc {
  readonly exitCode: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly exitedDueToTimeout?: boolean;
}

interface BunGlobal {
  readonly TOML: BunTomlNamespace;
  spawnSync(
    cmd: string[],
    options: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdin?: "inherit" | "pipe" | "ignore";
      stdout?: "inherit" | "pipe" | "ignore";
      stderr?: "inherit" | "pipe" | "ignore";
      timeout?: number;
    },
  ): BunSyncProc;
}

function getBun(): BunGlobal {
  const bun = (globalThis as { Bun?: BunGlobal }).Bun;
  if (!bun) {
    throw new NotImplementedError("Bun runtime is required for createBunAdapter().");
  }
  return bun;
}

export function createBunAdapter(): RuntimeAdapter {
  return {
    runtime: "bun",
    parseToml(content: string): Record<string, unknown> {
      const bun = getBun();
      let parsed: unknown;
      try {
        parsed = bun.TOML.parse(content);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ConfigError(`Invalid TOML: ${message}`);
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ConfigError("Invalid TOML: root document must be a table.");
      }
      return parsed as Record<string, unknown>;
    },
    spawn(argv: readonly string[], options: SpawnOptions): RuntimeSpawnResult {
      const bun = getBun();
      const decoder = new TextDecoder();
      try {
        const spawnOpts: {
          cwd: string;
          env?: Record<string, string | undefined>;
          stdin: "inherit";
          stdout: "pipe" | "inherit";
          stderr: "pipe" | "inherit";
          timeout?: number;
        } = {
          cwd: options.cwd,
          stdin: "inherit",
          stdout: options.capture ? "pipe" : "inherit",
          stderr: options.capture ? "pipe" : "inherit",
        };
        if (options.env !== undefined) {
          spawnOpts.env = options.env;
        }
        if (options.timeoutMs !== undefined) {
          spawnOpts.timeout = options.timeoutMs;
        }
        const proc = bun.spawnSync([...argv], spawnOpts);
        return {
          exitCode: proc.exitCode ?? 1,
          stdout: options.capture && proc.stdout ? decoder.decode(proc.stdout) : "",
          stderr: options.capture && proc.stderr ? decoder.decode(proc.stderr) : "",
          timedOut: Boolean(proc.exitedDueToTimeout),
        };
      } catch (err) {
        const spawnError = err instanceof Error ? err : new Error(String(err));
        return {
          exitCode: 1,
          stdout: "",
          stderr: "",
          timedOut: false,
          spawnError,
        };
      }
    },
  };
}
