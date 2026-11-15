import { spawnSync } from "node:child_process";
import { parse as parseTomlDocument } from "smol-toml";
import type { RuntimeAdapter, RuntimeSpawnResult, SpawnOptions } from "@/src/adapter";
import { ConfigError } from "@/src/errors";

export function createNodeAdapter(): RuntimeAdapter {
  return {
    runtime: "node",
    parseToml(content: string): Record<string, unknown> {
      let parsed: unknown;
      try {
        parsed = parseTomlDocument(content);
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
      const [cmd, ...args] = argv;
      if (!cmd) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "",
          timedOut: false,
          spawnError: new Error("Command argv must not be empty."),
        };
      }
      const spawnOpts: {
        cwd: string;
        env?: Record<string, string | undefined>;
        stdio: "pipe" | "inherit";
        encoding: "utf-8";
        timeout?: number;
      } = {
        cwd: options.cwd,
        stdio: options.capture ? "pipe" : "inherit",
        encoding: "utf-8",
      };
      if (options.env !== undefined) {
        spawnOpts.env = options.env;
      }
      if (options.timeoutMs !== undefined) {
        spawnOpts.timeout = options.timeoutMs;
      }
      const proc = spawnSync(cmd, args, spawnOpts);
      const errCode = (proc.error as NodeJS.ErrnoException | undefined)?.code;
      const timedOut = errCode === "ETIMEDOUT" || proc.signal === "SIGTERM";
      if (proc.error && !timedOut) {
        return {
          exitCode: 1,
          stdout: proc.stdout ?? "",
          stderr: proc.stderr ?? "",
          timedOut: false,
          spawnError: proc.error,
        };
      }
      return {
        exitCode: proc.status ?? 1,
        stdout: proc.stdout ?? "",
        stderr: proc.stderr ?? "",
        timedOut,
      };
    },
  };
}
