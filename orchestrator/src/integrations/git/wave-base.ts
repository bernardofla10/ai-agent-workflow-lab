import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { baseCommitSchema } from "../../runtime/types.js";

export interface WaveBaseProvider {
  captureBaseCommit(): Promise<string>;
}

type GitRunner = (file: string, args: string[], options: {
  cwd: string; encoding: "utf8"; timeout: number;
}) => Promise<{ stdout: string; stderr: string }>;
const execute: GitRunner = promisify(execFile);

export class GitWaveBaseProvider implements WaveBaseProvider {
  constructor(private readonly repositoryRoot: string, private readonly run: GitRunner = execute) {}

  async captureBaseCommit(): Promise<string> {
    const options = { cwd: this.repositoryRoot, encoding: "utf8" as const, timeout: 30_000 };
    try {
      // Refresh main even when the clone has a restricted fetch refspec.
      await this.run("git", ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"], options);
      const { stdout } = await this.run("git", ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"], options);
      return baseCommitSchema.parse(stdout.trim());
    } catch {
      throw new Error("Unable to capture origin/main base commit; check repository and remote access");
    }
  }
}
