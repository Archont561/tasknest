import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RuntimeAdapter } from "@/src/adapter";
import { runCli } from "@/src/cli";

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export interface CliInvokeOptions {
  readonly cwd?: string;
  readonly adapter?: RuntimeAdapter;
}

export class CliRunner {
  readonly root?: string;

  constructor(root?: string) {
    if (root !== undefined) {
      this.root = root;
    }
  }

  async invoke(args: readonly string[], options: CliInvokeOptions = {}): Promise<CliResult> {
    const argv =
      this.root !== undefined && !args.includes("--root")
        ? ["--root", this.root, ...args]
        : [...args];
    const outLines: string[] = [];
    const errLines: string[] = [];
    let capturedError: Error | undefined;
    let exitCode = 1;
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...items: unknown[]) => {
      outLines.push(items.map(String).join(" "));
    };
    console.error = (...items: unknown[]) => {
      errLines.push(items.map(String).join(" "));
    };

    try {
      exitCode = await runCli(argv, {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.adapter !== undefined ? { adapter: options.adapter } : {}),
        stdout: (line) => outLines.push(line),
        stderr: (line) => errLines.push(line),
      });
    } catch (err) {
      capturedError = err instanceof Error ? err : new Error(String(err));
      exitCode = 1;
    } finally {
      console.log = origLog;
      console.error = origErr;
    }

    return {
      exitCode,
      stdout: outLines.join("\n"),
      stderr: errLines.join("\n"),
      ...(capturedError !== undefined ? { error: capturedError } : {}),
    };
  }
}

export async function withIsolatedWorkspace<T>(
  files: Readonly<Record<string, string>>,
  fn: (workspace: string) => Promise<T> | T,
): Promise<T> {
  const workspace = mkdtempSync(join(tmpdir(), "tasknest-test-"));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const target = join(workspace, relPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf-8");
    }
    return await fn(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
