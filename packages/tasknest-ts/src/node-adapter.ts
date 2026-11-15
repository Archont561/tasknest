import { spawn, spawnSync } from "node:child_process";
import type { EventEmitter } from "node:events";
import { parse as parseTomlDocument } from "smol-toml";
import {
  createLineDispatcher,
  parseTomlWith,
  type RuntimeAdapter,
  type RuntimeSpawnResult,
  type SpawnOptions,
  type WatchHandle,
  watchPathWithNodeFs,
} from "@/src/adapter";

const KILL_GRACE_MS = 1500;

function terminateNodeChild(pid: number | undefined, fallbackKill: () => void): void {
  if (pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      fallbackKill();
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already exited
      }
    }, KILL_GRACE_MS);
    timer.unref();
    return;
  }
  fallbackKill();
}

export function createNodeAdapter(): RuntimeAdapter {
  return {
    runtime: "node",
    parseToml(content: string): Record<string, unknown> {
      return parseTomlWith(parseTomlDocument, content);
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
    spawnAsync(argv: readonly string[], options: SpawnOptions): Promise<RuntimeSpawnResult> {
      const [cmd, ...args] = argv;
      if (!cmd) {
        return Promise.resolve({
          exitCode: 1,
          stdout: "",
          stderr: "",
          timedOut: false,
          spawnError: new Error("Command argv must not be empty."),
        });
      }
      if (options.signal?.aborted) {
        return Promise.resolve({
          exitCode: 130,
          stdout: "",
          stderr: "",
          timedOut: false,
          cancelled: true,
        });
      }
      return new Promise<RuntimeSpawnResult>((resolve) => {
        const pipeIo = Boolean(
          options.capture || options.onStdoutLine || options.onStderrLine || options.signal,
        );
        const child = spawn(cmd, args, {
          cwd: options.cwd,
          ...(options.env !== undefined ? { env: options.env } : {}),
          detached: process.platform !== "win32",
          stdio: pipeIo ? ["ignore", "pipe", "pipe"] : "inherit",
        });

        let stdoutText = "";
        let stderrText = "";
        let timedOut = false;
        let cancelled = false;
        let settled = false;

        const outLines = options.onStdoutLine ? createLineDispatcher(options.onStdoutLine) : null;
        const errLines = options.onStderrLine ? createLineDispatcher(options.onStderrLine) : null;

        if (child.stdout) {
          child.stdout.setEncoding("utf-8");
          child.stdout.on("data", (chunk: string) => {
            if (options.capture) {
              stdoutText += chunk;
            } else if (outLines) {
              outLines.push(chunk);
            } else {
              process.stdout.write(chunk);
            }
          });
        }
        if (child.stderr) {
          child.stderr.setEncoding("utf-8");
          child.stderr.on("data", (chunk: string) => {
            if (options.capture) {
              stderrText += chunk;
            } else if (errLines) {
              errLines.push(chunk);
            } else {
              process.stderr.write(chunk);
            }
          });
        }

        const terminate = (): void => {
          terminateNodeChild(child.pid, () => {
            try {
              child.kill("SIGTERM");
            } catch {
              // ignore
            }
          });
        };

        const onAbort = (): void => {
          cancelled = true;
          terminate();
        };

        if (options.signal) {
          options.signal.addEventListener("abort", onAbort, { once: true });
        }

        const timeoutHandle =
          options.timeoutMs !== undefined
            ? setTimeout(() => {
                timedOut = true;
                terminate();
              }, options.timeoutMs)
            : undefined;

        const cleanup = (): void => {
          if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
          }
          if (options.signal) {
            options.signal.removeEventListener("abort", onAbort);
          }
          outLines?.flush();
          errLines?.flush();
        };

        const childEvents = child as unknown as EventEmitter;
        childEvents.on("error", (err: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve({
            exitCode: 1,
            stdout: stdoutText,
            stderr: stderrText,
            timedOut: false,
            cancelled,
            spawnError: err,
          });
        });

        childEvents.on("close", (code: number | null) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve({
            exitCode: cancelled ? 130 : (code ?? 1),
            stdout: stdoutText,
            stderr: stderrText,
            timedOut,
            cancelled,
          });
        });
      });
    },
    watchPath(targetPath: string, onChange: (filename: string | null) => void): WatchHandle {
      return watchPathWithNodeFs(targetPath, onChange);
    },
  };
}
