import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { createRuntimeAdapter, type RuntimeAdapter, type SpawnOptions } from "@/src/adapter";
import { AffectedContext } from "@/src/affected";
import { ToolError } from "@/src/errors";

export const OUTPUT_FORMAT_JSON = "json";

export interface BufferedOutput {
  readonly value: unknown;
  readonly format: "json";
  readonly serialized: string;
  readonly sha256: string;
}

export interface RecordedCommand {
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly cwd: string;
}

export class CommandResult {
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(params: {
    argv: readonly string[];
    exitCode: number;
    stdout: string;
    stderr: string;
  }) {
    this.argv = params.argv;
    this.exitCode = params.exitCode;
    this.stdout = params.stdout;
    this.stderr = params.stderr;
  }
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutSeconds?: number;
  readonly check?: boolean;
  readonly capture?: boolean;
}

export interface OutputOptions {
  readonly format?: "json";
}

export interface ToolContextOptions {
  readonly repoRoot: string;
  readonly projectRoot: string;
  readonly taskName: string;
  readonly verbose?: boolean;
  readonly adapter?: RuntimeAdapter;
  readonly declaredDeps?: readonly string[];
  readonly depsOutputs?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly affected?: AffectedContext;
  readonly quietStdout?: boolean;
  readonly signal?: AbortSignal;
  readonly prefixOutput?: boolean;
  readonly stdoutWriter?: (chunk: string) => void;
  readonly stderrWriter?: (chunk: string) => void;
}

function normalizeJsonValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ToolError(`ctx.output value is not JSON-serializable: non-finite number ${value}`);
    }
    return value;
  }
  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    typeof value === "function"
  ) {
    throw new ToolError(`ctx.output value is not JSON-serializable: ${typeof value}`);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new ToolError("ctx.output value contains a circular reference.");
    }
    ancestors.add(value);
    const arr = value.map((item) => normalizeJsonValue(item, ancestors));
    ancestors.delete(value);
    return arr;
  }
  if (typeof value === "object") {
    if (ancestors.has(value)) {
      throw new ToolError("ctx.output value contains a circular reference.");
    }
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== null && proto !== Object.prototype) {
      throw new ToolError(
        `ctx.output value is not a plain JSON object (${value.constructor?.name ?? "object"}).`,
      );
    }
    ancestors.add(value);
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const prop = record[key];
      if (prop === undefined) {
        throw new ToolError(
          `ctx.output object key '${key}' has undefined value, which is not JSON-serializable.`,
        );
      }
      out[key] = normalizeJsonValue(prop, ancestors);
    }
    ancestors.delete(value);
    return out;
  }
  throw new ToolError(`ctx.output value is not JSON-serializable: ${typeof value}`);
}

export function canonicalJsonString(value: unknown): string {
  const normalized = normalizeJsonValue(value, new WeakSet<object>());
  return JSON.stringify(normalized);
}

export function createDepsProxy(
  taskName: string,
  declaredDeps: readonly string[],
  depsOutputs: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const declared = new Set(declaredDeps);
  return new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, prop): unknown {
        if (typeof prop !== "string") {
          return undefined;
        }
        if (prop === "toJSON") {
          return () => {
            const snapshot: Record<string, unknown> = {};
            for (const dep of declared) {
              if (dep in depsOutputs) {
                snapshot[dep] = depsOutputs[dep];
              }
            }
            return snapshot;
          };
        }
        if (!declared.has(prop)) {
          throw new ToolError(
            `Task '${taskName}' tried to read undeclared dependency '${prop}'; add it to depends first.`,
          );
        }
        return prop in depsOutputs ? depsOutputs[prop] : undefined;
      },
      has(_target, prop): boolean {
        return typeof prop === "string" && declared.has(prop);
      },
      ownKeys(): string[] {
        return [...declared];
      },
      getOwnPropertyDescriptor(_target, prop): PropertyDescriptor | undefined {
        if (typeof prop !== "string" || !declared.has(prop)) {
          return undefined;
        }
        return {
          enumerable: true,
          configurable: true,
          writable: false,
          value: depsOutputs[prop],
        };
      },
      set(): boolean {
        throw new ToolError(`ctx.deps is read-only inside task '${taskName}'.`);
      },
      deleteProperty(): boolean {
        throw new ToolError(`ctx.deps is read-only inside task '${taskName}'.`);
      },
    },
  );
}

