import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexRunner } from "../src/integrations/codex/codex-runner.js";
import { CoordinatorRunner } from "../src/dispatch/coordinator-runner.js";
import { ReviewerRunner } from "../src/supervision/reviewer-runner.js";

const input = { repository: "test/repo", ticketId: "TEST-1", pullRequest: 42, headCommit: "a".repeat(40) };
const result = { ...input, verdict: "APPROVE", reason: "Independent evidence" };

describe("fresh structured Codex processes", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "structured-codex-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  const launch = (mode = "valid") => vi.fn((_file: string, args: string[], options: {
    cwd: string; shell: false; stdio: "pipe"; env: NodeJS.ProcessEnv;
  }) => {
    const output = args[args.indexOf("--output-last-message") + 1]!;
    const source = `import {writeFileSync,symlinkSync} from 'node:fs';
      process.stdin.resume(); process.stdin.on('end', () => {
        const [output, mode, result] = process.argv.slice(1);
        process.stdout.write('APPROVE is merely a log; never parse it.');
        if (mode === 'missing') return;
        if (mode === 'symlink') { symlinkSync('/dev/null',output); return; }
        writeFileSync(output, mode === 'invalid' ? 'Verdict: APPROVE' : mode === 'large' ? 'x'.repeat(1048577) : result);
        if (mode === 'exit') process.exitCode=7;
        if (mode === 'signal') process.kill(process.pid,'SIGTERM');
      });`;
    return spawn(process.execPath, ["--input-type=module", "-e", source, output, mode, JSON.stringify(result)], options);
  });

  it("starts a new read-only ephemeral exec for every Reviewer, using private schema/result files and literal stdin", async () => {
    const start = launch();
    const runner = new ReviewerRunner(cwd, new CodexRunner(start));
    expect(await runner.review(input)).toEqual(result);
    expect(await runner.review(input)).toEqual(result);
    expect(start).toHaveBeenCalledTimes(2);
    const paths: string[] = [];
    for (const [file, args, options] of start.mock.calls) {
      expect(file).toBe("codex");
      expect(args.slice(0, 10)).toEqual(["--ask-for-approval", "never", "exec", "--sandbox", "read-only",
        "--ephemeral", "--color", "never", "--output-schema", expect.any(String)]);
      expect(args).not.toContain("resume");
      expect(args.at(-1)).toBe("-");
      expect(options.cwd).toBe(cwd);
      expect(options.shell).toBe(false);
      const schema = args[args.indexOf("--output-schema") + 1]!;
      paths.push(schema);
      await expect(lstat(dirname(schema))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(paths[0]).not.toBe(paths[1]);
  });

  it.each(["missing", "invalid", "large", "symlink", "exit", "signal"])("rejects %s structured output without prose fallback", async (mode) => {
    const start = launch(mode);
    await expect(new ReviewerRunner(cwd, new CodexRunner(start)).review(input)).rejects.toThrow();
    const args = start.mock.calls[0]![1];
    await expect(lstat(dirname(args[args.indexOf("--output-schema") + 1]!))).rejects.toMatchObject({ code: "ENOENT" });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("supplies a strict output schema and a small live-source Reviewer prompt without Worker context", async () => {
    const runStructured = vi.fn(async (request) => {
      expect(request.schema.additionalProperties).toBe(false);
      expect(request.schema.required).toEqual(["repository", "ticketId", "pullRequest", "headCommit", "verdict", "reason"]);
      return result;
    });
    await new ReviewerRunner(cwd, { runStructured }).review(input);
    const request = runStructured.mock.calls[0]![0];
    expect(request.prompt).toContain("TEST-1, PR #42");
    expect(request.prompt).toContain(input.headCommit);
    expect(request.prompt).toContain("Linear MCP");
    expect(request.prompt).toContain("AGENTS.md");
    expect(request.prompt).toContain("agents/reviewer.md");
    expect(request.prompt).toContain("current-head CI");
    expect(request.prompt).toContain("independent of Worker reasoning");
    expect(request.prompt).toContain("Do not inspect other Workers' worktrees");
    expect(request.prompt).toContain("or merge anything");
    expect(request.prompt).not.toContain("Acceptance criteria:");
    expect(request.prompt).not.toContain("Worker output");
    expect(request.prompt.length).toBeLessThan(1500);
  });

  it("writes the requested schema before spawn with restricted local permissions", async () => {
    const start = launch();
    let schemaRead: Promise<string> | undefined;
    let modeRead: Promise<number> | undefined;
    const runner = new CodexRunner((file, args, options) => {
      const schema = args[args.indexOf("--output-schema") + 1]!;
      schemaRead = readFile(schema, "utf8");
      modeRead = lstat(schema).then((stat) => stat.mode & 0o777);
      return start(file, args, options);
    });
    await runner.runStructured({ cwd, prompt: "Literal $(touch injected) `echo nope`", schema: { type: "object" } });
    expect(JSON.parse(await schemaRead!)).toEqual({ type: "object" });
    expect(await modeRead).toBe(0o600);
    await expect(lstat(join(cwd, "injected"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["APPROVED", "REQUEST_CHANGES because", "BLOCKED", "approve"])("accepts no approximate verdict %s", async (verdict) => {
    await expect(new ReviewerRunner(cwd, { runStructured: async () => ({ ...result, verdict }) }).review(input)).rejects.toThrow();
  });

  it("rejects invalid identifiers before running Codex", async () => {
    const runStructured = vi.fn();
    await expect(new ReviewerRunner(cwd, { runStructured }).review({ ...input, ticketId: "TEST-1; rm -rf /" })).rejects.toThrow();
    expect(runStructured).not.toHaveBeenCalled();
  });
});

describe("Coordinator structured subset", () => {
  const wave = { baseCommit: "a".repeat(40), candidates: ["TEST-1", "TEST-2"] };
  it("only removes deterministic candidates through structured output", async () => {
    const runStructured = vi.fn().mockResolvedValue({ ...wave, allowed: ["TEST-2"] });
    expect(await new CoordinatorRunner("/repository", { runStructured }).decide(wave)).toEqual({ ...wave, allowed: ["TEST-2"] });
    const prompt = runStructured.mock.calls[0]![0].prompt;
    expect(prompt).toContain("deterministic scheduler is authoritative");
    expect(prompt).toContain("Linear MCP");
    expect(prompt).toContain("agents/coordinator.md");
    expect(prompt).not.toContain("Acceptance criteria:");
  });
  it.each([
    { allowed: ["TEST-3"] }, { allowed: ["TEST-1", "TEST-1"] }, { candidates: ["TEST-1"] },
    { baseCommit: "b".repeat(40) }, { extra: "ignored prose" },
  ])("rejects untrusted decision %j", async (patch) => {
    const runStructured = vi.fn().mockResolvedValue({ ...wave, allowed: [], ...patch });
    await expect(new CoordinatorRunner("/repository", { runStructured }).decide(wave)).rejects.toThrow();
    expect(runStructured).toHaveBeenCalledTimes(1);
  });
  it("allows blocking the entire wave", async () => {
    const runner = new CoordinatorRunner("/repository", { runStructured: async () => ({ ...wave, allowed: [] }) });
    expect((await runner.decide(wave)).allowed).toEqual([]);
  });
});
