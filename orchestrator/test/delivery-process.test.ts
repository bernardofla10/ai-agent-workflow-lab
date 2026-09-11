import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDeliveryProcess } from "../src/delivery/process.js";

describe("delivery process boundary", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("passes metacharacters and newlines literally and clears inherited Git routing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "delivery-process-"));
    try {
      vi.stubEnv("GIT_DIR", "/wrong/repository");
      vi.stubEnv("GIT_INDEX_FILE", "/wrong/index");
      const literal = "$(touch injected); `false`\n--force";
      const output = await runDeliveryProcess(process.execPath, ["-e",
        "process.stdout.write(JSON.stringify({arg:process.argv[1],dir:process.env.GIT_DIR,index:process.env.GIT_INDEX_FILE,locks:process.env.GIT_OPTIONAL_LOCKS,cwd:process.cwd()}))", literal], cwd);
      expect(JSON.parse(output)).toEqual({ arg: literal, locks: "0", cwd });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("rejects nonzero exits without leaking captured diagnostics", async () => {
    await expect(runDeliveryProcess(process.execPath, ["-e", "console.error('secret'); process.exit(7)"], tmpdir()))
      .rejects.toThrow(/^Delivery .* operation failed; inspect locally before resuming$/);
  });
});
