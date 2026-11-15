import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@/src/config";
import { createTaskRegistry } from "@/src/discovery";
import { ValidationError } from "@/src/errors";
import { tool } from "@/src/task";
import { WatchSession } from "@/src/watch";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tasknest-watch-"));
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

describe("watch session dirty subgraph and self-output filtering", () => {
  it("re-runs only dirty subgraph and ignores unchanged hashes and own outputs", async () => {
    const root = makeTempDir();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "src", "a.txt"), "v1", "utf-8");
    writeFileSync(join(root, "src", "b.txt"), "b1", "utf-8");

    const runs: string[] = [];
    const prep = tool(
      {
        name: "prep",
        inputs: ["src/a.txt"],
        outputs: ["dist/prep.txt"],
      },
      (ctx) => {
        runs.push("prep");
        writeFileSync(join(ctx.projectRoot, "dist", "prep.txt"), "prep-out", "utf-8");
        ctx.output({ prep: "ok" });
      },
    );
    const build = tool(
      {
        name: "build",
        depends: [prep],
        inputs: ["src/b.txt"],
        outputs: ["dist/build.txt"],
      },
      (ctx) => {
        runs.push("build");
        writeFileSync(join(ctx.projectRoot, "dist", "build.txt"), String(ctx.deps.prep), "utf-8");
      },
    );

    const config = loadConfig(root);
    const registry = createTaskRegistry(config, {
      prep: {
        definition: prep,
        canonicalName: "prep",
        cliPath: ["prep"],
        sourcePath: "prep.ts",
        rootDir: root,
        projectRoot: root,
        description: "",
      },
      build: {
        definition: build,
        canonicalName: "build",
        cliPath: ["build"],
        sourcePath: "build.ts",
        rootDir: root,
        projectRoot: root,
        description: "",
      },
    });

    const session = new WatchSession(registry, "build", { useFsWatch: false });
    const initial = await session.runInitial();
    expect(initial.executed).toEqual(["prep", "build"]);
    expect(runs).toEqual(["prep", "build"]);

    // No changes -> step returns undefined
    expect(await session.step()).toBeUndefined();

    // Rewrite same content -> hash unchanged -> undefined
    writeFileSync(join(root, "src", "b.txt"), "b1", "utf-8");
    expect(await session.step()).toBeUndefined();

    // Change only b.txt -> prep is skipped clean, ctx.deps.prep is seeded, only build runs
    runs.length = 0;
    writeFileSync(join(root, "src", "b.txt"), "b2", "utf-8");
    const cycle2 = await session.step();
    expect(cycle2).toBeDefined();
    expect(cycle2?.skippedClean).toEqual(["prep"]);
    expect(cycle2?.executed).toEqual(["build"]);
    expect(runs).toEqual(["build"]);
  });

  it("early-cuts off downstream cached tasks when upstream input edits keep ctx.output identical", async () => {
    const root = makeTempDir();
    writeFileSync(join(root, "pyproject.toml"), "[project]\nversion = '0.2.0'\n", "utf-8");
    const runs: string[] = [];
    const readVer = tool(
      {
        name: "read_ver",
        inputs: ["pyproject.toml"],
        outputs: ["ver.txt"],
        cache: true,
      },
      (ctx) => {
        runs.push("read_ver");
        const text = readFileSync(join(ctx.projectRoot, "pyproject.toml"), "utf-8");
        const verLine = text.split("\n").find((l) => l.startsWith("version")) ?? "";
        const ver = verLine.split("=")[1]?.trim().replaceAll("'", "") ?? "";
        writeFileSync(join(ctx.projectRoot, "ver.txt"), ver, "utf-8");
        ctx.output({ version: ver });
      },
    );
    const downstream = tool(
      {
        name: "downstream",
        depends: [readVer],
        cache: true,
      },
      (ctx) => {
        runs.push("downstream");
        const ver = (ctx.deps.read_ver as { version: string }).version;
        writeFileSync(join(ctx.projectRoot, "out.txt"), ver, "utf-8");
      },
    );
    const config = loadConfig(root);
    const registry = createTaskRegistry(config, {
      read_ver: {
        definition: readVer,
        canonicalName: "read_ver",
        cliPath: ["read_ver"],
        sourcePath: "read_ver.ts",
        rootDir: root,
        projectRoot: root,
        description: "",
      },
      downstream: {
        definition: downstream,
        canonicalName: "downstream",
        cliPath: ["downstream"],
        sourcePath: "downstream.ts",
        rootDir: root,
        projectRoot: root,
        description: "",
      },
    });
    const session = new WatchSession(registry, "downstream", { useFsWatch: false });
    const init = await session.runInitial();
    expect(init.executed).toEqual(["read_ver", "downstream"]);

    // Edit pyproject.toml comment only -> read_ver runs, downstream hits cache (early cutoff!)
    runs.length = 0;
    writeFileSync(
      join(root, "pyproject.toml"),
      "[project]\n# comment\nversion = '0.2.0'\n",
      "utf-8",
    );
    const c2 = await session.step();
    expect(c2?.executed).toEqual(["read_ver"]);
    expect(c2?.report.cacheHits).toEqual(["downstream"]);
    expect(runs).toEqual(["read_ver"]);

    // Bump version -> downstream re-runs
    runs.length = 0;
    writeFileSync(join(root, "pyproject.toml"), "[project]\nversion = '0.3.0'\n", "utf-8");
    const c3 = await session.step();
    expect(c3?.executed).toEqual(["read_ver", "downstream"]);
    expect(readFileSync(join(root, "out.txt"), "utf-8")).toBe("0.3.0");
  });

  it("rejects persistent tasks in WatchSession", () => {
    const root = makeTempDir();
    const devTask = tool({ name: "dev", persistent: true }, () => {});
    const registry = createTaskRegistry(loadConfig(root), {
      dev: {
        definition: devTask,
        canonicalName: "dev",
        cliPath: ["dev"],
        sourcePath: "dev.ts",
        rootDir: root,
        projectRoot: root,
        description: "",
      },
    });
    expect(() => new WatchSession(registry, "dev", { useFsWatch: false })).toThrow(ValidationError);
  });
});
