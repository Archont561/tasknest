import { isAbsolute, resolve } from "node:path";
import { createRuntimeAdapter, type RuntimeAdapter, type SpawnOptions } from "@/src/adapter";
import { ToolError } from "@/src/errors";

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

export interface ToolContextOptions {
  readonly repoRoot: string;
  readonly projectRoot: string;
  readonly taskName: string;
  readonly verbose?: boolean;
  readonly adapter?: RuntimeAdapter;
}

export class ToolContext {
  readonly repoRoot: string;
  readonly projectRoot: string;
  readonly taskName: string;
  readonly verbose: boolean;
  private readonly adapter: RuntimeAdapter;

  constructor(options: ToolContextOptions) {
    this.repoRoot = options.repoRoot;
    this.projectRoot = options.projectRoot;
    this.taskName = options.taskName;
    this.verbose = options.verbose ?? false;
    this.adapter = options.adapter ?? createRuntimeAdapter();
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

    const spawnOptions: SpawnOptions = {
      cwd: workdir,
      capture: options.capture ?? false,
      ...(options.env !== undefined ? { env: { ...process.env, ...options.env } } : {}),
      ...(options.timeoutSeconds !== undefined
        ? { timeoutMs: Math.max(1, Math.round(options.timeoutSeconds * 1000)) }
        : {}),
    };

    const raw = this.adapter.spawn(argv, spawnOptions);
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
    if ((options.check ?? true) && result.exitCode !== 0) {
      throw new ToolError(
        `Command failed with exit code ${result.exitCode}: ${argv.join(" ")}`,
        result.exitCode,
      );
    }
    return result;
  }
}
