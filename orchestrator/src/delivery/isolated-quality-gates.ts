import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

export interface QualityGateRunner { run(workspace: string): Promise<void> }
const execute = promisify(execFile);

// Only a disposable copy is mounted. Never bind the host root, home, assigned
// worktree, shared .git directory, runtime state, sockets or credential files.
export class IsolatedQualityGates implements QualityGateRunner {
  async run(workspace: string): Promise<void> {
    if (process.platform !== "linux") throw new Error("Isolated delivery gates require Linux and bubblewrap");
    const node = await realpath(process.execPath);
    const npm = await realpath(join(dirname(node), "../lib/node_modules/npm"));
    if (!(await lstat(workspace)).isDirectory() || await realpath(workspace) !== workspace) {
      throw new Error("Invalid isolated validation workspace");
    }
    const isolation = ["--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts",
      "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv",
      "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib",
      "--ro-bind-try", "/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev",
      "--tmpfs", "/tmp", "--dir", "/home/validator", "--dir", "/toolchain/bin",
      "--ro-bind", node, "/toolchain/bin/node", "--ro-bind", npm, "/toolchain/npm",
      "--symlink", "../npm/bin/npm-cli.js", "/toolchain/bin/npm",
      "--symlink", "../npm/bin/npx-cli.js", "/toolchain/bin/npx",
      "--bind", workspace, "/workspace", "--chdir", "/workspace/sample-app",
      "--setenv", "HOME", "/home/validator", "--setenv", "PATH", "/toolchain/bin:/usr/bin:/bin",
      "--setenv", "CI", "true", "--setenv", "LANG", "C.UTF-8",
      "--setenv", "npm_config_cache", "/tmp/npm-cache",
      "--setenv", "npm_config_userconfig", "/tmp/empty-user-npmrc", "--setenv", "npm_config_globalconfig", "/tmp/empty-global-npmrc"];
    for (const gate of [["run", "lint"], ["run", "typecheck"], ["test"], ["run", "build"]]) {
      try {
        // No delivery process adapter: no inherited credentials even in bwrap's
        // own process. Namespace/setup failure is fatal; there is no host fallback.
        await execute("bwrap", [...isolation, "--", "/toolchain/bin/node", "/toolchain/npm/bin/npm-cli.js", ...gate], {
          cwd: "/", shell: false, env: { PATH: process.env.PATH },
          timeout: 10 * 60_000, maxBuffer: 10 * 1024 * 1024,
        });
      } catch {
        throw new Error(`Isolated quality gate failed: npm ${gate.join(" ")}; bubblewrap and user namespaces are required`);
      }
    }
  }
}
