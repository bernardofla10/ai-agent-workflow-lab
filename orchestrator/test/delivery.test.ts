import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeCommand, parseCommand, type RuntimeDependencies } from "../src/cli/runtime-cli.js";
import { DeliveryExecutor } from "../src/delivery/delivery-executor.js";
import { GitDelivery } from "../src/delivery/git-delivery.js";
import { GitHubDeliveryAdapter, type DeliveryGitHub } from "../src/delivery/github-delivery.js";
import { runDeliveryProcess, type DeliveryProcess } from "../src/delivery/process.js";
import { DispatchExecutor } from "../src/dispatch/dispatch-executor.js";
import { WorktreeManager } from "../src/integrations/git/worktree-manager.js";
import type { PullRequestSnapshot } from "../src/integrations/github/supervision-adapter.js";
import { parseRun } from "../src/runtime/run-state.js";
import { StateStore } from "../src/runtime/state-store.js";
import { Supervisor } from "../src/supervision/supervisor.js";
import type { ExecutionRun, WorkerAssignment } from "../src/runtime/types.js";
import { deferred, plannedRun, runtimeRepository } from "./fixtures/runtime-repository.js";

// All mutations target temporary repositories. Network and npm gates are fakes.
describe("trusted delivery", () => {
  let repo: Awaited<ReturnType<typeof runtimeRepository>>;
  let store: StateStore;
  let assignment: WorkerAssignment;
  let cwd: string;
  let remote: string;
  let process: ReturnType<typeof vi.fn<DeliveryProcess>>;
  let github: DeliveryGitHub;
  let pr: PullRequestSnapshot | undefined;
  const url = "https://github.com/test/repo.git";
  const current = async () => (await store.load("run-1")).assignments[0]!;
  const git = () => new GitDelivery(repo.repositoryRoot, process);
  const deliver = () => new DeliveryExecutor(store, git(), github, "test/repo").deliver("run-1");
  const head = () => repo.git(["rev-parse", "HEAD"], cwd);
  const count = (command: string) => process.mock.calls.filter(([file, args]) => file === "git" && args.includes(command)).length;
  const dirty = () => writeFile(join(cwd, "sample-app", "tracked.txt"), "implementation\n");

  beforeEach(async () => {
    repo = await runtimeRepository();
    await repo.git(["config", "user.name", "Test"]);
    await repo.git(["config", "user.email", "test@example.com"]);
    await mkdir(join(repo.repositoryRoot, "sample-app"));
    await writeFile(join(repo.repositoryRoot, "sample-app", "tracked.txt"), "base\n");
    await repo.git(["add", "sample-app"]);
    repo.baseCommit = await repo.commit("application base");
    remote = join(repo.root, "remote.git");
    await repo.git(["init", "--bare", remote]);
    await repo.git(["remote", "add", "origin", url]);
    store = new StateStore(repo.repositoryRoot);
    const run = plannedRun(repo.baseCommit);
    await store.save(run);
    assignment = run.assignments[0]!;
    cwd = await new WorktreeManager(repo.repositoryRoot).create(assignment);
    const completed = structuredClone(run);
    completed.assignments[0]!.status = "worker_completed";
    await store.save(completed, run);
    assignment = completed.assignments[0]!;
    process = vi.fn(async (file, args, path) => {
      if (file === "npm") return "PASS";
      // Production validates GitHub identity. Only the fake transport goes local.
      return runDeliveryProcess(file, args.map((arg) => arg === url ? remote : arg), path);
    });
    pr = undefined;
    github = {
      discover: vi.fn(async () => pr ? [{ id: pr.id, number: pr.number }] : []),
      inspect: vi.fn(async () => pr!),
      create: vi.fn(async (entry) => {
        pr = { id: "pr-node", number: 42, repository: "test/repo", headBranch: entry.branch,
          baseBranch: "main", headCommit: await repo.git(["rev-parse", "HEAD"], git().path(entry)),
          state: "OPEN", ci: "pending", mergedAt: null, mergedBy: null };
      }),
    };
  });
  afterEach(async () => { vi.restoreAllMocks(); await repo.cleanup(); });

  it.each(["tracked", "untracked", "both", "staged", "deleted"])("delivers %s changes on the exact assignment branch", async (mode) => {
    if (["tracked", "both", "staged"].includes(mode)) await dirty();
    if (["untracked", "both"].includes(mode)) await writeFile(join(cwd, "sample-app", "new $(touch injected).txt"), "new\n");
    if (mode === "staged") await repo.git(["add", "."], cwd);
    if (mode === "deleted") await rename(join(cwd, "sample-app", "tracked.txt"), join(repo.root, "removed.txt"));
    await deliver();
    expect(await current()).toMatchObject({ status: "pr_open", pullRequest: 42,
      delivery: { phase: "complete", commit: await head(), ticketId: "TEST-1", branch: assignment.branch,
        repository: "test/repo", baseCommit: repo.baseCommit, worktreePath: assignment.worktreePath,
        pullRequest: { nodeId: "pr-node", number: 42 } } });
    expect(await repo.git(["symbolic-ref", "HEAD"], cwd)).toBe(`refs/heads/${assignment.branch}`);
    expect(await repo.git(["rev-parse", "main"])).toBe(repo.baseCommit);
    expect(await repo.git(["status", "--porcelain"], cwd)).toBe("");
    expect(await repo.git(["rev-list", "--count", `${repo.baseCommit}..HEAD`], cwd)).toBe("1");
    expect(process.mock.calls.filter(([file]) => file === "npm").map(([, args, path]) => [args, path])).toEqual(
      [["run", "lint"], ["run", "typecheck"], ["test"], ["run", "build"]].map((args) => [args, join(cwd, "sample-app")]),
    );
    expect(process.mock.calls.filter(([, args]) => args.includes("diff")).map(([, args]) => args.slice(4)))
      .toEqual([["diff", "--check"], ["diff", "--cached", "--check"]]);
    const commitCall = process.mock.calls.find(([, args]) => args.includes("commit"))!;
    expect(commitCall[1].slice(4, 8)).toEqual(["commit", "--no-gpg-sign", "--cleanup=verbatim", "-m"]);
    expect(commitCall[1].at(-1)).toContain((await current()).delivery!.attemptId);
    const push = process.mock.calls.find(([, args]) => args.includes("push"))!;
    expect(push[1].slice(-2)).toEqual([url, `${await head()}:refs/heads/${assignment.branch}`]);
    expect(push[1].some((arg) => arg.startsWith("+") || arg.includes("--force"))).toBe(false);
    await deliver();
    expect(count("commit")).toBe(1);
    expect(count("push")).toBe(1);
    expect(github.create).toHaveBeenCalledTimes(1);
    expect(github.discover).toHaveBeenCalledWith(assignment.branch);
  });

  it("fails closed without changes", async () => {
    await expect(deliver()).rejects.toThrow("requires changes");
    expect(count("add")).toBe(0);
    expect((await current()).delivery).toBeUndefined();
  });

  it("fails closed on the wrong branch", async () => {
    await dirty();
    await repo.git(["checkout", "-b", "feat/test-1-other"], cwd);
    await expect(deliver()).rejects.toThrow("branch");
    expect(count("commit")).toBe(0);
  });

  it.each(["path", "symlink", "repository"])("fails closed on wrong worktree %s", async (mode) => {
    await dirty();
    if (mode === "path") assignment.worktreePath = "../other";
    if (mode === "symlink") {
      const moved = `${cwd}-moved`;
      await rename(cwd, moved);
      await symlink(moved, cwd);
    }
    if (mode === "repository") {
      await rename(cwd, `${cwd}-moved`);
      await repo.git(["init", "--initial-branch", assignment.branch, cwd]);
    }
    await expect(git().inspect(assignment)).rejects.toThrow();
    expect(count("commit")).toBe(0);
  });

  it.each(["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer", "BISECT_LOG", "index.lock"])(
    "fails closed with %s in progress", async (marker) => {
      await dirty();
      const path = await repo.git(["rev-parse", "--path-format=absolute", "--git-path", marker], cwd);
      await writeFile(path, repo.baseCommit);
      await expect(deliver()).rejects.toThrow("in progress");
      expect(count("add")).toBe(0);
    },
  );

  it("fails closed with an unresolved index conflict", async () => {
    await repo.git(["checkout", "-b", "conflicting"], cwd);
    await dirty();
    await repo.git(["commit", "-am", "other"], cwd);
    await repo.git(["checkout", assignment.branch], cwd);
    await writeFile(join(cwd, "sample-app", "tracked.txt"), "assignment\n");
    await repo.git(["commit", "-am", "assignment"], cwd);
    await expect(repo.git(["merge", "conflicting"], cwd)).rejects.toThrow();
    await expect(deliver()).rejects.toThrow();
    expect(count("commit")).toBe(0);
  });

  it.each(["lint", "typecheck", "test", "build"])("%s failure prevents commit and push", async (gate) => {
    await dirty();
    const actual = process.getMockImplementation()!;
    process.mockImplementation(async (file, args, path) => {
      if (file === "npm" && args.includes(gate)) throw new Error("Gate failed");
      return actual(file, args, path);
    });
    await expect(deliver()).rejects.toThrow("Gate failed");
    expect(await head()).toBe(repo.baseCommit);
    expect(count("commit")).toBe(0);
    expect(count("push")).toBe(0);
    expect((await current()).delivery?.phase).toBe("intent");
  });

  it("checks untracked whitespace after staging", async () => {
    await writeFile(join(cwd, "new.txt"), "bad whitespace  \n");
    await expect(deliver()).rejects.toThrow();
    expect(count("commit")).toBe(0);
  });

  it("rejects content changes during quality gates", async () => {
    await dirty();
    const actual = process.getMockImplementation()!;
    process.mockImplementation(async (file, args, path) => {
      if (file === "npm" && args.includes("build")) await writeFile(join(cwd, "new.txt"), "generated\n");
      return actual(file, args, path);
    });
    await expect(deliver()).rejects.toThrow("changed during");
    expect(count("commit")).toBe(0);
  });

  it("persists identity before staging and passing tree evidence before commit", async () => {
    await dirty();
    const actual = process.getMockImplementation()!;
    process.mockImplementation(async (file, args, path) => {
      if (args.includes("add")) expect((await current()).delivery).toMatchObject({ phase: "intent", repository: "test/repo" });
      if (args.includes("commit")) expect((await current()).delivery).toMatchObject({ phase: "validated", tree: expect.any(String) });
      return actual(file, args, path);
    });
    await deliver();
  });

  it.each(["intent", "validated"])("does not mutate beyond an unpersistable %s", async (phase) => {
    await dirty();
    const save = store.save.bind(store);
    vi.spyOn(store, "save").mockImplementation(async (next, previous) => {
      if (next.assignments[0]!.delivery?.phase === phase) throw new Error("Disk failure");
      return save(next, previous);
    });
    await expect(deliver()).rejects.toThrow("Disk failure");
    expect(count("commit")).toBe(0);
    if (phase === "intent") expect(count("add")).toBe(0);
  });

  it.each(["commit", "push"])("recovers crash after %s without repeating successful mutations", async (boundary) => {
    await dirty();
    const actual = process.getMockImplementation()!;
    process.mockImplementation(async (file, args, path) => {
      const result = await actual(file, args, path);
      if (args.includes(boundary)) throw new Error("Simulated crash after effect");
      return result;
    });
    await expect(deliver()).rejects.toThrow("Simulated crash");
    expect((await current()).delivery?.phase).toBe(boundary === "commit" ? "validated" : "committed");
    process.mockImplementation(actual);
    store = new StateStore(repo.repositoryRoot);
    await deliver();
    expect(count("commit")).toBe(1);
    expect(count("push")).toBe(1);
    expect(process.mock.calls.filter(([file]) => file === "npm")).toHaveLength(4);
    expect((await current()).status).toBe("pr_open");
  });

  it("push failure before side effect remains recoverable", async () => {
    await dirty();
    const actual = process.getMockImplementation()!;
    process.mockImplementation(async (file, args, path) => {
      if (args.includes("push")) throw new Error("Network failed");
      return actual(file, args, path);
    });
    await expect(deliver()).rejects.toThrow("Network failed");
    expect((await current()).delivery?.phase).toBe("committed");
    process.mockImplementation(actual);
    await deliver();
    expect(count("commit")).toBe(1);
    expect((await current()).status).toBe("pr_open");
  });

  const stopBeforePR = async () => {
    await dirty();
    vi.mocked(github.discover).mockImplementation(async () => {
      if ((await current()).delivery?.phase === "pushed") throw new Error("Discovery failed");
      return [];
    });
    await expect(deliver()).rejects.toThrow("Discovery failed");
    vi.mocked(github.discover).mockImplementation(async () => pr ? [{ id: pr.id, number: pr.number }] : []);
  };

  it("continues from an existing proven remote branch to PR creation", async () => {
    await stopBeforePR();
    await deliver();
    expect(count("commit")).toBe(1);
    expect(count("push")).toBe(1);
    expect(github.create).toHaveBeenCalledTimes(1);
  });

  it("rediscovers an existing PR without creating a duplicate", async () => {
    await stopBeforePR();
    await github.create(await current());
    vi.mocked(github.create).mockClear();
    await deliver();
    expect(github.create).not.toHaveBeenCalled();
    expect((await current()).pullRequest).toBe(42);
  });

  it("recovers PR creation response loss through authoritative rediscovery", async () => {
    await dirty();
    const create = github.create;
    github.create = vi.fn(async (entry) => { await create(entry); throw new Error("Response lost"); });
    await expect(deliver()).rejects.toThrow("Response lost");
    expect((await current()).delivery?.phase).toBe("pr_creating");
    await deliver();
    expect(github.create).toHaveBeenCalledTimes(1);
    expect((await current()).status).toBe("pr_open");
  });

  it("fails closed if creation intent exists but no PR can be found", async () => {
    await dirty();
    github.create = vi.fn().mockRejectedValue(new Error("Unknown outcome"));
    await expect(deliver()).rejects.toThrow("Unknown outcome");
    await expect(deliver()).rejects.toThrow("outcome uncertain");
    expect(github.create).toHaveBeenCalledTimes(1);
  });

  it.each([{ baseBranch: "develop" }, { repository: "other/repo" }, { headBranch: "feat/wrong" },
    { headCommit: "b".repeat(40) }, { state: "CLOSED" }, { id: "wrong" }, { number: 99 }])(
    "rejects mismatched PR evidence %j", async (mismatch) => {
      await stopBeforePR();
      await github.create(await current());
      github.inspect = vi.fn(async () => ({ ...pr!, ...mismatch }) as PullRequestSnapshot);
      await expect(deliver()).rejects.toThrow("does not match");
      expect((await current()).status).toBe("worker_completed");
    },
  );

  it("does not trust creation output without rediscovery", async () => {
    await dirty();
    github.create = vi.fn().mockResolvedValue("https://untrusted/42");
    await expect(deliver()).rejects.toThrow("rediscover");
    expect((await current()).pullRequest).toBeUndefined();
  });

  it("rejects ambiguous PR discovery", async () => {
    await stopBeforePR();
    github.discover = vi.fn().mockResolvedValue([{ id: "one", number: 1 }, { id: "two", number: 2 }]);
    await expect(deliver()).rejects.toThrow("Ambiguous");
    expect(github.create).not.toHaveBeenCalled();
  });

  it.each(["branch", "pr", "commit"])("rejects unowned preexisting %s", async (kind) => {
    await dirty();
    if (kind === "branch") await repo.git(["push", remote, `${repo.baseCommit}:refs/heads/${assignment.branch}`]);
    if (kind === "pr") await github.create(assignment);
    if (kind === "commit") await repo.git(["commit", "-am", "Unowned commit"], cwd);
    await expect(deliver()).rejects.toThrow();
    expect((await current()).delivery).toBeUndefined();
    expect(count("commit")).toBe(0);
  });

  it.each(["dirty", "commit", "remote", "deleted remote"])("rejects changed %s on resume", async (mode) => {
    await stopBeforePR();
    if (mode === "dirty") await writeFile(join(cwd, "new.txt"), "late changes\n");
    if (mode === "commit") await repo.git(["commit", "--allow-empty", "-m", "unrelated"], cwd);
    if (mode === "remote") {
      await repo.git(["update-ref", `refs/heads/${assignment.branch}`, repo.baseCommit], remote);
    }
    if (mode === "deleted remote") await repo.git(["update-ref", "-d", `refs/heads/${assignment.branch}`], remote);
    await expect(deliver()).rejects.toThrow();
    expect(count("push")).toBe(1);
    expect(github.create).not.toHaveBeenCalled();
  });

  it("rejects changed repository configuration before resuming", async () => {
    await stopBeforePR();
    await repo.git(["remote", "set-url", "origin", "https://github.com/other/repo.git"]);
    await expect(deliver()).rejects.toThrow("configured GitHub repository");
  });

  it.each(["attempt", "tree", "phase", "remove"])("prevents rewriting persisted delivery %s", async (field) => {
    await stopBeforePR();
    const previous = await store.load("run-1");
    const next = structuredClone(previous);
    const entry = next.assignments[0]!;
    if (field === "attempt") entry.delivery!.attemptId = "00000000-0000-4000-8000-000000000000";
    if (field === "tree") entry.delivery!.tree = "b".repeat(40);
    if (field === "phase") entry.delivery!.phase = "committed";
    if (field === "remove") delete entry.delivery;
    await expect(store.save(next, previous)).rejects.toThrow(/immutable|remove/);
  });

  it("rejects inconsistent delivery evidence", async () => {
    await stopBeforePR();
    const previous = await store.load("run-1");
    for (const patch of [{ ticketId: "TEST-2" }, { baseCommit: "b".repeat(40) }, { commit: undefined }, { tree: undefined }]) {
      const next = structuredClone(previous);
      Object.assign(next.assignments[0]!.delivery!, patch);
      expect(() => parseRun(next)).toThrow("Inconsistent delivery");
    }
  });

  it("holds the shared lock against concurrent delivery, dispatch and supervision", async () => {
    await dirty();
    const started = deferred<void>();
    const finished = deferred<void>();
    const actual = process.getMockImplementation()!;
    process.mockImplementation(async (file, args, path) => {
      if (file === "npm") { started.resolve(); await finished.promise; }
      return actual(file, args, path);
    });
    const pending = deliver();
    await started.promise;
    try {
      await expect(deliver()).rejects.toThrow("locked");
      await expect(new DispatchExecutor(repo.repositoryRoot, { run: vi.fn() }).dispatch("run-1")).rejects.toThrow("locked");
      await expect(new Supervisor(store, github, { review: vi.fn() }, "test/repo").supervise("run-1")).rejects.toThrow("locked");
    } finally { finished.resolve(); await pending; }
    expect(count("commit")).toBe(1);
  });

  it("supervision cannot bypass incomplete trusted delivery", async () => {
    await stopBeforePR();
    await github.create(await current());
    const review = vi.fn();
    await new Supervisor(store, github, { review }, "test/repo").supervise("run-1");
    expect((await current()).status).toBe("worker_completed");
    expect(review).not.toHaveBeenCalled();
  });

  it("resumes persisted Wave 2 worker_completed assignments through CLI without redispatch", async () => {
    // Reproduce IDs/status/schema of Wave 2 using only temporary worktrees.
    const wave = plannedRun(repo.baseCommit, ["BER-8", "BER-9"], "run-20260911184915781");
    const waveStore = new StateStore(repo.repositoryRoot, 3);
    await waveStore.save(wave);
    for (const entry of wave.assignments) {
      const path = await new WorktreeManager(repo.repositoryRoot).create(entry);
      await writeFile(join(path, "sample-app", entry.ticketId === "BER-8" ? "untracked.txt" : "tracked.txt"), "Wave 2 implementation\n");
    }
    const completed = structuredClone(wave);
    for (const entry of completed.assignments) entry.status = "worker_completed";
    await waveStore.save(completed, wave);
    const prs = new Map<string, PullRequestSnapshot>();
    const fake: DeliveryGitHub = {
      discover: async (branch) => prs.has(branch) ? [prs.get(branch)!] : [],
      inspect: async (identity) => [...prs.values()].find((item) => item.id === identity.id)!,
      create: async (entry) => { await github.create(entry); prs.set(entry.branch, { ...pr!, id: entry.ticketId, number: prs.size + 1 }); },
    };
    const forbidden = vi.fn(() => { throw new Error("Must not redispatch, plan, query Linear or invoke Codex"); });
    const deps: RuntimeDependencies = { store: waveStore, concurrency: 3, readyTickets: forbidden,
      captureBaseCommit: forbidden, inspectBaseCommit: forbidden, coordinator: { decide: forbidden },
      dispatch: forbidden, preview: forbidden, previewEphemeral: forbidden, supervise: forbidden,
      now: forbidden, deliver: (id) => new DeliveryExecutor(waveStore, git(), fake, "test/repo").deliver(id) };
    const result = await executeCommand(parseCommand(["deliver", "--run-id", wave.id]), deps) as ExecutionRun;
    expect(result.assignments.map((entry) => entry.status)).toEqual(["pr_open", "pr_open"]);
    expect(result.assignments.map((entry) => entry.worktreePath)).toEqual(completed.assignments.map((entry) => entry.worktreePath));
    expect(forbidden).not.toHaveBeenCalled();
    await executeCommand(parseCommand(["deliver", "--run-id", wave.id]), deps);
    expect(count("commit")).toBe(2);
    expect(count("push")).toBe(2);
    expect(await readFile(join(git().path(wave.assignments[0]!), "sample-app", "untracked.txt"), "utf8")).toBe("Wave 2 implementation\n");
  });

  it("creates PR with safe arguments and explicit main base", async () => {
    await stopBeforePR();
    const run = vi.fn<DeliveryProcess>().mockResolvedValue("untrusted output");
    const adapter = new GitHubDeliveryAdapter("test/repo", repo.repositoryRoot, github, run);
    await adapter.create(await current());
    const [file, args, path] = run.mock.calls[0]!;
    expect(file).toBe("gh");
    expect(path).toBe(repo.repositoryRoot);
    expect(args.slice(0, 10)).toEqual(["pr", "create", "--repo", "test/repo", "--head", assignment.branch, "--base", "main", "--title", "TEST-1: deliver implementation"]);
    expect(args.at(-1)).toContain("Automated trusted delivery for Linear issue TEST-1");
  });

  it("requires run ID and rejects delivery dry-run ambiguity", () => {
    expect(() => parseCommand(["deliver"])).toThrow("--run-id");
    expect(() => parseCommand(["deliver", "--run-id", "run-1", "--dry-run"])).toThrow("Invalid options");
  });
});
