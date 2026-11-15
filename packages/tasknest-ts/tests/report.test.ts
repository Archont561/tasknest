import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildJsonReport,
  REDACTED_PLACEHOLDER,
  REPORT_SCHEMA_VERSION,
  redactArgv,
  redactText,
  writeJsonReport,
} from "@/src/report";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tasknest-report-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("report serialization and secret redaction", () => {
  it("redacts sensitive flags, URLs, bearer tokens, and known token prefixes", () => {
    const argv = [
      "curl",
      "--token",
      "supersecret",
      "--api-key=abc123",
      "https://user:pass123@example.com/pkg",
      "ghp_1234567890abcdef",
    ];
    const masked = redactArgv(argv, ["custom_secret"]);
    expect(masked).toEqual([
      "curl",
      "--token",
      REDACTED_PLACEHOLDER,
      `--api-key=${REDACTED_PLACEHOLDER}`,
      `https://${REDACTED_PLACEHOLDER}@example.com/pkg`,
      REDACTED_PLACEHOLDER,
    ]);
    expect(redactText("Bearer myJwtTokenValue custom_secret", ["custom_secret"])).toBe(
      `Bearer ${REDACTED_PLACEHOLDER} ${REDACTED_PLACEHOLDER}`,
    );
  });

  it("builds versioned JSON report and writes it to disk", () => {
    const dir = makeTempDir();
    const outPath = join(dir, "reports", "run.json");
    const records = [
      {
        name: "lint",
        status: "passed" as const,
        cacheStatus: "hit" as const,
        durationMs: 12.3456,
        commands: [{ argv: ["bun", "--token", "secret123"], exitCode: 0, cwd: dir }],
      },
    ];
    const payload = buildJsonReport(records, {
      target: "lint",
      jobs: 2,
      startedAt: "2026-11-15T00:00:00.000Z",
      durationMs: 25.5,
      exitCode: 0,
    });
    expect(payload.schema_version).toBe(REPORT_SCHEMA_VERSION);
    expect(payload.runner).toBe("typescript");
    expect(payload.status).toBe("passed");

    writeJsonReport(outPath, records, { target: "lint", exitCode: 0 });
    expect(existsSync(outPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(outPath, "utf-8")) as {
      tasks: { commands: { argv: string[] }[] }[];
    };
    expect(parsed.tasks[0]?.commands[0]?.argv).toEqual(["bun", "--token", REDACTED_PLACEHOLDER]);
  });
});
