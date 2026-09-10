import { calculateWaves } from "../graph/calculate-waves.js";
import { getReadyTickets } from "../graph/get-ready-tickets.js";
import { validateDependencies } from "../graph/validate-dependencies.js";
import type { TicketProvider } from "../integrations/linear/ticket-provider.js";
import type { PullRequestProvider } from "../integrations/github/pull-request-adapter.js";

export class WorkflowService {
  constructor(private readonly linear: TicketProvider, private readonly github: PullRequestProvider) {}

  async getProjectGraph() {
    const tickets = await this.linear.getTickets();
    validateDependencies(tickets);
    return { tickets };
  }

  async getReadyTickets() {
    const { tickets } = await this.getProjectGraph();
    return { tickets: getReadyTickets(tickets) };
  }

  async getExecutionWaves() {
    const { tickets } = await this.getProjectGraph();
    return { waves: calculateWaves(tickets) };
  }

  getPullRequestStatus(number: number) {
    return this.github.getPullRequestStatus(number);
  }
}
