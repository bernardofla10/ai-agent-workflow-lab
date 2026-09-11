import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import type { WorkerResult } from "../../runtime/types.js";

export interface CodexResult extends WorkerResult {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface WorkerRunner {
  run(input: { cwd: string; prompt: string }): Promise<CodexResult>;
}

type SpawnProcess = (file: string, args: string[], options: {
  cwd: string; shell: false; stdio: "pipe"; env: NodeJS.ProcessEnv;
}) => ChildProcessWithoutNullStreams;

function capture() {
  let bytes = Buffer.alloc(0);
  let truncated = false;
  return {
    append(chunk: Buffer) {
      const available = 1024 * 1024 - bytes.length;
      if (chunk.length > available) truncated = true;
      bytes = Buffer.concat([bytes, chunk.subarray(0, available)]);
    },
    result: () => ({ text: bytes.toString("utf8"), truncated }),
  };
}

export class CodexRunner implements WorkerRunner {
  constructor(private readonly start: SpawnProcess = spawn) {}

  async run(input: { cwd: string; prompt: string }): Promise<CodexResult> {
    if (!isAbsolute(input.cwd) || !input.prompt.trim()) throw new Error("Worker needs an absolute cwd and a prompt");
    const startedAt = new Date().toISOString();
    // Keep CLI/MCP authentication, but prevent inherited Git routing from
    // redirecting the Worker's Git commands out of the assigned checkout.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    return new Promise((resolve, reject) => {
      const child = this.start("codex", ["--ask-for-approval", "never", "exec",
        "--sandbox", "workspace-write", "--color", "never", "-"], {
        cwd: input.cwd, shell: false, stdio: "pipe", env,
      });
      const stdout = capture();
      const stderr = capture();
      let processError = false;
      let inputError = false;
      child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
      child.once("error", () => { processError = true; });
      child.stdin.once("error", () => { inputError = true; });
      // Wait for close (including stream closure), not just exit or stdin errors.
      child.once("close", (exitCode, signal) => {
        if (processError || (inputError && exitCode === 0)) {
          reject(new Error("Codex could not start or receive the Worker prompt"));
          return;
        }
        resolve({ startedAt, endedAt: new Date().toISOString(), exitCode, signal,
          stdout: stdout.result().text, stderr: stderr.result().text,
          stdoutTruncated: stdout.result().truncated, stderrTruncated: stderr.result().truncated });
      });
      child.stdin.end(input.prompt, "utf8");
    });
  }
}
