import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { workflowFromEnvironment } from "../config/workflow.js";
import { createWorkflowServer } from "./server.js";

serveStdio(() => createWorkflowServer(workflowFromEnvironment()), {
  onerror: () => console.error("MCP transport error"),
});
