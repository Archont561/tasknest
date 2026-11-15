import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION, version } from "@/src/version";
import { expect, test } from "@/tests/test";

test("reads VERSION dynamically from package.json", () => {
  const pkgPath = join(import.meta.dir, "..", "package.json");
  const manifest = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
  expect(VERSION).toBe(manifest.version);
  expect(version).toBe(VERSION);
});
