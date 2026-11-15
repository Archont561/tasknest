import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION, version } from "@/src/index";
import { expect, test } from "@/tests/test";

test("exports VERSION and version matching package.json manifest", () => {
  const pkgPath = join(import.meta.dir, "..", "package.json");
  const manifest = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
  expect(VERSION).toBe(manifest.version);
  expect(version).toBe(VERSION);
  expect(VERSION).toEndWith("-dev.0");
});

test("every source module has a matching test file", () => {
  const pkgRoot = join(import.meta.dir, "..");
  const srcFiles = readdirSync(join(pkgRoot, "src"))
    .filter((name) => name.endsWith(".ts") && name !== "index.ts")
    .map((name) => name.slice(0, -3))
    .sort();
  const testFiles = new Set(
    readdirSync(join(pkgRoot, "tests"))
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => name.slice(0, -8)),
  );
  const missing = srcFiles.filter((mod) => !testFiles.has(mod));
  expect(missing).toEqual([]);
});
