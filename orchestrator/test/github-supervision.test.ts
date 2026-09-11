import { describe, expect, it, vi } from "vitest";
import { classifyCI, discoveryQuery, GitHubSupervisionAdapter, inspectionQuery, requiredWorkflowChecks } from "../src/integrations/github/supervision-adapter.js";

function snapshot() {
  const oid = "a".repeat(40);
  const checks = requiredWorkflowChecks.map((name) => ({ __typename: "CheckRun", name,
    status: "COMPLETED", conclusion: "SUCCESS" as string | null, isRequired: false,
    checkSuite: { commit: { oid }, app: { slug: "github-actions", databaseId: 1 } } }));
  const pr = { id: "node-42", number: 42, headRefName: "feat/test-1-task", baseRefName: "main", headRefOid: oid,
    state: "OPEN", mergedAt: null, mergedBy: null,
    repository: { nameWithOwner: "test/repo" }, headRepository: { nameWithOwner: "test/repo" },
    baseRef: { branchProtectionRule: { requiredStatusCheckContexts: [] as string[],
      requiredStatusChecks: [] as { context: string; app: { databaseId: number } | null }[] },
      rules: { pageInfo: { hasNextPage: false }, nodes: [] as {
        type: string; repositoryRuleset: { enforcement: string }; parameters: { requiredStatusChecks: { context: string; integrationId: number | null }[] };
      }[] } },
    commits: { nodes: [{ commit: { oid, statusCheckRollup: {
      contexts: { pageInfo: { hasNextPage: false }, nodes: checks },
    } } }] },
  };
  return { pr, checks, head: pr.commits.nodes[0]!.commit };
}

describe("GitHub current-head CI classification", () => {
  it("requires both actual repository CI jobs even without protection", () => {
    const { pr, checks } = snapshot();
    expect(classifyCI(pr)).toBe("success");
    checks.pop();
    expect(classifyCI(pr)).toBe("pending");
    checks.length = 0;
    expect(classifyCI(pr)).toBe("pending");
  });

  it.each(["QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "UNKNOWN"])("treats check status %s as pending", (status) => {
    const { pr, checks } = snapshot(); checks[0]!.status = status;
    expect(classifyCI(pr)).toBe("pending");
  });

  it.each(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"])("classifies %s as failure", (conclusion) => {
    const { pr, checks } = snapshot(); checks[0]!.conclusion = conclusion;
    expect(classifyCI(pr)).toBe("failure");
  });

  it.each([null, "UNKNOWN"])("does not approve unknown conclusion %s", (conclusion) => {
    const { pr, checks } = snapshot(); checks[0]!.conclusion = conclusion;
    expect(classifyCI(pr)).toBe("pending");
  });

  it.each(["SUCCESS", "NEUTRAL", "SKIPPED"])("accepts GitHub passing conclusion %s", (conclusion) => {
    const { pr, checks } = snapshot(); checks[0]!.conclusion = conclusion;
    expect(classifyCI(pr)).toBe("success");
  });

  it("refuses previous-head rollups and individual stale check evidence", () => {
    const { pr, head, checks } = snapshot();
    head.oid = "b".repeat(40);
    expect(classifyCI(pr)).toBe("pending");
    head.oid = pr.headRefOid;
    checks[0]!.checkSuite.commit.oid = "b".repeat(40);
    expect(classifyCI(pr)).toBe("pending");
  });

  it("does not accept a status or another app impersonating a baseline workflow", () => {
    const { pr, checks } = snapshot(); checks[0]!.checkSuite.app.slug = "untrusted-app";
    expect(classifyCI(pr)).toBe("pending");
  });

  it("waits for missing protected checks and verifies GitHub's required app binding", () => {
    const { pr, checks } = snapshot();
    pr.baseRef.branchProtectionRule.requiredStatusCheckContexts.push("Security");
    expect(classifyCI(pr)).toBe("pending");
    checks.push({ ...checks[0]!, name: "Security" });
    expect(classifyCI(pr)).toBe("pending");
    checks[2]!.isRequired = true;
    expect(classifyCI(pr)).toBe("success");
  });

  it("also observes active ruleset requirements", () => {
    const { pr } = snapshot();
    pr.baseRef.rules.nodes.push({ type: "REQUIRED_STATUS_CHECKS", repositoryRuleset: { enforcement: "ACTIVE" },
      parameters: { requiredStatusChecks: [{ context: "Security", integrationId: null }] } });
    expect(classifyCI(pr)).toBe("pending");
    pr.baseRef.rules.nodes[0]!.repositoryRuleset.enforcement = "EVALUATE";
    expect(classifyCI(pr)).toBe("success");
  });

  it("does not let one required app mask another required app using the same check name", () => {
    const { pr, checks } = snapshot();
    pr.baseRef.branchProtectionRule.requiredStatusChecks.push({ context: "Security", app: { databaseId: 10 } });
    pr.baseRef.rules.nodes.push({ type: "REQUIRED_STATUS_CHECKS", repositoryRuleset: { enforcement: "ACTIVE" },
      parameters: { requiredStatusChecks: [{ context: "Security", integrationId: 20 }] } });
    checks.push({ ...checks[0]!, name: "Security", isRequired: true,
      checkSuite: { commit: { oid: pr.headRefOid }, app: { slug: "first-app", databaseId: 10 } } });
    expect(classifyCI(pr)).toBe("pending");
    checks.push({ ...checks[0]!, name: "Security", isRequired: true,
      checkSuite: { commit: { oid: pr.headRefOid }, app: { slug: "second-app", databaseId: 20 } } });
    expect(classifyCI(pr)).toBe("success");
  });

  it("reports a current check failure even while another required check is missing", () => {
    const { pr, checks } = snapshot();
    checks[0]!.conclusion = "FAILURE";
    checks.pop();
    expect(classifyCI(pr)).toBe("failure");
  });

  it.each(["policy", "checks"])("fails closed on truncated %s", (part) => {
    const { pr, head } = snapshot();
    if (part === "policy") pr.baseRef.rules.pageInfo.hasNextPage = true;
    else head.statusCheckRollup.contexts.pageInfo.hasNextPage = true;
    expect(() => classifyCI(pr)).toThrow("Incomplete GitHub");
  });

  it.each(["SUCCESS", "PENDING", "ERROR", "FAILURE"])("classifies legacy status context %s", (state) => {
    const { pr, head } = snapshot();
    const raw = structuredClone(pr) as unknown as { commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: unknown[] } } } }[] } };
    raw.commits.nodes[0]!.commit.statusCheckRollup.contexts.nodes.push({ __typename: "StatusContext",
      context: "Legacy CI", state, isRequired: true, commit: { oid: head.oid } });
    expect(classifyCI(raw)).toBe(state === "SUCCESS" ? "success" : state === "PENDING" ? "pending" : "failure");
  });

  it("does not trust malformed or absent GitHub evidence", () => {
    expect(() => classifyCI({})).toThrow();
    const { pr, head } = snapshot();
    expect(classifyCI({ ...pr, commits: { nodes: [{ commit: { ...head, statusCheckRollup: null } }] } })).toBe("pending");
    expect(() => classifyCI({ ...pr, baseRef: null })).toThrow();
  });
});

