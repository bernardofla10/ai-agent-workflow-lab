import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const checkRunSchema = z.object({
  __typename: z.literal("CheckRun"),
  name: z.string(), status: z.string(), conclusion: z.string().nullable(),
  detailsUrl: z.string(),
});
const statusContextSchema = z.object({
  __typename: z.literal("StatusContext"),
  context: z.string(), state: z.string(), targetUrl: z.string().nullable(),
});
const githubPullRequestSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  headRefName: z.string(), baseRefName: z.string(),
  statusCheckRollup: z.array(z.discriminatedUnion("__typename", [
    checkRunSchema, statusContextSchema,
  ])).nullable(),
});

export const pullRequestStatusSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  headBranch: z.string(), baseBranch: z.string(),
  checks: z.array(z.object({
    kind: z.enum(["CheckRun", "StatusContext"]), name: z.string(),
    status: z.string(), conclusion: z.string().nullable(), url: z.string().nullable(),
  })),
  ciResult: z.enum(["success", "failure", "pending", "none", "unknown"]),
});
export type PullRequestStatus = z.infer<typeof pullRequestStatusSchema>;

export interface PullRequestProvider {
  getPullRequestStatus(number: number): Promise<PullRequestStatus>;
}

export function normalizePullRequest(value: unknown): PullRequestStatus {
  const pr = githubPullRequestSchema.parse(value);
  const checks = (pr.statusCheckRollup ?? []).map((check) =>
    check.__typename === "CheckRun"
      ? { kind: check.__typename, name: check.name, status: check.status,
        conclusion: check.conclusion, url: check.detailsUrl }
      : { kind: check.__typename, name: check.context, status: check.state,
        conclusion: null, url: check.targetUrl });
  const results = checks.map((check) => {
    const outcome = check.kind === "CheckRun" ? check.conclusion : check.status;
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(outcome ?? "")) return "failure";
    if (["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED", "EXPECTED"].includes(check.status)) return "pending";
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(outcome ?? "")) return "success";
    return "unknown";
  });
  const ciResult = results.length === 0 ? "none"
    : results.includes("failure") ? "failure"
    : results.includes("pending") ? "pending"
    : results.includes("unknown") ? "unknown" : "success";
  return { number: pr.number, state: pr.state, headBranch: pr.headRefName,
    baseBranch: pr.baseRefName, checks, ciResult };
}

type Runner = (file: string, args: string[]) => Promise<{ stdout: string }>;
const execute = promisify(execFile);
const runGh: Runner = (file, args) => execute(file, args, {
  encoding: "utf8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024,
  env: { ...process.env, GH_PROMPT_DISABLED: "1" },
});

export class GitHubAdapter implements PullRequestProvider {
  constructor(private readonly repository: string, private readonly run: Runner = runGh) {}

  async getPullRequestStatus(number: number): Promise<PullRequestStatus> {
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error("PR number must be a positive safe integer");
    let stdout: string;
    try {
      ({ stdout } = await this.run("gh", ["pr", "view", String(number),
        "--repo", this.repository, "--json", "number,state,headRefName,baseRefName,statusCheckRollup"]));
    } catch {
      throw new Error("Unable to read GitHub PR; check gh authentication, repository access and PR number");
    }
    const result = normalizePullRequest(JSON.parse(stdout));
    if (result.number !== number) throw new Error("GitHub returned an unexpected PR number");
    return result;
  }
}
