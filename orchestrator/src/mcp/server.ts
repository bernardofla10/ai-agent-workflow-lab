import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { pullRequestStatusSchema } from "../integrations/github/pull-request-adapter.js";
import type { WorkflowService } from "../services/workflow-service.js";

const ticketSchema = z.object({
  id: z.string(), title: z.string(),
  status: z.enum(["backlog", "in_progress", "in_review", "done", "failed"]),
  blockedBy: z.array(z.string()),
});
const ticketsSchema = z.object({ tickets: z.array(ticketSchema) });
const wavesSchema = z.object({ waves: z.array(z.array(ticketSchema)) });
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

function result<T extends object>(output: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

export function createWorkflowServer(service: WorkflowService): McpServer {
  const server = new McpServer({ name: "ai-workflow", version: "0.1.0" });
  const tools = [
    {
      name: "get_project_graph",
      description: "Fetch the configured Linear project's tickets and structural dependencies, including completed prerequisites.",
      outputSchema: ticketsSchema,
      run: () => service.getProjectGraph(),
    },
    {
      name: "get_ready_tickets",
      description: "Fetch Linear tickets and return backlog tickets whose dependencies are done. Does not check cycles.",
      outputSchema: ticketsSchema,
      run: () => service.getReadyTickets(),
    },
    {
      name: "get_execution_waves",
      description: "Fetch Linear tickets and return structural execution waves regardless of status. Rejects cycles.",
      outputSchema: wavesSchema,
      run: () => service.getExecutionWaves(),
    },
  ];
  for (const tool of tools) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: z.object({}).strict(),
      outputSchema: tool.outputSchema,
      annotations,
    }, async () => result(await tool.run()));
  }
  server.registerTool("get_pull_request_status", {
    description: "Read PR state, head/base branches and current checks from the configured GitHub repository through gh.",
    inputSchema: z.object({ number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
    outputSchema: pullRequestStatusSchema,
    annotations,
  }, async ({ number }) => result(await service.getPullRequestStatus(number)));
  return server;
}