describe("GitHub supervision reads", () => {
  it("discovers exact assignment branch via read-only GraphQL and inspects the discovered node", async () => {
    const { pr } = snapshot();
    const read = vi.fn().mockResolvedValueOnce({ repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [pr] } } })
      .mockResolvedValueOnce({ node: pr });
    const github = new GitHubSupervisionAdapter("test/repo", read);
    const [identity] = await github.discover(pr.headRefName);
    expect(identity).toEqual({ id: pr.id, number: pr.number });
    expect(await github.inspect(identity!)).toMatchObject({ number: 42, headCommit: pr.headRefOid, ci: "success" });
    expect(read.mock.calls).toEqual([
      [discoveryQuery, { owner: "test", repo: "repo", branch: pr.headRefName }], [inspectionQuery, { id: pr.id }],
    ]);
    expect(discoveryQuery).not.toContain("mutation");
    expect(inspectionQuery).not.toContain("mutation");
  });

  it.each(["multiple", "truncated", "base", "branch", "fork"])("rejects %s discovery", async (mode) => {
    const { pr } = snapshot();
    if (mode === "base") pr.baseRefName = "develop";
    if (mode === "branch") pr.headRefName = "feat/wrong";
    if (mode === "fork") pr.headRepository.nameWithOwner = "fork/repo";
    const read = vi.fn().mockResolvedValue({ repository: { pullRequests: {
      pageInfo: { hasNextPage: mode === "truncated" }, nodes: mode === "multiple" ? [pr, pr] : [pr],
    } } });
    await expect(new GitHubSupervisionAdapter("test/repo", read).discover("feat/test-1-task")).rejects.toThrow();
  });

  it("returns no matches without fabricating a PR", async () => {
    const read = vi.fn().mockResolvedValue({ repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] } } });
    expect(await new GitHubSupervisionAdapter("test/repo", read).discover("feat/test-1-task")).toEqual([]);
  });

  it("rejects changed PR identity", async () => {
    const { pr } = snapshot();
    await expect(new GitHubSupervisionAdapter("test/repo", async () => ({ node: { ...pr, number: 77 } }))
      .inspect({ id: pr.id, number: pr.number })).rejects.toThrow("identity");
  });
});
