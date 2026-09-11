import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexRunner } from "../src/integrations/codex/codex-runner.js";

describe("CodexRunner with a harmless Node process in place of Codex", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "codex-runner-")); });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(cwd, { recursive: true, force: true }); });

  const launchNode = (source: string) => vi.fn((_file: string, _args: string[], options: {
    cwd: string; shell: false; stdio: "pipe"; env: NodeJS.ProcessEnv;
  }) => spawn(process.execPath, ["--input-type=module", "-e", source], options));

  it("uses supported CLI options, literal stdin, separate output streams and the assigned cwd", async () => {
    vi.stubEnv("GIT_DIR", "/unsafe-git-dir");
    const launch = launchNode(`let prompt = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => { prompt += chunk; });
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({ cwd: process.cwd(), prompt, gitDir: process.env.GIT_DIR }));
        process.stderr.write("diagnostic");
      });`);
    const prompt = "Literal $(touch injected); `echo no`\nTask instructions";
    const result = await new CodexRunner(launch).run({ cwd, prompt });
    expect(launch).toHaveBeenCalledTimes(1);
    const [file, args, options] = launch.mock.calls[0]!;
    // Never include the inherited authentication environment in assertion diffs.
    expect([file, args, { cwd: options.cwd, shell: options.shell, stdio: options.stdio }]).toEqual([
      "codex", ["--ask-for-approval", "never", "exec", "--sandbox", "workspace-write", "--color", "never", "-"],
      { cwd, shell: false, stdio: "pipe" },
    ]);
    expect(options.env.GIT_DIR).toBeUndefined();
    expect(JSON.parse(result.stdout)).toEqual({ cwd, prompt });
    expect(result.stderr).toBe("diagnostic");
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
    expect(Date.parse(result.endedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
  });

  it("returns a nonzero exit code and captures its output", async () => {
    const launch = launchNode(`process.stdin.resume(); process.stdin.on("end", () => {
      process.stdout.write("partial output"); process.stderr.write("failure detail"); process.exitCode = 7;
    });`);
    const result = await new CodexRunner(launch).run({ cwd, prompt: "Test" });
    expect(result).toMatchObject({ exitCode: 7, signal: null, stdout: "partial output", stderr: "failure detail" });
  });

  it("captures signal termination without reporting success", async () => {
    const launch = launchNode(`process.stdin.resume();
      process.stdin.on("end", () => process.kill(process.pid, "SIGTERM"));`);
    expect(await new CodexRunner(launch).run({ cwd, prompt: "Test" })).toMatchObject({ exitCode: null, signal: "SIGTERM" });
  });

  it("bounds retained output while draining both streams until the process closes", async () => {
    const launch = launchNode(`process.stdin.resume(); process.stdin.on("end", () => {
      process.stdout.write("x".repeat(2 * 1024 * 1024));
      process.stderr.write("y".repeat(2 * 1024 * 1024));
    });`);
    const result = await new CodexRunner(launch).run({ cwd, prompt: "Test" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(1024 * 1024);
    expect(result.stderr.length).toBe(1024 * 1024);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
  });

  it("reports spawn failure without copying raw diagnostics", async () => {
    const launch = vi.fn((_file: string, _args: string[], options: { cwd: string; shell: false; stdio: "pipe" }) =>
      spawn(join(cwd, "missing-secret-executable"), [], options));
    await expect(new CodexRunner(launch).run({ cwd, prompt: "Test" })).rejects.toThrow(/^Codex could not start or receive the Worker prompt$/);
  });

  it("retains a failure exit code even if the process closes stdin before consuming the prompt", async () => {
    const launch = launchNode(`process.stdin.destroy(); process.stderr.write("early failure"); process.exitCode = 4;`);
    const result = await new CodexRunner(launch).run({ cwd, prompt: "x".repeat(2 * 1024 * 1024) });
    expect(result).toMatchObject({ exitCode: 4, signal: null, stderr: "early failure" });
  });

  it("rejects invalid launch inputs before starting a process", async () => {
    const launch = launchNode("");
    await expect(new CodexRunner(launch).run({ cwd: "relative/path", prompt: "Test" })).rejects.toThrow("absolute cwd");
    await expect(new CodexRunner(launch).run({ cwd, prompt: " " })).rejects.toThrow("prompt");
    expect(launch).not.toHaveBeenCalled();
  });
});
