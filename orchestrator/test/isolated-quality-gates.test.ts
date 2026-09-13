import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IsolatedQualityGates } from "../src/delivery/isolated-quality-gates.js";
import { GitDelivery } from "../src/delivery/git-delivery.js";
import { WorktreeManager } from "../src/integrations/git/worktree-manager.js";
import { plannedRun, runtimeRepository } from "./fixtures/runtime-repository.js";

// Required integration tests, not skipped when isolation is unavailable.
// CI and delivery hosts must provide bubblewrap + unprivileged user namespaces.
describe("isolated quality gates", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("runs all four gates while denying host credentials, Git/runtime writes, symlink escape and network", async () => {
    const repo = await runtimeRepository();
    const workspace = await mkdtemp(join(tmpdir(), "isolated-gates-"));
    const secret = join(repo.root, "host-secret");
    const runtime = join(repo.repositoryRoot, ".ai-workflow", "runtime.json");
    const server = createServer((socket) => socket.end("host-service"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test listener");
    try {
      await mkdir(join(repo.repositoryRoot, ".ai-workflow"));
      await writeFile(secret, "host credential");
      await writeFile(runtime, "original runtime");
      await mkdir(join(workspace, "sample-app"));
      await symlink(secret, join(workspace, "sample-app", "escape"));
      vi.stubEnv("GH_TOKEN", "delivery-token");
      vi.stubEnv("LINEAR_API_KEY", "linear-token");
      vi.stubEnv("NODE_OPTIONS", "--throw-deprecation");
      vi.stubEnv("SSH_AUTH_SOCK", join(repo.root, "agent.sock"));
      const scripts = Object.fromEntries(["lint", "typecheck", "test", "build"].map((gate) => [gate, `node probe.cjs ${gate}`]));
      await writeFile(join(workspace, "sample-app", "package.json"), JSON.stringify({ scripts }));
      await writeFile(join(workspace, "sample-app", "probe.cjs"), `
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const net = require('node:net');
for (const name of ['GH_TOKEN','LINEAR_API_KEY','SSH_AUTH_SOCK','NODE_OPTIONS']) assert.equal(process.env[name], undefined);
assert.equal(process.env.HOME, '/home/validator');
for (const file of [${JSON.stringify(secret)}, ${JSON.stringify(runtime)}, 'escape', '/workspace/.git', '/proc/1/root' + ${JSON.stringify(secret)}]) {
  assert.throws(() => fs.readFileSync(file));
}
assert.throws(() => fs.writeFileSync(${JSON.stringify(runtime)}, 'corrupt'));
assert.throws(() => execFileSync('git', ['--git-dir', ${JSON.stringify(join(repo.repositoryRoot, ".git"))}, 'update-ref', 'refs/heads/unrelated', ${JSON.stringify(repo.baseCommit)}], {stdio:'pipe'}));
const socket = net.connect(${address.port}, '127.0.0.1');
socket.on('connect', () => { console.error('host network reachable'); process.exit(1); });
socket.on('error', () => { fs.appendFileSync('/workspace/results', process.argv[2] + '\\n'); });
socket.setTimeout(1000, () => { socket.destroy(); process.exit(1); });
`);
      await new IsolatedQualityGates().run(workspace);
      expect(await readFile(join(workspace, "results"), "utf8")).toBe("lint\ntypecheck\ntest\nbuild\n");
      expect(await readFile(runtime, "utf8")).toBe("original runtime");
      expect(await repo.git(["branch", "--list", "unrelated"])).toBe("");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(workspace, { recursive: true, force: true });
      await repo.cleanup();
    }
  }, 20000);

  it("exports staged sources and dependencies without ignored host files or shared Git metadata", async () => {
    const repo = await runtimeRepository();
    try {
      await mkdir(join(repo.repositoryRoot, "sample-app"));
      await writeFile(join(repo.repositoryRoot, "sample-app", "package.json"), JSON.stringify({ scripts: {
        lint: "node check.cjs", typecheck: "node check.cjs", test: "node check.cjs", build: "node check.cjs",
      } }));
      await writeFile(join(repo.repositoryRoot, "sample-app", "check.cjs"), `
const fs = require('node:fs');
const assert = require('node:assert/strict');
for (const file of ['.env', '../.env', '../.git', '../.ai-workflow/state.json', 'node_modules/dependency/.env']) {
  assert.throws(() => fs.readFileSync(file));
}
assert.equal(fs.readFileSync('node_modules/dependency/input', 'utf8'), 'dependency');
assert.equal(fs.readFileSync('node_modules/.bin/input', 'utf8'), 'dependency');
`);
      await writeFile(join(repo.repositoryRoot, ".gitignore"), ".ai-workflow/\n.env\nnode_modules/\n");
      await repo.git(["add", "."]);
      repo.baseCommit = await repo.commit("gate fixture");
      const assignment = plannedRun(repo.baseCommit).assignments[0]!;
      const cwd = await new WorktreeManager(repo.repositoryRoot).create(assignment);
      await mkdir(join(cwd, "sample-app", "node_modules", "dependency"), { recursive: true });
      await writeFile(join(cwd, "sample-app", "node_modules", "dependency", "input"), "dependency");
      await mkdir(join(cwd, "sample-app", "node_modules", ".bin"));
      await symlink("../dependency/input", join(cwd, "sample-app", "node_modules", ".bin", "input"));
      await writeFile(join(cwd, "sample-app", "node_modules", "dependency", ".env"), "SECRET=dependency-token");
      await writeFile(join(cwd, "sample-app", ".env"), "SECRET=host-token");
      await writeFile(join(cwd, ".env"), "SECRET=root-token");
      await new GitDelivery(repo.repositoryRoot).qualityGates(assignment);
      expect(await repo.git(["status", "--porcelain"], cwd)).toBe("");
    } finally { await repo.cleanup(); }
  }, 20000);

  it("fails closed rather than falling back to the host when bubblewrap is missing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "unavailable-gates-"));
    try {
      vi.stubEnv("PATH", "/missing-bubblewrap");
      await expect(new IsolatedQualityGates().run(workspace)).rejects.toThrow("bubblewrap and user namespaces are required");
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });
});
