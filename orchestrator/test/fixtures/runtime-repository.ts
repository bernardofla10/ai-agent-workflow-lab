import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DispatchPlanner } from "../../src/dispatch/dispatch-planner.js";
import type { CodexResult } from "../../src/integrations/codex/codex-runner.js";

export async function runtimeRepository() {
  const root = await mkdtemp(join(tmpdir(), "worker-dispatch-"));
  const repositoryRoot = join(root, "repo with spaces $(touch injected)");
  const execute = promisify(execFile);
  const git = async (args: string[], cwd = repositoryRoot) =>
    (await execute("git", args, { cwd, encoding: "utf8" })).stdout.trim();
  const commit = async (message: string) => {
    await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false",
      "commit", "--allow-empty", "-m", message]);
    return git(["rev-parse", "HEAD"]);
  };
  await git(["init", "--initial-branch=main", repositoryRoot], root);
  await writeFile(join(repositoryRoot, ".gitignore"), ".ai-workflow/\n");
  await git(["add", ".gitignore"]);
  const baseCommit = await commit("base");
  return { root, repositoryRoot, git, commit, baseCommit,
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

export function plannedRun(baseCommit: string, ids = ["TEST-1"], id = "run-1") {
  return new DispatchPlanner(ids.length).plan({ id, createdAt: "2026-09-11T00:00:00.000Z",
    baseCommit, existingRuns: [], readyTickets: ids.map((ticketId) => ({
      id: ticketId, title: "Synthetic task", status: "backlog", blockedBy: [],
    })) });
}

export function codexResult(exitCode: number | null = 0, signal: string | null = null): CodexResult {
  return { exitCode, signal, startedAt: "2026-09-11T00:00:01.000Z", endedAt: "2026-09-11T00:00:02.000Z",
    stdout: "Worker output", stderr: "Worker diagnostics", stdoutTruncated: false, stderrTruncated: false };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
