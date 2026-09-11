import type { SupervisionGitHub } from "../integrations/github/supervision-adapter.js";
import { githubRepository } from "../config/environment.js";
import { workerAssignmentSchema, type WorkerAssignment } from "../runtime/types.js";
import { runDeliveryProcess, type DeliveryProcess } from "./process.js";

export interface DeliveryGitHub extends SupervisionGitHub {
  create(assignment: WorkerAssignment): Promise<void>;
}

export class GitHubDeliveryAdapter implements DeliveryGitHub {
  constructor(private readonly repository: string, private readonly root: string,
    private readonly github: SupervisionGitHub, private readonly process: DeliveryProcess = runDeliveryProcess) {
    githubRepository({ GITHUB_REPOSITORY: repository });
  }
  discover(branch: string) { return this.github.discover(branch); }
  inspect(identity: Parameters<SupervisionGitHub["inspect"]>[0]) { return this.github.inspect(identity); }

  async create(assignment: WorkerAssignment): Promise<void> {
    workerAssignmentSchema.parse(assignment);
    const body = `Automated trusted delivery for Linear issue ${assignment.ticketId}.

Problem: deliver the completed implementation for ${assignment.ticketId} from its assigned worktree.
Implementation: the validated tracked and untracked changes in this delivery commit.
Out of scope: other tickets, retries, deployment and automatic merge.
Validation: independently ran sample-app npm run lint, npm run typecheck, npm test, npm run build, and git diff --check (working tree and index).
Risks: local gates do not replace GitHub CI or independent review. Human merge required.
Delivery attempt: ${assignment.delivery!.attemptId}`;
    await this.process("gh", ["pr", "create", "--repo", this.repository,
      "--head", assignment.branch, "--base", "main", "--title", `${assignment.ticketId}: deliver implementation`, "--body", body], this.root);
  }
}
