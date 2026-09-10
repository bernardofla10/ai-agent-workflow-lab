import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface Response {
  id: number;
  result?: {
    protocolVersion?: string;
    serverInfo?: { name: string };
    capabilities?: { tools?: unknown };
    tools?: { name: string; inputSchema: unknown; outputSchema: unknown;
      annotations: { readOnlyHint: boolean } }[];
    content?: { type: string; text: string }[];
    structuredContent?: unknown;
    isError?: boolean;
  };
  error?: unknown;
}

const a = { id: "A", title: "A", status: "done", blockedBy: [] };
const b = { id: "B", title: "B", status: "backlog", blockedBy: ["A"] };

describe.each(["npm entry point", "fake providers"])("MCP stdio server: %s", (mode) => {
  let child: ChildProcessWithoutNullStreams;
  let lines: AsyncIterableIterator<string>;
  let initialization: Response;
  let nextId = 0;
  let stderr = "";

  async function request(method: string, params: unknown): Promise<Response> {
    const id = ++nextId;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    while (true) {
      const line = await lines.next();
      if (line.done) throw new Error(`MCP exited before responding: ${stderr}`);
      // Banners or normal logs on stdout fail JSON parsing.
      const message = JSON.parse(line.value) as Response;
      if (message.id === id) return message;
    }
  }

  const call = (name: string, args: unknown = {}) =>
    request("tools/call", { name, arguments: args });

  beforeAll(async () => {
    const npm = mode === "npm entry point";
    child = spawn(npm ? "npm" : process.execPath, npm ? [
      "--prefix", fileURLToPath(new URL("../", import.meta.url)),
      "run", "--silent", "mcp",
    ] : ["--import", createRequire(import.meta.url).resolve("tsx"),
      fileURLToPath(new URL("./fixtures/mcp-server.ts", import.meta.url))], {
      cwd: tmpdir(), stdio: "pipe", detached: true,
      env: { ...process.env, LINEAR_API_KEY: "", LINEAR_PROJECT_ID: "", GITHUB_REPOSITORY: "" },
    });
    lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    await once(child, "spawn");
    initialization = await request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "mcp-startup-test", version: "1.0.0" },
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", method: "notifications/initialized",
    })}\n`);
  });

  afterAll(async () => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      process.kill(-child.pid, "SIGTERM");
      await exited;
    }
  });

  it("answers initialize from outside the project directory", () => {
    expect(initialization.error).toBeUndefined();
    expect(initialization.result).toMatchObject({
      protocolVersion: "2025-11-25", serverInfo: { name: "ai-workflow" }, capabilities: { tools: {} },
    });
  });

  it("advertises the four workflow tools with explicit input and output schemas", async () => {
    const response = await request("tools/list", {});
    expect(response.error).toBeUndefined();
    expect(response.result?.tools?.map(({ name }) => name).sort()).toEqual([
      "get_execution_waves", "get_project_graph", "get_pull_request_status", "get_ready_tickets",
    ]);
    for (const tool of response.result?.tools ?? []) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.outputSchema).toMatchObject({ type: "object" });
      expect(tool.annotations.readOnlyHint).toBe(true);
      if (tool.name === "get_pull_request_status") {
        expect(tool.inputSchema).toMatchObject({ required: ["number"], properties: { number: { type: "integer" } } });
      } else {
        expect(tool.inputSchema).toMatchObject({ properties: {} });
      }
    }
  });

  it.each([
    ["get_ready_tickets", { tickets: [] }],
    ["get_pull_request_status", { number: 0 }],
    ["get_pull_request_status", { number: "4" }],
    ["get_pull_request_status", {}],
  ])("rejects invalid arguments for %s without terminating", async (name, args) => {
    expect((await call(name as string, args)).result?.isError).toBe(true);
    expect((await request("tools/list", {})).error).toBeUndefined();
  });

  if (mode === "npm entry point") {
    it.each([
      ["get_project_graph", {}, "LINEAR_API_KEY"],
      ["get_ready_tickets", {}, "LINEAR_API_KEY"],
      ["get_execution_waves", {}, "LINEAR_API_KEY"],
      ["get_pull_request_status", { number: 4 }, "GITHUB_REPOSITORY"],
    ])("reports missing configuration for %s through MCP", async (name, args, message) => {
      const response = await call(name as string, args);
      expect(response.result?.isError).toBe(true);
      expect(response.result?.content?.[0]?.text).toContain(message);
    });
  } else {
    it.each([
      ["get_project_graph", {}, { tickets: [b, a] }],
      ["get_ready_tickets", {}, { tickets: [b] }],
      ["get_execution_waves", {}, { waves: [[a], [b]] }],
      ["get_pull_request_status", { number: 4 }, {
        number: 4, state: "MERGED", headBranch: "feature", baseBranch: "main", checks: [], ciResult: "none",
      }],
    ])("executes %s with matching text and structured results", async (name, args, expected) => {
      const response = await call(name as string, args);
      expect(response.error).toBeUndefined();
      expect(response.result?.isError).not.toBe(true);
      expect(response.result?.structuredContent).toEqual(expected);
      expect(response.result?.content).toEqual([{ type: "text", text: JSON.stringify(expected) }]);
    });

    it("reports provider errors and recovers for the next request", async () => {
      const response = await call("get_pull_request_status", { number: 404 });
      expect(response.result?.isError).toBe(true);
      expect(response.result?.content?.[0]?.text).toContain("PR unavailable");
      expect((await call("get_ready_tickets")).result?.structuredContent).toEqual({ tickets: [b] });
    });
  }
});
