import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { GitWaveBaseProvider } from "../src/integrations/git/wave-base.js";
import { DispatchPlanner } from "../src/dispatch/dispatch-planner.js";

describe("GitWaveBaseProvider", () => {
  it("fetches main before resolving a full commit using argument arrays and an explicit cwd", async () => {
    const run = vi.fn().mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${"a".repeat(40)}\n`, stderr: "" });
    expect(await new GitWaveBaseProvider("/repo with spaces", run).captureBaseCommit()).toBe("a".repeat(40));
    expect(run.mock.calls).toEqual([
      ["git", ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"],
        { cwd: "/repo with spaces", encoding: "utf8", timeout: 30_000 }],
      ["git", ["rev-parse", "--verify", "origin/main^{commit}"],
        { cwd: "/repo with spaces", encoding: "utf8", timeout: 30_000 }],
    ]);
  });

  it("stops on fetch failure and does not expose process diagnostics", async () => {
    const run = vi.fn().mockRejectedValue(new Error("secret remote credential"));
    await expect(new GitWaveBaseProvider("/repo", run).captureBaseCommit()).rejects.toThrow(/^Unable to capture origin\/main base commit; check repository and remote access$/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(["abc123", "origin/main", "", `${"a".repeat(40)}\n${"b".repeat(40)}`])(
    "rejects unresolved or ambiguous output %s", async (stdout) => {
      const run = vi.fn().mockResolvedValue({ stdout, stderr: "" });
      await expect(new GitWaveBaseProvider("/repo", run).captureBaseCommit()).rejects.toThrow("Unable to capture");
    },
  );

  it("rejects rev-parse failure", async () => {
    const run = vi.fn().mockResolvedValueOnce({ stdout: "", stderr: "" }).mockRejectedValueOnce(new Error("exit 128"));
    await expect(new GitWaveBaseProvider("/repo", run).captureBaseCommit()).rejects.toThrow("Unable to capture");
  });

  it("captures fresh origin/main in a real local repository while an existing wave retains its base", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-git-"));
    const execute = promisify(execFile);
    const git = (args: string[], cwd = root) => execute("git", args, { cwd, encoding: "utf8" });
    try {
      const remote = join(root, "origin.git");
      const source = join(root, "source");
      const clone = join(root, "clone with spaces");
      await git(["init", "--bare", "--initial-branch=main", remote]);
      await git(["clone", remote, source]);
      const commit = () => git(["-c", "user.name=Test", "-c", "user.email=test@example.com",
        "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "test wave base"], source);
      await commit();
      await git(["push", "origin", "main"], source);
      await git(["clone", remote, clone]);
      // A restricted fetch configuration must not leave origin/main stale.
      await git(["config", "remote.origin.fetch", "+refs/heads/other:refs/remotes/origin/other"], clone);
      const provider = new GitWaveBaseProvider(clone);
      const first = await provider.captureBaseCommit();
      const wave = new DispatchPlanner().plan({ id: "run-1", createdAt: "2026-09-11T00:00:00Z",
        baseCommit: first, existingRuns: [], readyTickets: [8, 9].map((id) => ({
          id: `BER-${id}`, title: "Task", status: "backlog", blockedBy: [],
        })) });
      await commit();
      await git(["push", "origin", "main"], source);
      const second = await provider.captureBaseCommit();
      expect(second).not.toBe(first);
      expect(second).toBe((await git(["rev-parse", "HEAD"], source)).stdout.trim());
      expect(wave.assignments.map((a) => a.baseCommit)).toEqual([first, first]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
