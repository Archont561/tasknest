import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface PackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
}

function readPackageVersion(): string {
  const candidates = [
    fileURLToPath(new URL("../package.json", import.meta.url)),
    fileURLToPath(new URL("../../package.json", import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as PackageManifest;
    if (
      parsed.name === "@archont561/tasknest" &&
      typeof parsed.version === "string" &&
      parsed.version
    ) {
      return parsed.version;
    }
  }
  throw new Error("Unable to locate tasknest package.json manifest to determine VERSION.");
}

export const VERSION: string = readPackageVersion();
export const version: string = VERSION;
