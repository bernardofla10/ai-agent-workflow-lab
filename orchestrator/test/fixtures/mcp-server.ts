import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createWorkflowServer } from "../../src/mcp/server.js";
import { WorkflowService } from "../../src/services/workflow-service.js";

const service = new WorkflowService({
  getTickets: async () => [
    { id: "B", title: "B", status: "backlog", blockedBy: ["A"] },
    { id: "A", title: "A", status: "done", blockedBy: [] },
  ],
}, {
  getPullRequestStatus: async (number) => {
    if (number === 404) throw new Error("PR unavailable");
    return { number, state: "MERGED", headBranch: "feature", baseBranch: "main", checks: [], ciResult: "none" };
  },
});
serveStdio(() => createWorkflowServer(service));
