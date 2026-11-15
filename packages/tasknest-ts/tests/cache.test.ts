import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CacheContext, lookupCache, storeCache } from "@/src/cache";
import { canonicalJsonString } from "@/src/context";
import { tool } from "@/src/task";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tasknest-cache-"));
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

describe("task caching", () => {
  it("hits on identical inputs/outputs and invalidates when output is deleted or modified", () => {
    const root = makeTempDir();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "src", "in.txt"), "hello", "utf-8");
    const outFile = join(root, "dist", "out.txt");
    writeFileSync(outFile, "built", "utf-8");

    const buildTask = tool(
      {
        name: "build",
        cache: true,
        inputs: ["src/*.txt"],
        outputs: ["dist/out.txt"],
        env: ["BUILD_MODE"],
      },
      () => {},
    );

    const ctx: CacheContext = {
      repoRoot: root,
      projectRoot: root,
      task: buildTask,
      kwargs: { target: "dev" },
      depHashes: { prep: "abc123" },
      baseEnv: { BUILD_MODE: "fast" },
    };

    expect(lookupCache(ctx).status).toBe("miss");
    const serialized = canonicalJsonString({ ok: true });
    const storedKey = storeCache(
      ctx,
      { DYNAMIC_FLAG: "1" },
      { value: { ok: true }, format: "json", serialized, sha256: "deadbeef" },
    );
    expect(storedKey).toBeDefined();

    const hitCtx: CacheContext = {
      ...ctx,
      baseEnv: { BUILD_MODE: "fast", DYNAMIC_FLAG: "1" },
    };
    const hit = lookupCache(hitCtx);
    expect(hit.status).toBe("hit");
    expect(hit.output?.value).toEqual({ ok: true });

    // Dynamic env change -> miss
    const dynMiss = lookupCache({
      ...ctx,
      baseEnv: { BUILD_MODE: "fast", DYNAMIC_FLAG: "2" },
    });
    expect(dynMiss.status).toBe("miss");

    // Deleted output -> miss
    rmSync(outFile);
    expect(existsSync(outFile)).toBe(false);
    const deletedMiss = lookupCache(hitCtx);
    expect(deletedMiss.status).toBe("miss");
    expect(deletedMiss.reason).toContain("missing declared output");

    // Modified output -> miss
    writeFileSync(outFile, "tampered", "utf-8");
    const modifiedMiss = lookupCache(hitCtx);
    expect(modifiedMiss.status).toBe("miss");
    expect(modifiedMiss.reason).toContain("modified declared output");
  });

  it("supports --force and --no-cache bypass modes", () => {
    const root = makeTempDir();
    const t = tool({ name: "t", cache: true }, () => {});
    const base: CacheContext = {
      repoRoot: root,
      projectRoot: root,
      task: t,
      kwargs: {},
      depHashes: {},
      baseEnv: {},
    };
    expect(lookupCache({ ...base, mode: "force" }).status).toBe("bypassed");
    expect(lookupCache({ ...base, mode: "no_cache" }).status).toBe("bypassed");
  });
});
