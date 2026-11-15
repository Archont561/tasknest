import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AffectedContext,
  buildTsReverseMap,
  collectGitChanges,
  parseGitNameStatus,
  selectConservativeTargets,
} from "@/src/affected";
import { ToolError } from "@/src/errors";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tasknest-affected-"));
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

describe("affected selection and git diff parsing", () => {
  it("parses git diff --name-status -M and untracked lines", () => {
    const rawDiff = "M\tsrc/app.ts\nR100\tsrc/old.ts\tsrc/new.ts\nD\tsrc/gone.ts\n";
    const entries = parseGitNameStatus(rawDiff, "tests/extra.test.ts\n");
    expect(entries).toEqual([
      { path: "src/app.ts", status: "modified" },
      { path: "src/new.ts", status: "renamed", oldPath: "src/old.ts" },
      { path: "src/gone.ts", status: "deleted", oldPath: "src/gone.ts" },
      { path: "tests/extra.test.ts", status: "untracked" },
    ]);
  });

  it("collectGitChanges detects modified, renamed, and untracked files", () => {
    const repo = makeTempDir();
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n", "utf-8");
    writeFileSync(join(repo, "src", "b.ts"), "export const b = 2;\n", "utf-8");
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });

    writeFileSync(join(repo, "src", "a.ts"), "export const a = 10;\n", "utf-8");
    writeFileSync(join(repo, "src", "c.ts"), "export const c = 3;\n", "utf-8");

    const ctx = collectGitChanges(repo, { baseRef: "HEAD" });
    expect(ctx.available).toBe(true);
    expect(ctx.complete).toBe(true);
    expect(ctx.paths()).toContain("src/a.ts");
    expect(ctx.paths()).toContain("src/c.ts");
  });

  it("selectConservativeTargets narrows mapped changes and falls back safely", () => {
    const mapping = {
      "src/a.ts": ["tests/a.test.ts"],
      "src/b.ts": ["tests/b.test.ts"],
    };
    const narrowed = selectConservativeTargets(
      new AffectedContext({
        available: true,
        complete: true,
        files: [{ path: "src/a.ts", status: "modified" }],
      }),
      mapping,
    );
    expect(narrowed.targets).toEqual(["tests/a.test.ts"]);
    expect(narrowed.fallbackReason).toBeUndefined();

    const globalFallback = selectConservativeTargets(["package.json"], mapping);
    expect(globalFallback.targets).toEqual(["tests"]);
    expect(globalFallback.fallbackReason).toContain("global trigger changed");

    const renameFallback = selectConservativeTargets(
      [{ path: "src/renamed.ts", oldPath: "src/a.ts", status: "renamed" }],
      mapping,
    );
    expect(renameFallback.targets).toEqual(["tests"]);
    expect(renameFallback.fallbackReason).toContain("unmapped deletion/rename");

    expect(() =>
      selectConservativeTargets(new AffectedContext({ available: false }), mapping, {
        strict: true,
      }),
    ).toThrow(ToolError);
  });

  it("buildTsReverseMap builds reverse source-to-test map from @/ and relative imports", () => {
    const repo = makeTempDir();
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "tests"), { recursive: true });
    writeFileSync(
      join(repo, "src", "math.ts"),
      "export const add = (a: number, b: number) => a + b;\n",
    );
    writeFileSync(
      join(repo, "tests", "math.test.ts"),
      'import { add } from "@/src/math";\nexport const ok = add(1, 2);\n',
    );
    const reverse = buildTsReverseMap(repo, "src", "tests");
    expect(reverse["src/math.ts"]).toEqual(["tests/math.test.ts"]);
    expect(reverse["tests/math.test.ts"]).toEqual(["tests/math.test.ts"]);
  });
});