export class ToolContext {
  readonly repoRoot: string;
  readonly projectRoot: string;
  readonly taskName: string;
  readonly verbose: boolean;
  readonly deps: Readonly<Record<string, unknown>>;
  readonly affected: AffectedContext;
  readonly signal: AbortSignal;
  private readonly adapter: RuntimeAdapter;
  private readonly quietStdout: boolean;
  private readonly customWriters: boolean;
  private readonly prefixOutput: boolean;
  private readonly stdoutWriter: (chunk: string) => void;
  private readonly stderrWriter: (chunk: string) => void;
  private readonly envState: Map<string, string>;
  private readonly accessedEnv = new Set<string>();
  private readonly commands: RecordedCommand[] = [];
  private bufferedOutput: BufferedOutput | undefined;

  constructor(options: ToolContextOptions) {
    this.repoRoot = options.repoRoot;
    this.projectRoot = options.projectRoot;
    this.taskName = options.taskName;
    this.verbose = options.verbose ?? false;
    this.adapter = options.adapter ?? createRuntimeAdapter();
    this.quietStdout = options.quietStdout ?? false;
    this.customWriters = options.stdoutWriter !== undefined || options.stderrWriter !== undefined;
    this.prefixOutput = options.prefixOutput ?? false;
    this.stdoutWriter = options.stdoutWriter ?? ((chunk) => process.stdout.write(chunk));
    this.stderrWriter = options.stderrWriter ?? ((chunk) => process.stderr.write(chunk));
    this.signal = options.signal ?? new AbortController().signal;
    this.affected = options.affected ?? new AffectedContext();
    this.deps = createDepsProxy(
      this.taskName,
      options.declaredDeps ?? [],
      options.depsOutputs ?? {},
    );
    this.envState = new Map<string, string>();
    const baseEnv = options.env ?? process.env;
    for (const [k, v] of Object.entries(baseEnv)) {
      if (typeof v === "string") {
        this.envState.set(k, v);
      }
    }
  }

  output(value: unknown, options: OutputOptions = {}): void {
    const format = options.format ?? OUTPUT_FORMAT_JSON;
    if (format !== OUTPUT_FORMAT_JSON) {
      throw new ToolError(
        `Unsupported ctx.output format '${String(format)}' in TypeScript runner; expected 'json'.`,
      );
    }
    const serialized = canonicalJsonString(value);
    const sha256 = createHash("sha256").update(serialized, "utf-8").digest("hex");
    this.bufferedOutput = {
      value: JSON.parse(serialized) as unknown,
      format: OUTPUT_FORMAT_JSON,
      serialized,
      sha256,
    };
  }

  commitOutput(): BufferedOutput | undefined {
    return this.bufferedOutput;
  }

  env(name: string, defaultValue?: string): string | undefined {
    this.accessedEnv.add(name);
    const val = this.envState.get(name);
    return val !== undefined ? val : defaultValue;
  }

  setEnv(name: string, value: string): void {
    this.accessedEnv.add(name);
    this.envState.set(name, String(value));
  }

  unsetEnv(name: string): void {
    this.accessedEnv.add(name);
    this.envState.delete(name);
  }

  async withEnv<T>(
    updates: Readonly<Record<string, string | undefined>>,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    const previous = new Map<string, string | undefined>();
    for (const [key, val] of Object.entries(updates)) {
      previous.set(key, this.envState.get(key));
      this.accessedEnv.add(key);
      if (val === undefined) {
        this.envState.delete(key);
      } else {
        this.envState.set(key, val);
      }
    }
    try {
      return await fn();
    } finally {
      for (const [key, prev] of previous.entries()) {
        if (prev === undefined) {
          this.envState.delete(key);
        } else {
          this.envState.set(key, prev);
        }
      }
    }
  }

  envSnapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.envState.entries()) {
      out[k] = v;
    }
    return out;
  }

  accessedEnvKeys(): string[] {
    return [...this.accessedEnv].sort();
  }

  recordedCommands(): readonly RecordedCommand[] {
    return [...this.commands];
  }

  run(argv: readonly string[], options: RunOptions = {}): CommandResult {
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      argv.some((part) => typeof part !== "string")
    ) {
      throw new ToolError("ctx.run requires an explicit argv array of strings (shell=false).");
    }

    const workdir =
      options.cwd === undefined
        ? this.projectRoot
        : isAbsolute(options.cwd)
          ? options.cwd
          : resolve(this.projectRoot, options.cwd);

    const mergedEnv: Record<string, string> = { ...this.envSnapshot() };
    if (options.env !== undefined) {
      for (const [k, v] of Object.entries(options.env)) {
        this.accessedEnv.add(k);
        mergedEnv[k] = v;
      }
    }

    const captureRequested = options.capture ?? false;
    const shouldCapture = captureRequested || this.quietStdout || this.customWriters;
    const spawnOptions: SpawnOptions = {
      cwd: workdir,
      capture: shouldCapture,
      env: mergedEnv,
      ...(options.timeoutSeconds !== undefined
        ? { timeoutMs: Math.max(1, Math.round(options.timeoutSeconds * 1000)) }
        : {}),
    };

    const raw = this.adapter.spawn(argv, spawnOptions);
    if (!captureRequested && (this.quietStdout || this.customWriters)) {
      if (this.quietStdout) {
        if (raw.stdout) {
          this.stderrWriter(raw.stdout);
        }
        if (raw.stderr) {
          this.stderrWriter(raw.stderr);
        }
      } else {
        if (raw.stdout) {
          this.stdoutWriter(raw.stdout);
        }
        if (raw.stderr) {
          this.stderrWriter(raw.stderr);
        }
      }
    }
    if (raw.timedOut) {
      throw new ToolError(
        `Command timed out after ${options.timeoutSeconds ?? "?"}s: ${argv.join(" ")}`,
      );
    }
    if (raw.spawnError) {
      throw new ToolError(`Executable not found or failed to start: ${argv[0]}`);
    }

    const result = new CommandResult({
      argv: [...argv],
      exitCode: raw.exitCode,
      stdout: raw.stdout,
      stderr: raw.stderr,
    });
    this.commands.push({ argv: [...argv], exitCode: result.exitCode, cwd: workdir });
    if ((options.check ?? true) && result.exitCode !== 0) {
      throw new ToolError(
        `Command failed with exit code ${result.exitCode}: ${argv.join(" ")}`,
        result.exitCode,
      );
    }
    return result;
  }

  async spawn(argv: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      argv.some((part) => typeof part !== "string")
    ) {
      throw new ToolError("ctx.spawn requires an explicit argv array of strings (shell=false).");
    }

    const workdir =
      options.cwd === undefined
        ? this.projectRoot
        : isAbsolute(options.cwd)
          ? options.cwd
          : resolve(this.projectRoot, options.cwd);

    const mergedEnv: Record<string, string> = { ...this.envSnapshot() };
    if (options.env !== undefined) {
      for (const [k, v] of Object.entries(options.env)) {
        this.accessedEnv.add(k);
        mergedEnv[k] = v;
      }
    }

    const captureRequested = options.capture ?? false;
    const shouldCapture = captureRequested || this.quietStdout;
    const prefix = this.prefixOutput && !captureRequested ? `[${this.taskName}] ` : "";
    const writeLine = (target: (chunk: string) => void, line: string): void => {
      target(prefix ? `${prefix}${line}` : line);
    };

    const spawnOptions: SpawnOptions = {
      cwd: workdir,
      capture: shouldCapture,
      env: mergedEnv,
      signal: this.signal,
      ...(this.prefixOutput && !shouldCapture
        ? {
            onStdoutLine: (line: string) => writeLine(this.stdoutWriter, line),
            onStderrLine: (line: string) => writeLine(this.stderrWriter, line),
          }
        : {}),
      ...(options.timeoutSeconds !== undefined
        ? { timeoutMs: Math.max(1, Math.round(options.timeoutSeconds * 1000)) }
        : {}),
    };

    const raw = this.adapter.spawnAsync
      ? await this.adapter.spawnAsync(argv, spawnOptions)
      : this.adapter.spawn(argv, spawnOptions);

    if (this.quietStdout && !captureRequested) {
      if (raw.stdout) {
        this.stderrWriter(raw.stdout);
      }
      if (raw.stderr) {
        this.stderrWriter(raw.stderr);
      }
    }
    if (raw.cancelled || this.signal.aborted) {
      throw new ToolError(`Command cancelled: ${argv.join(" ")}`, 130);
    }
    if (raw.timedOut) {
      throw new ToolError(
        `Command timed out after ${options.timeoutSeconds ?? "?"}s: ${argv.join(" ")}`,
      );
    }
    if (raw.spawnError) {
      throw new ToolError(`Executable not found or failed to start: ${argv[0]}`);
    }

    const result = new CommandResult({
      argv: [...argv],
      exitCode: raw.exitCode,
      stdout: raw.stdout,
      stderr: raw.stderr,
    });
    this.commands.push({ argv: [...argv], exitCode: result.exitCode, cwd: workdir });
    if ((options.check ?? true) && result.exitCode !== 0) {
      throw new ToolError(
        `Command failed with exit code ${result.exitCode}: ${argv.join(" ")}`,
        result.exitCode,
      );
    }
    return result;
  }
}
