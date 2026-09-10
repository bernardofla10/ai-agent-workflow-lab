import { describe, expect, it, vi } from "vitest";
import { LinearTicketProvider, mapLinearStatus, normalizeLinearIssue,
  type LinearIssue, type LinearSource } from "../src/integrations/linear/ticket-provider.js";

const page = <T>(nodes: T[], endCursor?: string) => ({
  nodes, pageInfo: { hasNextPage: Boolean(endCursor), endCursor },
});
const relation = (id: string, type = "blocks") => ({
  type, issue: Promise.resolve({ identifier: id }),
});
const issue = (id: string, type = "backlog"): LinearIssue => ({
  identifier: id, title: `Title ${id}`, state: Promise.resolve({ name: type, type }),
  inverseRelations: vi.fn().mockResolvedValue(page([])),
});

describe("Linear normalization", () => {
  it.each([
    ["triage", "Triage", "backlog"], ["backlog", "Backlog", "backlog"],
    ["unstarted", "Todo", "backlog"], ["started", "Developing", "in_progress"],
    ["started", "In Review", "in_review"], ["started", "Code review", "in_review"],
    ["completed", "Done", "done"], ["canceled", "Canceled", "failed"],
    ["duplicate", "Duplicate", "failed"], ["completed", "Review", "done"],
  ])("maps %s / %s to %s", (type, name, expected) => {
    expect(mapLinearStatus({ name, type })).toBe(expected);
  });

  it("rejects unknown workflow types instead of making work executable", () => {
    expect(() => mapLinearStatus({ name: "Mystery", type: "new-type" })).toThrow("Unsupported");
  });

  it("uses identifiers and incoming blocks, including resolved blockers; paginates and deduplicates", async () => {
    const target = issue("B");
    target.inverseRelations = vi.fn()
      .mockResolvedValueOnce(page([relation("Z"), relation("C", "related")], "next"))
      .mockResolvedValueOnce(page([relation("A"), relation("Z"), relation("D", "duplicate")]));
    expect(await normalizeLinearIssue(target)).toEqual({
      id: "B", title: "Title B", status: "backlog", blockedBy: ["A", "Z"],
    });
    expect(target.inverseRelations).toHaveBeenNthCalledWith(2, {
      first: 100, after: "next", includeArchived: false,
    });
  });

  it("keeps completed archived prerequisites and prevents scheduling other archived work", async () => {
    expect((await normalizeLinearIssue({ ...issue("A", "completed"), archivedAt: new Date() })).status).toBe("done");
    expect((await normalizeLinearIssue({ ...issue("B"), archivedAt: new Date() })).status).toBe("failed");
  });

  it("rejects missing states and inaccessible blocking issues", async () => {
    await expect(normalizeLinearIssue({ ...issue("A"), state: undefined })).rejects.toThrow("Missing Linear workflow state");
    await expect(normalizeLinearIssue({ ...issue("B"), inverseRelations: async () =>
      page([{ type: "blocks", issue: undefined }]) })).rejects.toThrow("Missing blocking issue");
  });
});

describe("Linear ticket provider", () => {
  it("fetches every project page, including completed prerequisites", async () => {
    const a = issue("A", "completed");
    const b = issue("B");
    b.inverseRelations = async () => page([relation("A")]);
    const issues = vi.fn().mockResolvedValueOnce(page([b], "second"))
      .mockResolvedValueOnce(page([a]));
    const client: LinearSource = { project: vi.fn().mockResolvedValue({ issues }) };
    const tickets = await new LinearTicketProvider(client, "configured-project").getTickets();
    expect(client.project).toHaveBeenCalledWith("configured-project");
    expect(issues).toHaveBeenNthCalledWith(2, { first: 100, after: "second", includeArchived: true });
    expect(tickets).toEqual([
      { id: "A", title: "Title A", status: "done", blockedBy: [] },
      { id: "B", title: "Title B", status: "backlog", blockedBy: ["A"] },
    ]);
  });

  it.each([null, "same"])("rejects broken pagination cursor %s", async (cursor) => {
    const client: LinearSource = { project: async () => ({ issues: async () => ({
      nodes: [], pageInfo: { hasNextPage: true, endCursor: cursor },
    }) }) };
    await expect(new LinearTicketProvider(client, "project").getTickets()).rejects.toThrow("pagination cursor");
  });

  it("redacts SDK errors rather than exposing request credentials", async () => {
    const client: LinearSource = { project: async () => { throw new Error("Authorization: fake-secret"); } };
    await expect(new LinearTicketProvider(client, "project").getTickets()).rejects.toThrow("Unable to read Linear data");
  });
});
