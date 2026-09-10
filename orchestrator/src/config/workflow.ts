import { GitHubAdapter } from "../integrations/github/pull-request-adapter.js";
import { LinearTicketProvider } from "../integrations/linear/ticket-provider.js";
import { WorkflowService } from "../services/workflow-service.js";
import { githubRepository, requiredEnvironment } from "./environment.js";

// Resolve each integration lazily so missing Linear credentials do not disable PR reads.
export function workflowFromEnvironment(env = process.env): WorkflowService {
  return new WorkflowService({
    getTickets: () => LinearTicketProvider.fromApiKey(
      requiredEnvironment("LINEAR_API_KEY", env),
      requiredEnvironment("LINEAR_PROJECT_ID", env),
    ).getTickets(),
  }, {
    getPullRequestStatus: (number) => new GitHubAdapter(githubRepository(env)).getPullRequestStatus(number),
  });
}
