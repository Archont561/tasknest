import { readdirSync } from "node:fs";
import { join } from "node:path";
import { version } from "@/src/index";
import { expect, test } from "@/tests/test";

test("exports a development version", () => {
  expect(version).toEndWith("-dev.0");
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
