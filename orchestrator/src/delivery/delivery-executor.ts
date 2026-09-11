import { randomUUID } from "node:crypto";
import { githubRepository } from "../config/environment.js";
import { StateStore } from "../runtime/state-store.js";
import { runIdSchema, type DeliveryState, type ExecutionRun, type WorkerAssignment } from "../runtime/types.js";
import { GitDelivery } from "./git-delivery.js";
import type { DeliveryGitHub } from "./github-delivery.js";

function commitMessage(delivery: DeliveryState): string {
  return `${delivery.ticketId}: automated trusted delivery\n\nDelivery-Attempt: ${delivery.attemptId}`;
}

export class DeliveryExecutor {
  constructor(private readonly store: StateStore, private readonly git: GitDelivery,
    private readonly github: DeliveryGitHub, private readonly repository: string) {
    githubRepository({ GITHUB_REPOSITORY: repository });
  }

  async deliver(runId: string): Promise<ExecutionRun> {
    runIdSchema.parse(runId);
    return this.store.withDispatchLock(async () => {
      let run = await this.store.load(runId);
      const save = async (assignment: WorkerAssignment) => {
        const next = structuredClone(run);
        next.assignments = next.assignments.map((old) => old.ticketId === assignment.ticketId ? structuredClone(assignment) : old);
        await this.store.save(next, run);
        run = next;
      };
      for (const original of run.assignments) {
        if (original.status !== "worker_completed") continue;
        if (original.supervision || original.reviewUncertain || original.reviewerVerdict ||
          (original.workerResult && (original.workerResult.exitCode !== 0 || original.workerResult.signal !== null))) {
          throw new Error("Assignment is not eligible for trusted delivery");
        }
        const assignment = structuredClone(original);
        let snapshot = await this.git.inspect(assignment);
        const remoteUrl = await this.git.remote(this.repository);
        if (!assignment.delivery) {
          if (snapshot.head !== assignment.baseCommit || !snapshot.dirty || assignment.pullRequest) {
            throw new Error("Delivery requires changes at baseCommit or a persisted delivery attempt");
          }
          if (await this.git.remoteHead(remoteUrl, assignment.branch) || (await this.github.discover(assignment.branch)).length) {
            throw new Error("Unowned remote branch or PR; delivery requires human inspection");
          }
          assignment.delivery = { attemptId: randomUUID(), ticketId: assignment.ticketId,
            repository: this.repository, repositoryRoot: this.git.root, branch: assignment.branch,
            worktreePath: assignment.worktreePath, baseCommit: assignment.baseCommit, remoteUrl, phase: "intent" };
          await save(assignment); // Durable identity BEFORE staging or any other Git mutation.
        }
        const delivery = assignment.delivery;
        if (delivery.repository !== this.repository || delivery.repositoryRoot !== this.git.root || delivery.remoteUrl !== remoteUrl) {
          throw new Error("Configured delivery identity differs from persisted intent");
        }
        if (delivery.tree && delivery.validation !== "isolated-v1") {
          throw new Error("Legacy delivery gates were not isolated; human reconciliation required");
        }
        const message = commitMessage(delivery);
        if (snapshot.head === assignment.baseCommit) {
          if (!["intent", "validated"].includes(delivery.phase) || !snapshot.dirty) throw new Error("Delivery commit disappeared or changes are missing");
          if (await this.git.remoteHead(remoteUrl, assignment.branch) || (await this.github.discover(assignment.branch)).length) {
            throw new Error("Remote delivery appeared before owned commit");
          }
          const tree = await this.git.stage(assignment);
          if (delivery.tree && delivery.tree !== tree) throw new Error("Working tree differs from validated delivery intent");
          await this.git.qualityGates(assignment);
          snapshot = await this.git.inspect(assignment);
          if (snapshot.head !== assignment.baseCommit || await this.git.stage(assignment) !== tree) {
            throw new Error("Worktree changed during independent quality gates");
          }
          delivery.validation = "isolated-v1";
          delivery.tree = tree;
          delivery.phase = "validated";
          await save(assignment); // Bind passing gates to the exact tree before commit.
          await this.git.commit(assignment, message);
        }
        if (!delivery.tree || delivery.phase === "intent") throw new Error("Commit has no persisted validation evidence");
        const commit = await this.git.proveCommit(assignment, delivery.tree, message);
        if (delivery.commit && delivery.commit !== commit) throw new Error("Delivery commit identity changed");
        if (delivery.phase === "validated") {
          delivery.commit = commit;
          delivery.phase = "committed";
          await save(assignment);
        }
        const remote = await this.git.remoteHead(remoteUrl, assignment.branch);
        if (remote && remote !== commit) throw new Error("Remote branch differs from exact delivery commit");
        if (!remote) {
          if (delivery.phase !== "committed") throw new Error("Previously pushed branch disappeared");
          await this.git.push(remoteUrl, assignment, commit);
          if (await this.git.remoteHead(remoteUrl, assignment.branch) !== commit) throw new Error("Push has no matching remote evidence");
        }
        if (delivery.phase === "committed") {
          delivery.phase = "pushed";
          await save(assignment);
        }
        let matches = await this.github.discover(assignment.branch);
        if (matches.length > 1) throw new Error("Ambiguous delivery PRs");
        if (!matches.length) {
          if (delivery.phase !== "pushed") throw new Error("PR creation outcome uncertain; rediscover later or inspect manually");
          delivery.phase = "pr_creating";
          await save(assignment);
          // Even if creation throws after reaching GitHub, restart only rediscovers.
          await this.github.create(assignment);
          matches = await this.github.discover(assignment.branch);
        }
        if (matches.length !== 1) throw new Error("Unable to rediscover exactly one delivery PR");
        const identity = matches[0]!;
        const pr = await this.github.inspect(identity);
        if (pr.id !== identity.id || pr.number !== identity.number || pr.repository !== this.repository ||
          pr.headBranch !== assignment.branch || pr.baseBranch !== "main" || pr.headCommit !== commit || pr.state !== "OPEN" ||
          (delivery.pullRequest && (delivery.pullRequest.nodeId !== pr.id || delivery.pullRequest.number !== pr.number))) {
          throw new Error("Rediscovered PR does not match delivery identity");
        }
        await this.git.proveCommit(assignment, delivery.tree, message);
        if (await this.git.remoteHead(remoteUrl, assignment.branch) !== commit) throw new Error("Remote changed during PR delivery");
        assignment.pullRequest = pr.number;
        assignment.status = "pr_open";
        delivery.pullRequest = { number: pr.number, nodeId: pr.id };
        delivery.phase = "complete";
        await save(assignment);
      }
      return run;
    });
  }
}
