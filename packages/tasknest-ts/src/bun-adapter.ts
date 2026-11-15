import {
  createLineDispatcher,
  parseTomlWith,
  type RuntimeAdapter,
  type RuntimeSpawnResult,
  type SpawnOptions,
  type WatchHandle,
  watchPathWithNodeFs,
} from "@/src/adapter";
import { NotImplementedError } from "@/src/errors";

const KILL_GRACE_MS = 1500;

interface BunTomlNamespace {
  parse(input: string): unknown;
}

interface BunSyncProc {
  readonly exitCode: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly exitedDueToTimeout?: boolean;
}

interface BunAsyncProc {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  kill(signal?: number | string): void;
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
  spawn(
    cmd: string[],
    options: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdin?: "inherit" | "pipe" | "ignore";
      stdout?: "inherit" | "pipe" | "ignore";
      stderr?: "inherit" | "pipe" | "ignore";
    },
  ): BunAsyncProc;
}

function getBun(): BunGlobal {
  const bun = (globalThis as { Bun?: BunGlobal }).Bun;
  if (!bun) {
    throw new NotImplementedError("Bun runtime is required for createBunAdapter().");
  }
  return bun;
}

async function pumpReadableStream(
  stream: ReadableStream<Uint8Array> | null,
  capture: boolean,
  onLine: ((line: string) => void) | undefined,
  fallbackWrite: (chunk: string) => void,
): Promise<string> {
  if (!stream) {
    return "";
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const dispatcher = onLine ? createLineDispatcher(onLine) : null;
  let collected = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      const chunk = decoder.decode(value, { stream: true });
      if (capture) {
        collected += chunk;
      } else if (dispatcher) {
        dispatcher.push(chunk);
      } else if (chunk) {
        fallbackWrite(chunk);
      }
    }
    const tail = decoder.decode();
    if (tail) {
      if (capture) {
        collected += tail;
      } else if (dispatcher) {
        dispatcher.push(tail);
      } else {
        fallbackWrite(tail);
      }
    }
    dispatcher?.flush();
  } finally {
    reader.releaseLock();
  }
  return collected;
}

export function createBunAdapter(): RuntimeAdapter {
  return {
    runtime: "bun",
    parseToml(content: string): Record<string, unknown> {
      return parseTomlWith((raw) => getBun().TOML.parse(raw), content);
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
    async spawnAsync(argv: readonly string[], options: SpawnOptions): Promise<RuntimeSpawnResult> {
      const bun = getBun();
      if (argv.length === 0 || !argv[0]) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "",
          timedOut: false,
          spawnError: new Error("Command argv must not be empty."),
        };
      }
      if (options.signal?.aborted) {
        return {
          exitCode: 130,
          stdout: "",
          stderr: "",
          timedOut: false,
          cancelled: true,
        };
      }
      const pipeIo = Boolean(
        options.capture || options.onStdoutLine || options.onStderrLine || options.signal,
      );
      let proc: BunAsyncProc;
      try {
        proc = bun.spawn([...argv], {
          cwd: options.cwd,
          ...(options.env !== undefined ? { env: options.env } : {}),
          stdin: "ignore",
          stdout: pipeIo ? "pipe" : "inherit",
          stderr: pipeIo ? "pipe" : "inherit",
        });
      } catch (err) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "",
          timedOut: false,
          spawnError: err instanceof Error ? err : new Error(String(err)),
        };
      }

      let timedOut = false;
      let cancelled = false;
      const terminate = (): void => {
        try {
          proc.kill("SIGTERM");
        } catch {
          // already exited
        }
        const killTimer = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // already exited
          }
        }, KILL_GRACE_MS);
        killTimer.unref();
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

      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          pumpReadableStream(proc.stdout, Boolean(options.capture), options.onStdoutLine, (c) =>
            process.stdout.write(c),
          ),
          pumpReadableStream(proc.stderr, Boolean(options.capture), options.onStderrLine, (c) =>
            process.stderr.write(c),
          ),
        ]);
        return {
          exitCode: cancelled ? 130 : exitCode,
          stdout,
          stderr,
          timedOut,
          cancelled,
        };
      } finally {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
        if (options.signal) {
          options.signal.removeEventListener("abort", onAbort);
        }
      }
    },
    watchPath(targetPath: string, onChange: (filename: string | null) => void): WatchHandle {
      return watchPathWithNodeFs(targetPath, onChange);
    },
  };
}
