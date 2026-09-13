import { LinearClient } from "@linear/sdk";
import { requiredEnvironment } from "../../config/environment.js";
import { ticketIdSchema } from "../../runtime/types.js";

export interface LinearCompletion {
  reconcile(ticketId: string): Promise<{ issueId: string; completedStateId: string }>;
}

export interface CompletionSource {
  issue(id: string): PromiseLike<{
    id: string; identifier: string;
    team: PromiseLike<{ id: string } | undefined> | undefined;
    state: PromiseLike<{ id: string; type: string } | undefined> | undefined;
  }>;
  workflowState(id: string): PromiseLike<{
    id: string; type: string; team: PromiseLike<{ id: string } | undefined> | undefined;
  }>;
  updateIssue(id: string, input: { stateId: string }): PromiseLike<{ success: boolean }>;
}

export class LinearCompletionAdapter implements LinearCompletion {
  constructor(private readonly source: CompletionSource, private readonly doneStateId?: string) {}

  static fromEnvironment(env = process.env): LinearCompletionAdapter {
    return new LinearCompletionAdapter(new LinearClient({ apiKey: requiredEnvironment("LINEAR_API_KEY", env) }),
      env.LINEAR_DONE_STATE_ID?.trim());
  }

  async reconcile(ticketId: string): Promise<{ issueId: string; completedStateId: string }> {
    ticketIdSchema.parse(ticketId);
    try {
      const issue = await this.source.issue(ticketId);
      if (issue.identifier !== ticketId) throw new Error("Issue identity mismatch");
      const state = await issue.state;
      if (!state) throw new Error("Missing issue state");
      if (state.type === "completed") return { issueId: issue.id, completedStateId: state.id };
      if (!this.doneStateId) throw new Error("Missing completed state configuration");
      const target = await this.source.workflowState(this.doneStateId);
      const team = await issue.team;
      const targetTeam = await target.team;
      if (target.id !== this.doneStateId || target.type !== "completed" || !team || targetTeam?.id !== team.id) {
        throw new Error("Completed state does not belong to issue team");
      }
      if (!(await this.source.updateIssue(issue.id, { stateId: target.id })).success) throw new Error("Update failed");
      const verified = await this.source.issue(issue.id);
      const completed = await verified.state;
      if (verified.id !== issue.id || verified.identifier !== ticketId || (await verified.team)?.id !== team.id ||
        completed?.type !== "completed") throw new Error("Completion verification failed");
      return { issueId: issue.id, completedStateId: completed.id };
    } catch {
      // SDK errors can contain authentication headers. Persist only safe diagnostics.
      throw new Error("Unable to reconcile Linear completion");
    }
  }
}
