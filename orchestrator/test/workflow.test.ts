import { describe, expect, it, vi } from "vitest";
import type { Ticket } from "../src/domain/ticket.js";
import { WorkflowService } from "../src/services/workflow-service.js";
import { normalizePullRequest } from "../src/integrations/github/pull-request-adapter.js";
import { workflowFromEnvironment } from "../src/config/workflow.js";
import { githubRepository, requiredEnvironment } from "../src/config/environment.js";

const a: Ticket = { id: "A", title: "A", status: "done", blockedBy: [] };
const b: Ticket = { id: "B", title: "B", status: "backlog", blockedBy: ["A"] };
const c: Ticket = { id: "C", title: "C", status: "backlog", blockedBy: ["B"] };
const github = { getPullRequestStatus: vi.fn().mockResolvedValue(normalizePullRequest({
  number: 4, state: "MERGED", headRefName: "feature", baseRefName: "main", statusCheckRollup: [],
})) };

describe("WorkflowService with fake providers", () => {
  it("returns the graph, ready subset and structural waves including done tickets", async () => {
    const tickets = [c, b, a];
    const service = new WorkflowService({ getTickets: async () => tickets }, github);
    expect(await service.getProjectGraph()).toEqual({ tickets });
    expect(await service.getReadyTickets()).toEqual({ tickets: [b] });
    expect(await service.getExecutionWaves()).toEqual({ waves: [[a], [b], [c]] });
    expect(tickets).toEqual([c, b, a]);
  });

  it("fetches fresh state on every call", async () => {
    const provider = { getTickets: vi.fn().mockResolvedValueOnce([a, b])
      .mockResolvedValueOnce([a, { ...b, status: "done" }, c]) };
    const service = new WorkflowService(provider, github);
    expect((await service.getReadyTickets()).tickets).toEqual([b]);
    expect((await service.getReadyTickets()).tickets).toEqual([c]);
  });

  it("delegates PR inspection without reading Linear", async () => {
    const linear = { getTickets: vi.fn() };
    const result = await new WorkflowService(linear, github).getPullRequestStatus(4);
    expect(github.getPullRequestStatus).toHaveBeenCalledWith(4);
    expect(result.state).toBe("MERGED");
    expect(linear.getTickets).not.toHaveBeenCalled();
  });

  it("reports external blockers instead of dropping them", async () => {
    const service = new WorkflowService({ getTickets: async () => [b] }, github);
    await expect(service.getProjectGraph()).rejects.toThrow("Unknown dependency ID A");
    await expect(service.getReadyTickets()).rejects.toThrow("Unknown dependency ID A");
  });

  it("preserves scheduler cycle rejection and provider failures", async () => {
    const cyclic = new WorkflowService({ getTickets: async () => [{ ...a, blockedBy: ["A"] }] }, github);
    await expect(cyclic.getExecutionWaves()).rejects.toThrow("cyclic");
    const unavailable = new WorkflowService({ getTickets: async () => { throw new Error("unavailable"); } }, github);
    await expect(unavailable.getProjectGraph()).rejects.toThrow("unavailable");
  });
});

describe("environment configuration", () => {
  it("checks configuration only when the relevant capability is requested", async () => {
    const service = workflowFromEnvironment({});
    await expect(service.getProjectGraph()).rejects.toThrow("LINEAR_API_KEY");
    expect(() => service.getPullRequestStatus(4)).toThrow("GITHUB_REPOSITORY");
    await expect(workflowFromEnvironment({ LINEAR_API_KEY: "test" }).getProjectGraph()).rejects.toThrow("LINEAR_PROJECT_ID");
  });

  it("validates required values and repository syntax", () => {
    expect(() => requiredEnvironment("X", { X: "  " })).toThrow("Missing");
    expect(githubRepository({ GITHUB_REPOSITORY: "owner/repo" })).toBe("owner/repo");
    expect(() => githubRepository({ GITHUB_REPOSITORY: "--malformed" })).toThrow("owner/repository");
  });
});
