import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "@/src/index";
import { expect, test } from "@/tests/test";

test("package.json exposes tasknest bin and src/bin.ts runs under Bun", () => {
  const pkgRoot = join(import.meta.dir, "..");
  const manifest = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8")) as {
    bin?: Record<string, string>;
  };
  expect(manifest.bin?.tasknest).toBe("./dist/bin.js");

  const binSrc = join(pkgRoot, "src", "bin.ts");
  expect(existsSync(binSrc)).toBe(true);
  expect(readFileSync(binSrc, "utf-8").startsWith("#!/usr/bin/env node\n")).toBe(true);

  const proc = spawnSync(process.execPath, [binSrc, "--version"], {
    cwd: pkgRoot,
    encoding: "utf-8",
  });
  expect(proc.status).toBe(0);
  expect(proc.stdout.trim()).toBe(`tasknest ${VERSION}`);
});
