import { describe, expect, it, vi } from "vitest";
import { GitHubAdapter, normalizePullRequest } from "../src/integrations/github/pull-request-adapter.js";

const pr = (checks: unknown = []) => ({
  number: 4, state: "MERGED", headRefName: "feature", baseRefName: "main", statusCheckRollup: checks,
});
const run = (conclusion: string | null = "SUCCESS", status = "COMPLETED") => ({
  __typename: "CheckRun", name: "CI", status, conclusion, detailsUrl: "https://example.test/check",
});
const context = (state = "SUCCESS") => ({
  __typename: "StatusContext", context: "external", state, targetUrl: null,
});

describe("GitHub normalization", () => {
  it("normalizes merged PR branches, check runs and commit status contexts", () => {
    expect(normalizePullRequest(pr([run(), context()]))).toEqual({
      number: 4, state: "MERGED", headBranch: "feature", baseBranch: "main", ciResult: "success",
      checks: [
        { kind: "CheckRun", name: "CI", status: "COMPLETED", conclusion: "SUCCESS", url: "https://example.test/check" },
        { kind: "StatusContext", name: "external", status: "SUCCESS", conclusion: null, url: null },
      ],
    });
  });

  it.each([
    [[], "none"], [null, "none"], [[run("FAILURE"), run(null, "QUEUED")], "failure"],
    [[run(null, "IN_PROGRESS")], "pending"], [[context("PENDING")], "pending"],
    [[context("ERROR")], "failure"], [[run("CANCELLED")], "failure"],
    [[run("SKIPPED"), run("NEUTRAL")], "success"], [[run(null)], "unknown"],
    [[run("FUTURE_CONCLUSION")], "unknown"],
  ])("summarizes checks %j as %s", (checks, expected) => {
    expect(normalizePullRequest(pr(checks)).ciResult).toBe(expected);
  });

  it("rejects incomplete PRs and unknown check shapes", () => {
    expect(() => normalizePullRequest({ number: 4 })).toThrow();
    expect(() => normalizePullRequest(pr([{ __typename: "OtherCheck" }]))).toThrow();
  });
});

describe("GitHub gh adapter", () => {
  it("uses explicit repository and JSON arguments without a shell", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: JSON.stringify(pr()) });
    const result = await new GitHubAdapter("owner/repo", runner).getPullRequestStatus(4);
    expect(result.state).toBe("MERGED");
    expect(runner).toHaveBeenCalledWith("gh", ["pr", "view", "4", "--repo", "owner/repo", "--json",
      "number,state,headRefName,baseRefName,statusCheckRollup"]);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid PR number %s before invoking gh", async (number) => {
    const runner = vi.fn();
    await expect(new GitHubAdapter("owner/repo", runner).getPullRequestStatus(number)).rejects.toThrow("positive safe integer");
    expect(runner).not.toHaveBeenCalled();
  });

  it("reports gh failure without exposing raw stderr", async () => {
    const runner = vi.fn().mockRejectedValue(new Error("private diagnostic"));
    await expect(new GitHubAdapter("owner/repo", runner).getPullRequestStatus(4)).rejects.toThrow("Unable to read GitHub PR");
  });

  it("rejects invalid JSON and a mismatched PR number", async () => {
    const runner = vi.fn().mockResolvedValueOnce({ stdout: "not JSON" })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ ...pr(), number: 5 }) });
    const adapter = new GitHubAdapter("owner/repo", runner);
    await expect(adapter.getPullRequestStatus(4)).rejects.toThrow();
    await expect(adapter.getPullRequestStatus(4)).rejects.toThrow("unexpected PR number");
  });
});
