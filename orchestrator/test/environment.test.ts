import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeEnvironment } from "../src/config/environment.js";

describe("runtime dotenv configuration", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "runtime-env-"));
    await mkdir(join(root, "orchestrator"));
    for (const key of ["LINEAR_API_KEY", "LINEAR_PROJECT_ID", "GITHUB_REPOSITORY", "MAX_CONCURRENCY"]) vi.stubEnv(key, undefined);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

  it("loads the root key and fills missing project configuration from orchestrator/.env", async () => {
    await writeFile(join(root, ".env"), "LINEAR_API_KEY=root-key\nMAX_CONCURRENCY=1\n");
    await writeFile(join(root, "orchestrator/.env"), "LINEAR_API_KEY=older-key\nLINEAR_PROJECT_ID=synthetic-project\n");
    loadRuntimeEnvironment(root);
    expect(process.env.LINEAR_API_KEY).toBe("root-key");
    expect(process.env.LINEAR_PROJECT_ID).toBe("synthetic-project");
    expect(process.env.MAX_CONCURRENCY).toBe("1");
  });

  it("preserves explicitly exported variables over both files", async () => {
    vi.stubEnv("LINEAR_API_KEY", "exported-key");
    await writeFile(join(root, ".env"), "LINEAR_API_KEY=root-key\n");
    await writeFile(join(root, "orchestrator/.env"), "LINEAR_API_KEY=local-key\n");
    loadRuntimeEnvironment(root);
    expect(process.env.LINEAR_API_KEY).toBe("exported-key");
  });

  it("supports only orchestrator/.env without requiring a root file", async () => {
    await writeFile(join(root, "orchestrator/.env"), "LINEAR_API_KEY=local-key\n");
    loadRuntimeEnvironment(root);
    expect(process.env.LINEAR_API_KEY).toBe("local-key");
  });

  it("allows both files to be absent", () => {
    expect(() => loadRuntimeEnvironment(root)).not.toThrow();
    expect(process.env.LINEAR_API_KEY).toBeUndefined();
  });

  it("parses dotenv quotes/comments without shell expansion", async () => {
    await writeFile(join(root, ".env"), 'LINEAR_API_KEY="literal $(echo value)" # comment\n');
    loadRuntimeEnvironment(root);
    expect(process.env.LINEAR_API_KEY).toBe("literal $(echo value)");
  });

  it("fails on an inaccessible file without exposing its contents", async () => {
    await mkdir(join(root, ".env"));
    expect(() => loadRuntimeEnvironment(root)).toThrow("Unable to load runtime environment file");
  });
});
